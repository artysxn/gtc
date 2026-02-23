const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const turf = require('@turf/turf');
const fs = require('fs');

// --- Setup ---
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CSP Middleware to allow external CDNs
app.use((req, res, next) => {
    res.setHeader(
        "Content-Security-Policy",
        "default-src 'self'; " +
        "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdn.tailwindcss.com https://unpkg.com https://cdn.jsdelivr.net; " +
        "style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; " +
        "img-src 'self' data: blob: https://*.openstreetmap.org https://*.cartocdn.com https://images.unsplash.com https://unpkg.com; " + // Added cartocdn
        "font-src 'self' https://fonts.gstatic.com; " +
        "connect-src 'self' https://nominatim.openstreetmap.org https://overpass-api.de https://restcountries.com;"
    );
    next();
});

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configure Multer for image uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, req.body.lobbyId + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
    fileFilter: (req, file, cb) => {
        if (file.mimetype.startsWith('image/')) cb(null, true);
        else cb(new Error('Only images are allowed'));
    }
});

// Serve static files
app.use(express.static('public'));
app.use('/uploads', express.static('uploads'));

// Serve main.html on root
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'main.html'));
});

// --- Leaderboard Persistence ---
const LEADERBOARD_FILE = path.join(__dirname, 'leaderboard.json');
let leaderboard = { wins: {}, longest_rounds: [] };

function loadLeaderboard() {
    if (fs.existsSync(LEADERBOARD_FILE)) {
        try {
            leaderboard = JSON.parse(fs.readFileSync(LEADERBOARD_FILE, 'utf8'));
        } catch (e) {
            console.error("Failed to load leaderboard:", e);
        }
    } else {
        saveLeaderboard();
    }
}

function saveLeaderboard() {
    try {
        fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(leaderboard, null, 2));
    } catch (e) {
        console.error("Failed to save leaderboard:", e);
    }
}

loadLeaderboard();

// --- Game State Storage ---
// lobbies[lobbyId] = { players: [], gameState: { ... }, settings: { ... }, hostId: string, password: string }
const lobbies = new Map();

const INITIAL_GAME_STATE = {
    phase: 'LOBBY', // LOBBY, SETUP_LOC, SETUP_IMG, PLAYING, WON
    setterId: null,
    target: { lat: null, lon: null, name: null, countryCode: null, continent: null },
    image: null,
    guesses: [],
    validPolygon: null, // Starts as null, becomes world polygon on first guess
    hints: { hemisphere: false, continent: false, country: false },
    winnerId: null,
    wrongCountries: [] // Array of country codes
};

const DEFAULT_SETTINGS = {
    minPop: 5000,
    hintThresholds: [30, 60, 90], // Guesses needed for hints
    password: null,
    gameMode: 'ffa', // 'ffa' or 'turn_based'
    moveTimeLimit: 0 // Seconds, 0 = off
};

// --- Helper Functions ---

function generateLobbyId() {
    return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function getLobby(lobbyId) {
    return lobbies.get(lobbyId);
}

function broadcastState(lobbyId) {
    const lobby = lobbies.get(lobbyId);
    if (!lobby) return;

    // Sync player roles with current setterId
    lobby.players.forEach(p => {
        p.role = (p.id === lobby.gameState.setterId) ? 'setter' : 'guesser';
    });

    // Sanitize state for guessers (hide target unless WON or they are setter)
    const fullState = lobby.gameState;
    
    // We send different views to different players
    lobby.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.id);
        if (!socket) return;

        const isSetter = player.id === fullState.setterId;
        const isWon = fullState.phase === 'WON';

        const sanitizedState = {
            ...fullState,
            // Hide target details if not setter and not won
            target: (isSetter || isWon) ? fullState.target : { lat: null, lon: null, name: null },
            // Players list for UI
            players: lobby.players,
            myRole: isSetter ? 'setter' : 'guesser',
            settings: lobby.settings,
            isHost: player.id === lobby.hostId,
            turnState: lobby.turnState,
            timeLeft: lobby.turnState.deadline ? Math.max(0, Math.ceil((lobby.turnState.deadline - Date.now()) / 1000)) : null
        };

        socket.emit('game_state_update', sanitizedState);
    });
}

