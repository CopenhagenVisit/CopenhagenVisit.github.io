// --- Configuration ---
const WEATHERAPI_COM_KEY = "c44f7b2f35464bd480e230517240203"; // Your WeatherAPI.com Key
const COPENHAGEN_LAT = 55.6761;
const COPENHAGEN_LON = 12.5683;
const TRIP_DATES = ["2025-04-16", "2025-04-17", "2025-04-18"];
const HASH_PREFIX = "#boardState=";
const INDEX_PAD_LENGTH = 2; // Use 2 digits for item index (00-99)
const WEATHER_CACHE_KEY = 'copenhagenWeatherCache'; // Key for localStorage
const CACHE_EXPIRY_MS = 60 * 60 * 1000; // 1 hour in milliseconds

// --- Globals ---
let allPlacesData = [];
let placeIdToIndexMap = {}; // Map place.id -> index in allPlacesData
let cardElements = {}; // Store created card DOM elements by ID
const boardElement = document.getElementById('board');
const toggleButton = document.getElementById('toggle-unassigned-btn');
let isUnassignedVisible = false;
const COLUMN_IDS_ORDER = ['unassigned', ...TRIP_DATES]; // Fixed order for saving/loading
let flashTimeout = null; // Timeout ID for the URL flash effect

// --- Emoji Mapping & Category Class ---
const categoryEmojis = { 'Sightseeing': '🗺️', 'Curios': '👾', 'Art': '🎨', 'Activities': '🚴‍♀️', 'Chill': '🌳', 'Concert Venues': '🎸', 'Drinkplaces': '🍺', 'Touristy': '📸', 'Eat': '🍔', 'Default': '📍' };
function getEmojiForCategory(category) { return categoryEmojis[category] || categoryEmojis['Default']; }
function getCategoryClass(category) { return `category-${(category || 'Uncategorized').replace(/\s+/g, '')}`; }

// --- CSV Parsing ---
function parseCSV(csvText) {
    const lines = csvText.trim().split('\n'); if (lines.length < 2) return [];
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase()); const data = [];
    for (let i = 1; i < lines.length; i++) {
        const values = []; let currentLine = lines[i]; let inQuotes = false; let currentValue = '';
        for (let j = 0; j < currentLine.length; j++) {
        const char = currentLine[j];
        if (char === '"') { if (inQuotes && currentLine[j + 1] === '"') { currentValue += '"'; j++; } else { inQuotes = !inQuotes; } }
        else if (char === ',' && !inQuotes) { values.push(currentValue.trim()); currentValue = ''; }
        else { currentValue += char; }
        }
        values.push(currentValue.trim());
        if (values.length === headers.length) {
        const entry = {}; headers.forEach((header, index) => {
            let val = values[index]; if (val.startsWith('"') && val.endsWith('"')) { val = val.substring(1, val.length - 1); }
            entry[header] = val.replace(/""/g, '"');
        }); data.push(entry);
        } else { console.warn(`Skipping malformed CSV line ${i + 1}`); }
    } return data;
}

// --- Load Data from CSV ---
async function loadPlacesFromCSV(url) {
    try {
        const response = await fetch(url); if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
        const csvText = await response.text(); const parsedData = parseCSV(csvText);
        // Assign index during mapping
        return parsedData.map((item, index) => ({
            id: (item.name || `item-${index}`).replace(/[^a-zA-Z0-9-_]/g, '-').toLowerCase(),
            name: item.name || 'Unnamed Place', category: item.category || 'Uncategorized',
            description: item.description || '', emoji: getEmojiForCategory(item.category),
            categoryClass: getCategoryClass(item.category), originalIndex: index // Store the original index
        }));
    } catch (error) {
        console.error("Error loading/parsing CSV:", error);
        if (boardElement) { // Check if boardElement exists before modifying
             boardElement.innerHTML = `<div class="error-state"><i class="fas fa-exclamation-triangle"></i> Failed to load recommendations. Check CSV file.</div>`;
        }
        throw error; // Re-throw to stop initialization if critical
    }
}