function advanceTurn(lobby) {
    if (lobby.settings.gameMode !== 'turn_based') return;

    const guessers = lobby.players.filter(p => p.role === 'guesser');
    if (guessers.length === 0) {
        lobby.turnState = { currentGuesserId: null, deadline: null };
        return;
    }

    let currentIndex = guessers.findIndex(p => p.id === lobby.turnState.currentGuesserId);
    let nextIndex = (currentIndex + 1) % guessers.length;
    
    // If current is invalid (e.g. left), start from 0
    if (currentIndex === -1) nextIndex = 0;

    lobby.turnState.currentGuesserId = guessers[nextIndex].id;
    
    if (lobby.settings.moveTimeLimit > 0) {
        lobby.turnState.deadline = Date.now() + (lobby.settings.moveTimeLimit * 1000);
    } else {
        lobby.turnState.deadline = null;
    }
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Helper for fetching with timeout
async function fetchWithTimeout(url, options = {}) {
    const { timeout = 8000 } = options;
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(id);
        return response;
    } catch (error) {
        clearTimeout(id);
        throw error;
    }
}

// Helper to simplify geometry and reduce memory usage
function optimizeGeometry(geoJson) {
    if (!geoJson) return null;
    try {
        // Simplify: tolerance 0.01 degrees (~1km), highQuality false for speed
        const simplified = turf.simplify(geoJson, { tolerance: 0.01, highQuality: false, mutate: true });
        // Truncate: limit coordinates to 4 decimal places
        return turf.truncate(simplified, { precision: 4, coordinates: 2, mutate: true });
    } catch (e) {
        console.warn("Geometry optimization failed:", e);
        return geoJson;
    }
}

// --- Routes ---

app.post('/upload', upload.single('image'), (req, res) => {
    const { lobbyId } = req.body;
    const lobby = getLobby(lobbyId);
    
    if (!lobby || !req.file) {
        return res.status(400).json({ error: 'Invalid upload' });
    }

    // Only setter can upload
    if (lobby.gameState.setterId !== req.body.socketId) {
        // Cleanup file if unauthorized
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Not authorized' });
    }

    lobby.gameState.image = '/uploads/' + req.file.filename;
    lobby.gameState.phase = 'PLAYING';
    lobby.lastInteraction = Date.now();
    
    // Initialize polygon if needed
    if (!lobby.gameState.validPolygon) {
        lobby.gameState.validPolygon = turf.polygon([[[-360, 90], [360, 90], [360, -90], [-360, -90], [-360, 90]]]);
    }

    // Initialize turn if turn-based
    if (lobby.settings.gameMode === 'turn_based') {
        advanceTurn(lobby);
    }

    broadcastState(lobbyId);
    res.json({ success: true });
});

// --- Socket.IO Logic ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_lobby', ({ nickname, settings }) => {
        const lobbyId = generateLobbyId();
        
        // Merge settings with defaults
        const finalSettings = { ...DEFAULT_SETTINGS, ...settings };
        // Ensure hintThresholds are numbers
        if (finalSettings.hintThresholds) {
            finalSettings.hintThresholds = finalSettings.hintThresholds.map(Number);
        }
        if (finalSettings.minPop) finalSettings.minPop = Number(finalSettings.minPop);
        if (finalSettings.moveTimeLimit) finalSettings.moveTimeLimit = Number(finalSettings.moveTimeLimit);

        lobbies.set(lobbyId, {
            players: [{ id: socket.id, nickname, role: 'setter', score: 0 }],
            gameState: JSON.parse(JSON.stringify(INITIAL_GAME_STATE)),
            settings: finalSettings,
            hostId: socket.id,
            password: finalSettings.password,
            lastInteraction: Date.now(),
            setterAssignedAt: Date.now(),
            setterWarned: false,
            inactivityStrikes: 0,
            turnState: {
                currentGuesserId: null,
                deadline: null
            }
        });
        
        socket.join(lobbyId);
        socket.emit('lobby_created', { lobbyId });
        
        // Auto-assign setter for fresh lobby
        const lobby = lobbies.get(lobbyId);
        lobby.gameState.setterId = socket.id;
        
        broadcastState(lobbyId);
    });

    socket.on('join_lobby', ({ lobbyId, nickname, password }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby) {
            socket.emit('error', 'Lobby not found');
            return;
        }

        // Check password
        if (lobby.password && lobby.password !== password) {
            socket.emit('error', 'Incorrect password');
            return;
        }

        // Check nickname uniqueness
        if (lobby.players.some(p => p.nickname === nickname)) {
            socket.emit('error', 'Nickname taken');
            return;
        }

        lobby.players.push({ id: socket.id, nickname, role: 'guesser', score: 0 });
        socket.join(lobbyId);
        
        broadcastState(lobbyId);
    });

    socket.on('get_lobbies', () => {
        const publicLobbies = [];
        for (const [id, lobby] of lobbies.entries()) {
            if (!lobby.password) { // Only show public lobbies
                publicLobbies.push({
                    id,
                    host: lobby.players.find(p => p.id === lobby.hostId)?.nickname || 'Unknown',
                    playerCount: lobby.players.length,
                    phase: lobby.gameState.phase
                });
            }
        }
        socket.emit('lobbies_list', publicLobbies);
    });

    socket.on('leave_lobby', ({ lobbyId }) => {
        handleDisconnect(socket, lobbyId);
    });

    socket.on('start_game', ({ lobbyId }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;

        // Only host can start
        if (lobby.hostId !== socket.id) {
            socket.emit('error', 'Only the host can start the game');
            return;
        }

        lobby.lastInteraction = Date.now();

        // Capture the winner (who is now the setter) BEFORE resetting state
        const nextSetterId = lobby.gameState.setterId;

        // Reset state
        lobby.gameState = JSON.parse(JSON.stringify(INITIAL_GAME_STATE));
        lobby.gameState.phase = 'SETUP_LOC';
        lobby.setterAssignedAt = Date.now();
        lobby.setterWarned = false;
        
        // Restore the setter
        if (nextSetterId) {
            lobby.gameState.setterId = nextSetterId;
        } else {
            // Pick random setter if no previous setter (first game)
            const randomPlayer = lobby.players[Math.floor(Math.random() * lobby.players.length)];
            lobby.gameState.setterId = randomPlayer.id;
        }

        broadcastState(lobbyId);
    });

    socket.on('send_chat', ({ lobbyId, message }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;

        lobby.lastInteraction = Date.now();

        const player = lobby.players.find(p => p.id === socket.id);
        if (!player) return;

        const chatMsg = {
            nickname: player.nickname,
            message: message.substring(0, 200), // Limit length
            role: player.role, // 'setter' or 'guesser'
            senderId: socket.id,
            timestamp: Date.now()
        };

        io.to(lobbyId).emit('chat_message', chatMsg);
    });

    socket.on('set_target', async ({ lobbyId, lat, lon }) => {
        const lobby = lobbies.get(lobbyId);
        
        // Detailed error logging for debugging
        if (!lobby) {
            console.error(`[set_target] Failed: Lobby ${lobbyId} not found. Available lobbies: ${Array.from(lobbies.keys()).join(', ')}`);
            socket.emit('game_error', { code: 'LOBBY_NOT_FOUND', message: 'Lobby no longer exists (Server restarted?)' });
            return;
        }
        
        if (lobby.gameState.setterId !== socket.id) {
            console.error(`[set_target] Failed: User ${socket.id} is not setter. Actual setter: ${lobby.gameState.setterId}`);
            socket.emit('game_error', { code: 'NOT_SETTER', message: 'You are not the setter for this round.' });
            return;
        }

        console.log(`[set_target] User ${socket.id} attempting to set target at ${lat}, ${lon}`);

        // Validate population via Overpass (Server-side)
        try {
            const query = `
                [out:json];
                (
                  node["place"~"city|town"](around:20000,${lat},${lon});
                  way["place"~"city|town"](around:20000,${lat},${lon});
                  relation["place"~"city|town"](around:20000,${lat},${lon});
                );
                out center tags;
            `;
            
            // Using dynamic import for node-fetch or native fetch in Node 18+
            const response = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
                method: "POST", body: query,
                headers: { 'User-Agent': 'GTC-Game/1.0' }
            });
            if (!response.ok) throw new Error(`Overpass API error: ${response.status}`);
            const data = await response.json();
            
            const validPlaces = data.elements.filter(n => {
                const popStr = n.tags?.population?.replace(/,/g, '') || '0';
                return parseInt(popStr, 10) > (lobby.settings.minPop || 5000);
            });

            if (validPlaces.length === 0) {
                socket.emit('error', `Invalid location: Must be a city/town with >${(lobby.settings.minPop || 5000)/1000}k population.`);
                return;
            }

            // Sort by distance to clicked point to find closest valid city
            validPlaces.sort((a, b) => {
                const latA = a.lat || a.center?.lat;
                const lonA = a.lon || a.center?.lon;
                const latB = b.lat || b.center?.lat;
                const lonB = b.lon || b.center?.lon;
                const distA = calculateHaversineDistance(lat, lon, latA, lonA);
                const distB = calculateHaversineDistance(lat, lon, latB, lonB);
                return distA - distB;
            });
            
            const placeToUse = validPlaces[0];

            console.log(`[set_target] Valid location found: ${placeToUse.tags.name || 'Unknown'}`);

            // Reverse geocode for name
            const nominatimRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`, {
                headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
            });
            if (!nominatimRes.ok) throw new Error(`Nominatim API error: ${nominatimRes.status}`);
            const geoData = await nominatimRes.json();
            
            // Construct detailed name: "City, Region, Country"
            const addr = geoData.address;
            const city = addr.city || addr.town || addr.village || placeToUse.tags.name;
            const region = addr.state || addr.region || addr.county || '';
            const country = addr.country || '';
            
            const nameParts = [city, region, country].filter(Boolean);
            const fullName = nameParts.join(', ');
            const countryCode = addr.country_code;

            lobby.gameState.target = { 
                lat, lon, 
                name: fullName, 
                countryCode 
            };

            // Fetch continent
            try {
                const restRes = await fetchWithTimeout(`https://restcountries.com/v3.1/alpha/${countryCode}`, {
                    headers: { 'User-Agent': 'GTC-Game/1.0' }
                });
                if (restRes.ok) {
                    const restData = await restRes.json();
                    if (restData?.[0]?.continents) {
                        lobby.gameState.target.continent = restData[0].continents[0];
                    }
                }
            } catch(e) {}

            lobby.gameState.phase = 'SETUP_IMG';
            lobby.lastInteraction = Date.now();
            lobby.setterAssignedAt = Date.now(); // Reset for image upload phase
            lobby.setterWarned = false;
            
            broadcastState(lobbyId);

        } catch (e) {
            console.error(`[set_target] Error during validation:`, e);
            socket.emit('error', 'Validation failed');
        }
    });

    socket.on('submit_guess', async ({ lobbyId, query }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.gameState.phase !== 'PLAYING') return;
        if (lobby.gameState.setterId === socket.id) return; // Setter can't guess

        // Turn Logic
        if (lobby.settings.gameMode === 'turn_based') {
            if (lobby.turnState.currentGuesserId !== socket.id) {
                socket.emit('error', 'Not your turn!');
                return;
            }
        }

        lobby.lastInteraction = Date.now();

        try {
            // Geocode
            const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1`, {
                headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
            });
            
            if (!res.ok) {
                console.error(`[submit_guess] Nominatim error: ${res.status}`);
                socket.emit('error', 'Geocoding service unavailable');
                return;
            }

            const data = await res.json();

            if (!data || data.length === 0) {
                socket.emit('error', 'Location not found');
                return;
            }

            const guess = data[0];
            const lat = parseFloat(guess.lat);
            const lon = parseFloat(guess.lon);
            const name = guess.display_name.split(',')[0];
            
            // Check for duplicates (global)
            if (lobby.gameState.guesses.some(g => g.name === name)) {
                socket.emit('error', 'Location already guessed!');
                return;
            }

            const countryCode = guess.address?.country_code;

            console.log(`[submit_guess] User ${socket.id} guessed: ${name} (${lat}, ${lon}). Target: ${lobby.gameState.target.name} (${lobby.gameState.target.lat}, ${lobby.gameState.target.lon})`);

            const dist = calculateHaversineDistance(lat, lon, lobby.gameState.target.lat, lobby.gameState.target.lon);
            const isSameCountry = (countryCode === lobby.gameState.target.countryCode);
            
            console.log(`[submit_guess] Distance: ${dist.toFixed(2)}km, Same Country: ${isSameCountry}`);
            
            const player = lobby.players.find(p => p.id === socket.id);
            
            // Update State
            lobby.gameState.guesses.push({
                nickname: player.nickname,
                name, lat, lon, distance: dist, isSameCountry,
                timestamp: Date.now()
            });
            // lobby.gameState.guesses.sort((a, b) => a.distance - b.distance); // Removed: Sort by time (insertion order)

            // Advance Turn
            if (lobby.settings.gameMode === 'turn_based') {
                advanceTurn(lobby);
            }

            // Win Condition
            if (dist <= 5) {
                console.log(`[submit_guess] WIN! Distance ${dist} <= 5km`);
                lobby.gameState.phase = 'WON';
                lobby.gameState.winnerId = socket.id;
                // Prepare next setter
                lobby.gameState.setterId = socket.id; 
                broadcastState(lobbyId);
                return;
            }

            // Logic for Masking (Turf)
            if (!lobby.gameState.validPolygon) {
                lobby.gameState.validPolygon = turf.polygon([[[-360, 90], [360, 90], [360, -90], [-360, -90], [-360, 90]]]);
            }

            let newPoly = lobby.gameState.validPolygon;

            // --- Powerups / Hints based on Guess Count ---
            const guessCount = lobby.gameState.guesses.length;
            const thresholds = lobby.settings.hintThresholds || [30, 60, 90];
            
            // Hint 1: Hemisphere Mask
            if (guessCount === thresholds[0] && !lobby.gameState.hints.hemisphere) {
                lobby.gameState.hints.hemisphere = true;
                const isNorth = lobby.gameState.target.lat >= 0;
                // Mask the WRONG hemisphere
                const badHemisphere = isNorth ? turf.bboxPolygon([-180, -90, 180, 0]) : turf.bboxPolygon([-180, 0, 180, 90]);
                try {
                    const diff = turf.difference(turf.featureCollection([newPoly, badHemisphere]));
                    if (diff) newPoly = diff;
                } catch(e) { console.error("Hemisphere mask error", e); }
            }

            // Hint 2: Continent Mask
            if (guessCount === thresholds[1] && !lobby.gameState.hints.continent && lobby.gameState.target.continent) {
                lobby.gameState.hints.continent = true;
                try {
                    // Note: Fetching continent polygon is heavy/complex. 
                    // For now, we'll try a Nominatim search for the continent name.
                    const contRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(lobby.gameState.target.continent)}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0' }
                    });
                    if (contRes.ok) {
                        const contData = await contRes.json();
                        if (contData?.[0]?.geojson) {
                            let contFeat = turf.feature(contData[0].geojson);
                            contFeat = optimizeGeometry(contFeat); // Optimize

                            const intersect = turf.intersect(turf.featureCollection([newPoly, contFeat]));
                            if (intersect) newPoly = intersect;
                        }
                    }
                } catch(e) { console.error("Continent mask error", e); }
            }

            // Hint 3: Country Reveal (if not already)
            if (guessCount === thresholds[2] && !lobby.gameState.hints.country) {
                lobby.gameState.hints.country = true;
                try {
                    const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            let countryFeat = turf.feature(polyData[0].geojson);
                            countryFeat = optimizeGeometry(countryFeat); // Optimize

                            const intersect = turf.intersect(turf.featureCollection([newPoly, countryFeat]));
                            if (intersect) newPoly = intersect;
                        }
                    }
                } catch(e) { console.error("Country reveal error (90 guesses)", e); }
            }

            // Country Logic (Guess-based)
            if (isSameCountry && !lobby.gameState.hints.country) {
                // Reveal Country Logic (Simplified for server: fetch geojson)
                // Note: Fetching heavy geojson on every guess might be slow. 
                // For MVP, we'll mark it revealed and let clients fetch mask or fetch here.
                // Better: Fetch here and update polygon.
                try {
                    // Added polygon_threshold=0.01 to reduce initial payload size
                    const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            let countryFeat = turf.feature(polyData[0].geojson);
                            countryFeat = optimizeGeometry(countryFeat); // Optimize before operation
                            
                            const intersect = turf.intersect(turf.featureCollection([newPoly, countryFeat]));
                            if (intersect) newPoly = intersect;
                            else newPoly = countryFeat;
                            lobby.gameState.hints.country = true;
                        }
                    }
                } catch(e) { console.error("Country reveal error:", e); }
            } else if (!isSameCountry && countryCode) {
                // Mask Wrong Country
                 try {
                    const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            let countryFeat = turf.feature(polyData[0].geojson);
                            countryFeat = optimizeGeometry(countryFeat); // Optimize before operation

                            const diff = turf.difference(turf.featureCollection([newPoly, countryFeat]));
                            if (diff) newPoly = diff;
                            lobby.gameState.wrongCountries.push(countryCode);
                        }
                    }
                } catch(e) { console.error("Wrong country mask error:", e); }
            }

            // Distance Rings
            const distThresholds = [250, 100, 50, 20, 10, 5];
            let max_T = 0;
            for (let t of distThresholds) { if (dist > t) { max_T = t; break; } }
            
            if (max_T > 0) {
                const circle = turf.circle([lon, lat], max_T, {units: 'kilometers', steps: 24});
                const diff = turf.difference(turf.featureCollection([newPoly, circle]));
                if (diff) newPoly = diff;
            }

            let min_T = Infinity;
            const ascendingThresholds = [...distThresholds].reverse();
            for (let t of ascendingThresholds) { if (dist <= t) { min_T = t; break; } }

            if (min_T !== Infinity) {
                const circle = turf.circle([lon, lat], min_T, {units: 'kilometers', steps: 24});
                const intersect = turf.intersect(turf.featureCollection([newPoly, circle]));
                if (intersect) newPoly = intersect;
            }

            lobby.gameState.validPolygon = optimizeGeometry(newPoly); // Optimize result to keep state small

            // Hint Cities Logic (Server-side)
            // If distance <= 100km and hints not yet fetched, fetch them now.
            if (dist <= 100 && !lobby.gameState.hintCities) {
                console.log(`[submit_guess] Distance <= 100km (${dist.toFixed(2)}km). Fetching hint cities...`);
                const radius = 100000;
                const query = `
                    [out:json];
                    (
                      node["place"~"city|town"](around:${radius},${lobby.gameState.target.lat},${lobby.gameState.target.lon});
                      way["place"~"city|town"](around:${radius},${lobby.gameState.target.lat},${lobby.gameState.target.lon});
                      relation["place"~"city|town"](around:${radius},${lobby.gameState.target.lat},${lobby.gameState.target.lon});
                    );
                    out center tags;
                `;
                
                try {
                    const hintRes = await fetchWithTimeout("https://overpass-api.de/api/interpreter", {
                        method: "POST", body: query,
                        headers: { 'User-Agent': 'GTC-Game/1.0' }
                    });
                    if (hintRes.ok) {
                        const hintData = await hintRes.json();
                        lobby.gameState.hintCities = hintData.elements.filter(n => {
                            const pop = parseInt(n.tags?.population?.replace(/,/g, '') || '0', 10);
                            return pop > 5000;
                        }).map(n => ({
                            lat: n.lat || n.center?.lat,
                            lon: n.lon || n.center?.lon,
                            name: n.tags.name,
                            pop: n.tags.population
                        }));
                        console.log(`[submit_guess] Fetched ${lobby.gameState.hintCities.length} hint cities.`);
                    }
                } catch (e) {
                    console.error("[submit_guess] Failed to fetch hint cities:", e);
                }
            }

            broadcastState(lobbyId);

        } catch (e) {
            console.error(e);
            socket.emit('error', 'Guess processing failed');
        }
    });

    socket.on('give_up_role', ({ lobbyId, targetUserId }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.gameState.setterId !== socket.id) return;

        // Restriction: Cannot give up role if game is PLAYING (or SETUP_IMG if we want to be strict, but user said "game is live")
        // "Game is live" usually means PLAYING phase where guesses are happening.
        if (lobby.gameState.phase === 'PLAYING') {
             socket.emit('error', 'Cannot give up role while game is live.');
             return;
        }

        let nextSetterId = null;

        if (targetUserId) {
            // Validate target user exists in lobby
            const targetUser = lobby.players.find(p => p.id === targetUserId);
            if (targetUser && targetUser.id !== socket.id) {
                nextSetterId = targetUser.id;
            }
        }

        // If no specific target or target invalid, pick random
        if (!nextSetterId) {
            const otherPlayers = lobby.players.filter(p => p.id !== socket.id);
            if (otherPlayers.length > 0) {
                const nextSetter = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
                nextSetterId = nextSetter.id;
            }
        }

        if (nextSetterId) {
            lobby.gameState.setterId = nextSetterId;
            
            // Reset round
            lobby.gameState.phase = 'SETUP_LOC';
            lobby.gameState.target = { lat: null, lon: null };
            lobby.gameState.image = null;
            lobby.gameState.guesses = [];
            lobby.gameState.validPolygon = null;
            lobby.gameState.hints = { hemisphere: false, continent: false, country: false };
            
            broadcastState(lobbyId);
        }
    });

    socket.on('i_am_here', ({ lobbyId }) => {
        const lobby = lobbies.get(lobbyId);
        if (lobby && lobby.gameState.setterId === socket.id) {
            lobby.setterAssignedAt = Date.now();
            lobby.setterWarned = false;
        }
    });

    socket.on('disconnect', () => {
        handleDisconnect(socket);
    });

    socket.on('get_leaderboard', () => {
        socket.emit('leaderboard_data', leaderboard);
    });
});

function handleDisconnect(socket, specificLobbyId = null) {
    // Find lobby player was in
    for (const [lobbyId, lobby] of lobbies.entries()) {
        if (specificLobbyId && lobbyId !== specificLobbyId) continue;

        const index = lobby.players.findIndex(p => p.id === socket.id);
        if (index !== -1) {
            const wasSetter = lobby.gameState.setterId === socket.id;
            const wasHost = lobby.hostId === socket.id;
            
            lobby.players.splice(index, 1);
            socket.leave(lobbyId); // Ensure socket leaves room
            
            if (lobby.players.length === 0) {
                lobbies.delete(lobbyId);
            } else {
                // Reassign Host
                if (wasHost) {
                    lobby.hostId = lobby.players[0].id;
                }

                if (wasSetter) {
                    // Assign new setter
                    lobby.gameState.setterId = lobby.players[0].id;
                    lobby.gameState.phase = 'SETUP_LOC';
                    // Reset round state
                    lobby.gameState.target = { lat: null, lon: null };
                    lobby.gameState.image = null;
                    lobby.gameState.guesses = [];
                    lobby.gameState.validPolygon = null;
                }
                broadcastState(lobbyId);
            }
            break;
        }
    }
}

// --- Game Loop (1s Interval) ---
setInterval(() => {
    const now = Date.now();
    for (const [lobbyId, lobby] of lobbies.entries()) {
        
        // 1. Lobby Inactivity (10 mins)
        if (now - lobby.lastInteraction > 10 * 60 * 1000) {
            console.log(`Lobby ${lobbyId} closed due to inactivity.`);
            lobbies.delete(lobbyId);
            io.to(lobbyId).emit('game_error', { code: 'LOBBY_CLOSED', message: 'Lobby closed due to inactivity.' });
            continue;
        }

        // 2. Turn Timeout
        if (lobby.gameState.phase === 'PLAYING' && lobby.settings.gameMode === 'turn_based' && lobby.turnState.deadline) {
            if (now > lobby.turnState.deadline) {
                advanceTurn(lobby);
                broadcastState(lobbyId);
            }
        }

        // 3. Setter Inactivity
        if (lobby.gameState.phase === 'SETUP_LOC' || lobby.gameState.phase === 'SETUP_IMG') {
            const timeSinceSet = now - lobby.setterAssignedAt;
            
            // Warning at 3 mins
            if (timeSinceSet > 3 * 60 * 1000 && !lobby.setterWarned) {
                lobby.setterWarned = true;
                const socket = io.sockets.sockets.get(lobby.gameState.setterId);
                if (socket) socket.emit('check_activity');
            }

            // Action at 5 mins
            if (timeSinceSet > 5 * 60 * 1000) {
                lobby.inactivityStrikes++;
                if (lobby.inactivityStrikes >= 2) {
                    lobbies.delete(lobbyId);
                    io.to(lobbyId).emit('game_error', { code: 'LOBBY_CLOSED', message: 'Lobby closed due to repeated inactivity.' });
                } else {
                    // Force give up role
                    // Find new setter
                    const otherPlayers = lobby.players.filter(p => p.id !== lobby.gameState.setterId);
                    if (otherPlayers.length > 0) {
                        const nextSetter = otherPlayers[Math.floor(Math.random() * otherPlayers.length)];
                        lobby.gameState.setterId = nextSetter.id;
                        lobby.gameState.phase = 'SETUP_LOC';
                        lobby.gameState.target = { lat: null, lon: null };
                        lobby.gameState.image = null;
                        lobby.gameState.guesses = [];
                        lobby.gameState.validPolygon = null;
                        lobby.gameState.hints = { hemisphere: false, continent: false, country: false };
                        lobby.setterAssignedAt = Date.now();
                        lobby.setterWarned = false;
                        
                        io.to(lobbyId).emit('error', 'Setter was inactive. Role passed.');
                        broadcastState(lobbyId);
                    } else {
                        // No one else? Close it.
                        lobbies.delete(lobbyId);
                    }
                }
            }
        }
    }
}, 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});