// --- Fetch Weather Data (Using WeatherAPI.com with Caching) ---
async function fetchWeatherData() {
    // 1. Try loading from cache first
    try {
        const cachedDataJSON = localStorage.getItem(WEATHER_CACHE_KEY);
        if (cachedDataJSON) {
            const cachedData = JSON.parse(cachedDataJSON);
            const cacheAge = Date.now() - cachedData.timestamp;
            if (cacheAge < CACHE_EXPIRY_MS) {
                console.log("Using cached weather data.");
                return cachedData.data; // Return cached data if fresh
            } else {
                console.log("Weather cache expired.");
            }
        }
    } catch (e) {
        console.error("Error reading weather cache:", e);
        localStorage.removeItem(WEATHER_CACHE_KEY); // Clear potentially corrupted cache
    }

    // 2. If cache is invalid or missing, fetch from API
    console.log("Fetching new weather data...");
    if (!WEATHERAPI_COM_KEY || WEATHERAPI_COM_KEY === "YOUR_WEATHERAPI_COM_KEY") { // Check for placeholder
        console.warn("WeatherAPI.com key not set.");
        updateWeatherDisplay(null, 'no-key'); // Pass specific status
        return null;
    }

    const today = new Date();
    const lastTripDate = new Date(TRIP_DATES[TRIP_DATES.length - 1] + 'T00:00:00');
    const diffTime = Math.abs(lastTripDate - today);
    const daysNeeded = Math.ceil(diffTime / (1000 * 60 * 60 * 24)) + 1;
    const forecastDays = Math.min(daysNeeded, 10); // Limit to API max

    const url = `https://api.weatherapi.com/v1/forecast.json?key=${WEATHERAPI_COM_KEY}&q=${COPENHAGEN_LAT},${COPENHAGEN_LON}&days=${forecastDays}&aqi=no&alerts=no`;

    try {
        const response = await fetch(url);
        if (!response.ok) {
            const errorData = await response.json();
            if (response.status === 401 || response.status === 403) {
                 throw new Error(`WeatherAPI Auth Error (${response.status}): ${errorData.error.message}. Check your API key.`);
            } else {
                 throw new Error(`WeatherAPI Error (${response.status}): ${errorData.error.message}`);
            }
        }
        const data = await response.json();

        // Process the response
        const dailyWeather = {};
        if (data.forecast && data.forecast.forecastday) {
            data.forecast.forecastday.forEach(day => {
                const dateStr = day.date;
                // Only store data for dates we actually care about in the cache
                if (TRIP_DATES.includes(dateStr)) {
                    dailyWeather[dateStr] = {
                        temp: Math.round(day.day.avgtemp_c),
                        description: day.day.condition.text,
                        icon: day.day.condition.icon.split('/').pop()
                    };
                }
            });
        } else {
            console.warn("WeatherAPI response format unexpected:", data);
            return null; // Don't cache unexpected format
        }

        // 3. Save successful fetch to cache
        try {
            const cachePayload = { data: dailyWeather, timestamp: Date.now() };
            localStorage.setItem(WEATHER_CACHE_KEY, JSON.stringify(cachePayload));
            console.log("Weather data cached.");
        } catch (e) { console.error("Error saving weather data to cache:", e); }

        return dailyWeather; // Return the newly fetched data

    } catch (error) {
        console.error("Error fetching WeatherAPI.com data:", error);
        updateWeatherDisplay(null, 'error', error.message); // Pass error status and message
        return null; // Indicate failure
    }
}

// --- Render UI Elements ---
function createColumnElement(id, title) {
    const column = document.createElement('div'); column.className = 'board-column'; column.id = `column-${id}`;
    column.innerHTML = `<div class="column-header"><span class="column-title">${title}</span><div class="weather-info" id="weather-${id}"><span class="loading-state"><div class="spinner"></div></span></div></div><div class="column-list" id="list-${id}"></div>`;
    return column;
}
function createCardElement(place) {
    const card = document.createElement('div'); card.className = `recommendation-card ${place.categoryClass}`; card.dataset.id = place.id;
    card.innerHTML = `<div><div class="card-header"><span class="card-emoji">${place.emoji}</span><span class="card-name">${place.name}</span></div>${place.description ? `<p class="card-description">${place.description}</p>` : ''}</div>`;
    return card;
}

// --- Update Weather Display ---
function updateWeatherDisplay(weatherData, status = 'ok', errorMessage = 'Weather unavailable') {
    COLUMN_IDS_ORDER.forEach(id => {
        const weatherEl = document.getElementById(`weather-${id}`);
        if (!weatherEl || id === 'unassigned') return; // Skip unassigned or if element not found

        let weatherHtml = '';
        const dayWeather = weatherData ? weatherData[id] : null;

        if (status === 'ok' && dayWeather) {
             const iconUrl = `https://cdn.weatherapi.com/weather/64x64/day/${dayWeather.icon}`;
             weatherHtml = `
                <img src="${iconUrl}" alt="${dayWeather.description}" title="${dayWeather.description}">
                <span>${dayWeather.temp}°C</span>
            `;
        } else if (status === 'no-key') {
            weatherHtml = `<i class="fas fa-key" title="API Key needed for weather"></i>`;
        } else if (status === 'error') {
             weatherHtml = `<i class="fas fa-exclamation-circle" title="${errorMessage}"></i>`;
        } else { // No data for this specific day, but fetch was otherwise ok (or cached)
             weatherHtml = '<span>-</span>';
        }
        weatherEl.innerHTML = weatherHtml;
    });
}

// --- URL Hash State Persistence ---
function saveBoardStateToURL() {
    let stateString = "";
    COLUMN_IDS_ORDER.forEach(columnId => {
        const listElement = document.getElementById(`list-${columnId}`);
        stateString += "&";
        if (listElement) {
            const itemIds = Array.from(listElement.querySelectorAll('.recommendation-card'))
                                 .map(card => card.dataset.id);
            itemIds.forEach(id => {
                const index = placeIdToIndexMap[id];
                if (index !== undefined) {
                    stateString += String(index).padStart(INDEX_PAD_LENGTH, '0');
                } else { console.warn(`No index for card ID: ${id}`); }
            });
        }
    });

    try {
        const encodedState = btoa(stateString);
        // Only update if the new hash is different from the current one
        const newHash = HASH_PREFIX + encodedState;
        if (window.location.hash !== newHash) {
            history.replaceState(null, '', newHash);
            updateShareBarURL(); // Update the displayed URL
            triggerShareUrlFlash(); // Trigger the flash effect
            // console.log("Board state saved to URL:", stateString);
        }
    } catch (e) { console.error("Failed to encode or set URL hash:", e); }
}

function loadBoardStateFromURL() {
    if (!window.location.hash || !window.location.hash.startsWith(HASH_PREFIX)) { return null; }
    try {
        const encodedState = window.location.hash.substring(HASH_PREFIX.length);
        const decodedState = atob(encodedState);
        const parts = decodedState.split('&').slice(1);
        if (parts.length !== COLUMN_IDS_ORDER.length) { console.error(`URL state parts mismatch. Expected ${COLUMN_IDS_ORDER.length}, got ${parts.length}`); return null; }
        const loadedState = {};
        parts.forEach((part, columnIndex) => {
            const columnId = COLUMN_IDS_ORDER[columnIndex];
            const listId = `list-${columnId}`;
            loadedState[listId] = [];
            for (let i = 0; i < part.length; i += INDEX_PAD_LENGTH) {
                const indexStr = part.substring(i, i + INDEX_PAD_LENGTH);
                const index = parseInt(indexStr, 10);
                // Check against allPlacesData which should be loaded by now
                if (!isNaN(index) && allPlacesData && index >= 0 && index < allPlacesData.length) {
                    loadedState[listId].push(allPlacesData[index].id);
                } else { console.warn(`Invalid index ${indexStr} in URL state for column ${columnId}`); }
            }
        });
        return loadedState;
    } catch (e) { console.error("Failed to load/parse URL hash state:", e); return null; }
}

// --- Initialize SortableJS ---
function initializeDragAndDrop() {
    const lists = document.querySelectorAll('.column-list');
    lists.forEach(list => {
        new Sortable(list, {
            group: 'shared',
            animation: 150,
            ghostClass: 'sortable-ghost',
            dragClass: 'sortable-drag',
            onEnd: saveBoardStateToURL // Save state to URL on drop
        });
    });
}

// --- Toggle Unassigned Column ---
function toggleUnassigned() {
    const unassignedCol = document.getElementById('column-unassigned');
    if (unassignedCol) {
        isUnassignedVisible = !isUnassignedVisible;
        unassignedCol.classList.toggle('hidden', !isUnassignedVisible);
        const buttonTextSpan = toggleButton.querySelector('span');
        const buttonIcon = toggleButton.querySelector('i');
        if (isUnassignedVisible) {
            buttonTextSpan.textContent = "Hide Mattia's Tips";
            buttonIcon.className = 'fas fa-eye-slash';
        } else {
            buttonTextSpan.textContent = "Show Mattia's Tips";
            buttonIcon.className = 'fas fa-lightbulb';
        }
        boardElement.classList.toggle('columns-3', !isUnassignedVisible);
        boardElement.classList.toggle('columns-4', isUnassignedVisible);
    }
}

// --- Populate Board from State or Default ---
function populateBoard(initialState) {
    const allItemIds = new Set(allPlacesData.map(p => p.id));
    const placedItemIds = new Set();
    if (initialState) {
        Object.entries(initialState).forEach(([listId, itemIds]) => {
            const listElement = document.getElementById(listId);
            if (listElement) {
                itemIds.forEach(itemId => {
                    if (cardElements[itemId]) {
                        listElement.appendChild(cardElements[itemId]);
                        placedItemIds.add(itemId);
                    } else { console.warn(`Card ID ${itemId} not found.`); }
                });
            } else { console.warn(`List ID ${listId} not found.`); }
        });
    }
    const unassignedList = document.getElementById('list-unassigned');
    if (unassignedList) {
        allItemIds.forEach(itemId => {
            if (!placedItemIds.has(itemId) && cardElements[itemId]) {
                unassignedList.appendChild(cardElements[itemId]);
            }
        });
    } else { console.error("Unassigned list not found."); }
}

// --- Update Share Bar ---
function updateShareBarURL() {
    const shareUrlInput = document.getElementById('share-url-input');
    if (shareUrlInput) {
        shareUrlInput.value = window.location.href;
    }
}

// --- Trigger URL Input Flash Animation ---
function triggerShareUrlFlash() {
    const shareUrlInput = document.getElementById('share-url-input');
    if (shareUrlInput) {
        // Clear existing timeout if flashing rapidly
        if (flashTimeout) clearTimeout(flashTimeout);

        shareUrlInput.classList.add('url-updated');
        flashTimeout = setTimeout(() => {
            shareUrlInput.classList.remove('url-updated');
            flashTimeout = null;
        }, 600); // Duration of the flash (slightly longer than transition)
    }
}

// --- Main Initialization ---
async function initializeApp() {
  // Ensure DOM elements exist before proceeding
  if (!boardElement || !toggleButton) {
      console.error("Essential DOM elements not found. Aborting initialization.");
      return;
  }

  try {
    // 1. Load data and weather concurrently
    // Use Promise.allSettled to handle potential weather errors gracefully
    const results = await Promise.allSettled([
      loadPlacesFromCSV('copenhagen_places.csv'),
      fetchWeatherData()
    ]);

    // Check if place data loaded successfully
    if (results[0].status === 'rejected') {
        // Error message already shown by loadPlacesFromCSV
        return; // Stop initialization if places failed
    }
    allPlacesData = results[0].value;

    // Get weather data (might be null if failed)
    const weatherData = results[1].status === 'fulfilled' ? results[1].value : null;
    // If weather failed, updateWeatherDisplay was already called with error status inside fetchWeatherData

    // Create map for quick ID -> Index lookup
    placeIdToIndexMap = {};
    allPlacesData.forEach((place, index) => { placeIdToIndexMap[place.id] = index; });

    // Clear loading state
    boardElement.innerHTML = '';

    // 2. Create all card elements
    cardElements = {};
    allPlacesData.forEach(place => { cardElements[place.id] = createCardElement(place); });

    // 3. Create Columns
    COLUMN_IDS_ORDER.forEach(id => {
        let title = "Mattia's Tips";
        if (id !== 'unassigned') {
            const dateObj = new Date(id + 'T00:00:00');
            const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
            const monthDay = dateObj.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            title = `${dayName}, ${monthDay}`;
        }
        const column = createColumnElement(id, title);
        if (id === 'unassigned') { column.classList.add('hidden'); }
        boardElement.appendChild(column);
    });
    boardElement.classList.add('columns-3');

    // 4. Update weather display (if data was fetched successfully)
    if (results[1].status === 'fulfilled') {
        updateWeatherDisplay(weatherData, 'ok');
    } // Error state handled within fetchWeatherData

    // 5. Load state from URL or default
    let initialState = loadBoardStateFromURL();
    if (!initialState) {
        initialState = { [`list-unassigned`]: allPlacesData.map(p => p.id) };
        COLUMN_IDS_ORDER.slice(1).forEach(id => initialState[`list-${id}`] = []);
    }
    populateBoard(initialState);

    // Update share bar with initial URL
    updateShareBarURL();

    // 6. Initialize Drag and Drop
    initializeDragAndDrop();

    // 7. Setup Toggle Button Listener & Initial Text
    toggleButton.addEventListener('click', toggleUnassigned);
    toggleButton.querySelector('span').textContent = "Show Mattia's Tips";
    toggleButton.querySelector('i').className = 'fas fa-lightbulb';

    // 8. Setup Copy Button Listener
    const copyUrlBtn = document.getElementById('copy-url-btn');
    const shareUrlInput = document.getElementById('share-url-input');
    const copyConfirm = document.getElementById('copy-confirmation');

    if (copyUrlBtn && shareUrlInput && copyConfirm) { // Check elements exist
        copyUrlBtn.addEventListener('click', async () => {
            try {
                await navigator.clipboard.writeText(shareUrlInput.value);
                copyConfirm.textContent = 'Copied!';
                copyConfirm.classList.add('visible');
                setTimeout(() => { copyConfirm.classList.remove('visible'); }, 2000);
            } catch (err) {
                console.error('Failed to copy URL: ', err);
                copyConfirm.textContent = 'Copy failed';
                copyConfirm.classList.add('visible');
                setTimeout(() => { copyConfirm.classList.remove('visible'); }, 2000);
            }
        });
    } else {
        console.error("Share bar elements not found.");
    }


    // 9. Save initial state to URL if needed (ensures bar is correct on first load)
    if (!window.location.hash.startsWith(HASH_PREFIX)) {
        saveBoardStateToURL(); // This will also call updateShareBarURL and trigger flash
    }

  } catch (error) {
    console.error("Initialization failed:", error);
    // Ensure a user-friendly message if initialization fails badly
    if (boardElement && boardElement.innerHTML.includes('loading-state')) {
         boardElement.innerHTML = `<div class="error-state"><i class="fas fa-exclamation-triangle"></i> Failed to initialize planner. Please refresh.</div>`;
    }
  }
}

// --- Start the app ---
// Use DOMContentLoaded to ensure HTML is parsed, but defer script execution slightly
// to ensure all elements are definitely ready, especially if script is loaded early.
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initializeApp);
} else {
    // DOMContentLoaded has already fired
    initializeApp();
}
