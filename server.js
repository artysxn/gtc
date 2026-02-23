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
    target: { lat: null, lon: null, name: null, countryCode: null, continent: null, countryName: null, placeId: null },
    image: null,
    guesses: [],
    validPolygon: null, // Starts as null, becomes world polygon on first guess
    hintLabels: { hemisphere: null, continent: null, country: null, coastal: null }, // powerups
    winnerId: null,
    wrongCountries: [], // Array of country codes
    // Powerup voting system (5 stages)
    powerupStage: 0,           // 0 = none, 1-4 = powerup stages, 5 = country revealed
    activePowerups: [],        // Applied powerup IDs for stacking/conditionals
    powerupVote: null,         // { options: [{ id, label, description }], endAt, votes: { [powerupId]: count }, votedBy: { [playerId]: powerupId } }
    powerupVoteTimer: null,    // setTimeout handle to clear
    snipingImmunityUntil: null,
    snipingImmunityGuesserId: null,
    cityNameLetterCount: null,
    cityNameRevealedLetters: [], // [{ index, letter }]
    scanZoneBonusKm: 0,
    cooldownReductionSeconds: 0,
    radarPlacementPlayerId: null,
    radarPlacementRadiusKm: null, // 750 or custom
    radarPlacementEndAt: null,
    radarResultPolygon: null,
    // Second image (stage 3): setter has 60s to upload, then warning, then penalty every 15s from 90s
    secondImageUploadBy: null,    // timestamp: upload deadline (60s after stage 3 starts)
    secondImageUrl: null,         // /uploads/... when uploaded
    secondImageWarningShown: false,
    secondImageLastPenaltyAt: null // when we last applied a penalty (every 15s after 90s)
};

const DEFAULT_SETTINGS = {
    minPop: 5000,
    hintThresholds: [5, 10, 15, 20, 25], // 5 stages; Casual default
    password: null,
    gameMode: 'ffa', // 'ffa' or 'turn_based'
    moveTimeLimit: 0, // Seconds, 0 = off
    hiderVictoryEnabled: false // If true, setter wins when guess count reaches 1.25× country threshold
};

// Powerup IDs (used for conditionals and activePowerups)
const POWERUP_IDS = {
    REMOVE_4_COUNTRIES: 'remove_4_countries',
    REMOVE_5_COUNTRIES: 'remove_5_countries',
    SCAN_ZONE_10: 'scan_zone_10',
    SCAN_ZONE_15: 'scan_zone_15',
    SCAN_ZONE_75: 'scan_zone_75',
    SCAN_ZONE_100: 'scan_zone_100',
    COOLDOWN_1: 'cooldown_1',
    SNIPING_IMMUNITY: 'sniping_immunity',
    RADAR_750: 'radar_750',
    RADAR_CUSTOM: 'radar_custom',
    REVEAL_LETTER_COUNT: 'reveal_letter_count',
    REVEAL_ONE_LETTER: 'reveal_one_letter',
    REVEAL_TWO_LETTERS: 'reveal_two_letters',
    REVEAL_HEMISPHERE: 'reveal_hemisphere',
    REVEAL_COUNTRY: 'reveal_country',
    REVEAL_COASTAL: 'reveal_coastal'
};

// Stage 1–4 pools: { id, label, description }. Condition: (gameState) => boolean to include in draw.
const POWERUP_POOLS = [
    [ // Stage 1
        { id: POWERUP_IDS.REMOVE_4_COUNTRIES, label: 'Remove 4 countries', description: '4 wrong countries grayed out.' },
        { id: POWERUP_IDS.SCAN_ZONE_10, label: 'Scan +10 km', description: 'Search radius 260 km (was 250).' },
        { id: POWERUP_IDS.COOLDOWN_1, label: 'Cooldown -1 s', description: 'Guess cooldown reduced by 1 second.' },
        { id: POWERUP_IDS.SNIPING_IMMUNITY, label: 'Sniping immunity', description: 'After country revealed by a guess, only that guesser can guess for 15 s.' }
    ],
    [ // Stage 2
        { id: POWERUP_IDS.REMOVE_5_COUNTRIES, label: 'Remove 5 countries', description: '5 wrong countries grayed out.' },
        { id: POWERUP_IDS.SCAN_ZONE_15, label: 'Scan +15 km', description: 'Search radius +15 km. Stacks.' },
        { id: POWERUP_IDS.COOLDOWN_1, label: 'Cooldown -1 s', description: 'Stacks.' },
        { id: POWERUP_IDS.RADAR_750, label: '1× 750 km radar', description: 'Random player places a pin; 750 km scan for all.' },
        { id: POWERUP_IDS.REVEAL_LETTER_COUNT, label: 'Letters in city name', description: 'Shows underscores: City name: _ _ _ _ _' }
    ],
    [ // Stage 3
        { id: POWERUP_IDS.RADAR_CUSTOM, label: '1× Custom radar', description: 'Random player places pin and scalable circle.' },
        { id: POWERUP_IDS.SCAN_ZONE_75, label: 'Scan +75 km', description: 'Stacks.' },
        { id: POWERUP_IDS.COOLDOWN_1, label: 'Cooldown -1 s', description: 'Stacks.' },
        { id: POWERUP_IDS.REVEAL_HEMISPHERE, label: 'Reveal hemisphere', description: 'North or South?' },
        { id: POWERUP_IDS.REVEAL_ONE_LETTER, label: 'Reveal 1 letter', description: 'Only if letter count was selected.', condition: (gs) => gs.activePowerups && gs.activePowerups.includes(POWERUP_IDS.REVEAL_LETTER_COUNT) }
    ],
    [ // Stage 4
        { id: POWERUP_IDS.RADAR_CUSTOM, label: '1× Custom radar', description: 'Random player places pin and scalable circle.' },
        { id: POWERUP_IDS.SCAN_ZONE_100, label: 'Scan +100 km', description: 'Stacks.' },
        { id: POWERUP_IDS.REVEAL_TWO_LETTERS, label: 'Reveal 2 letters', description: 'Only if letter count was selected.', condition: (gs) => gs.activePowerups && gs.activePowerups.includes(POWERUP_IDS.REVEAL_LETTER_COUNT) },
        { id: POWERUP_IDS.REVEAL_COASTAL, label: 'Coastal or landlocked?', description: 'Is the country of the city coastal or landlocked?' }
    ]
];

// Landlocked countries (ISO 3166-1 alpha-2). Coastal = not in this set.
const LANDLOCKED_COUNTRY_CODES = new Set(['AD', 'AM', 'AT', 'AZ', 'BY', 'BE', 'BT', 'BO', 'BW', 'BF', 'BI', 'CF', 'TD', 'CZ', 'ET', 'HU', 'KZ', 'KG', 'LA', 'LS', 'LI', 'LU', 'MK', 'MW', 'ML', 'MD', 'MN', 'NE', 'NP', 'PY', 'RW', 'SM', 'RS', 'SK', 'SS', 'SZ', 'CH', 'TJ', 'TM', 'UG', 'UZ', 'VA', 'ZM', 'ZW']);

function drawTwoFromPool(stageIndex, gameState) {
    const pool = POWERUP_POOLS[stageIndex];
    if (!pool) return [];
    const eligible = pool.filter(p => !p.condition || p.condition(gameState));
    if (eligible.length <= 2) return eligible.map(p => ({ id: p.id, label: p.label, description: p.description }));
    const shuffled = [...eligible].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, 2).map(p => ({ id: p.id, label: p.label, description: p.description }));
}

async function finishPowerupVote(lobbyId) {
    const lobby = getLobby(lobbyId);
    if (!lobby || !lobby.gameState.powerupVote) return;
    if (lobby.powerupVoteTimer) {
        clearTimeout(lobby.powerupVoteTimer);
        lobby.powerupVoteTimer = null;
    }
    const vote = lobby.gameState.powerupVote;
    const options = vote.options;
    const votes = vote.votes || {};
    let bestCount = 0;
    const winners = [];
    for (const opt of options) {
        const c = votes[opt.id] || 0;
        if (c > bestCount) { bestCount = c; winners.length = 0; winners.push(opt.id); }
        else if (c === bestCount && c > 0) winners.push(opt.id);
    }
    const winnerId = winners.length === 0 ? options[0].id : winners[Math.floor(Math.random() * winners.length)];
    lobby.gameState.powerupVote = null;
    lobby.gameState.powerupStage++;
    await applyPowerup(lobbyId, winnerId, lobby.gameState.powerupStage - 1);
}

async function applyPowerup(lobbyId, powerupId, stageIndex) {
    const lobby = getLobby(lobbyId);
    if (!lobby) return;
    const gs = lobby.gameState;
    if (!gs.activePowerups) gs.activePowerups = [];
    gs.activePowerups.push(powerupId);

    if (powerupId === POWERUP_IDS.SCAN_ZONE_10) gs.scanZoneBonusKm = (gs.scanZoneBonusKm || 0) + 10;
    else if (powerupId === POWERUP_IDS.SCAN_ZONE_15) gs.scanZoneBonusKm = (gs.scanZoneBonusKm || 0) + 15;
    else if (powerupId === POWERUP_IDS.SCAN_ZONE_75) gs.scanZoneBonusKm = (gs.scanZoneBonusKm || 0) + 75;
    else if (powerupId === POWERUP_IDS.SCAN_ZONE_100) gs.scanZoneBonusKm = (gs.scanZoneBonusKm || 0) + 100;
    else if (powerupId === POWERUP_IDS.COOLDOWN_1) gs.cooldownReductionSeconds = (gs.cooldownReductionSeconds || 0) + 1;
    else if (powerupId === POWERUP_IDS.REVEAL_LETTER_COUNT && lobby.gameState.target && lobby.gameState.target.name) {
        gs.cityNameLetterCount = lobby.gameState.target.name.length;
    }
    else if (powerupId === POWERUP_IDS.REVEAL_ONE_LETTER && lobby.gameState.target && lobby.gameState.target.name) {
        const name = lobby.gameState.target.name;
        const indices = [];
        for (let i = 0; i < name.length; i++) if (name[i] !== ' ') indices.push(i);
        const already = (gs.cityNameRevealedLetters || []).map(r => r.index);
        const left = indices.filter(i => !already.includes(i));
        if (left.length > 0) {
            const idx = left[Math.floor(Math.random() * left.length)];
            if (!gs.cityNameRevealedLetters) gs.cityNameRevealedLetters = [];
            gs.cityNameRevealedLetters.push({ index: idx, letter: name[idx] });
        }
    }
    else if (powerupId === POWERUP_IDS.REVEAL_TWO_LETTERS && lobby.gameState.target && lobby.gameState.target.name) {
        const name = lobby.gameState.target.name;
        const indices = [];
        for (let i = 0; i < name.length; i++) if (name[i] !== ' ') indices.push(i);
        const already = (gs.cityNameRevealedLetters || []).map(r => r.index);
        const left = indices.filter(i => !already.includes(i));
        if (!gs.cityNameRevealedLetters) gs.cityNameRevealedLetters = [];
        for (let n = 0; n < 2 && left.length > 0; n++) {
            const idx = left.splice(Math.floor(Math.random() * left.length), 1)[0];
            gs.cityNameRevealedLetters.push({ index: idx, letter: name[idx] });
        }
    }
    else if (powerupId === POWERUP_IDS.REVEAL_COASTAL && lobby.gameState.target && lobby.gameState.target.countryCode) {
        if (!gs.hintLabels) gs.hintLabels = { hemisphere: null, continent: null, country: null, coastal: null };
        const code = (lobby.gameState.target.countryCode || '').toUpperCase();
        gs.hintLabels.coastal = LANDLOCKED_COUNTRY_CODES.has(code) ? 'Landlocked' : 'Coastal';
    }
    else if (powerupId === POWERUP_IDS.REVEAL_HEMISPHERE) {
        if (!gs.hintLabels) gs.hintLabels = { hemisphere: null, continent: null, country: null, coastal: null };
        gs.hintLabels.hemisphere = lobby.gameState.target.lat >= 0 ? 'Northern' : 'Southern';
        if (gs.validPolygon) {
            const isNorth = lobby.gameState.target.lat >= 0;
            const badHemisphere = isNorth ? turf.bboxPolygon([-180, -90, 180, 0]) : turf.bboxPolygon([-180, 0, 180, 90]);
            try {
                const diff = turf.difference(turf.featureCollection([gs.validPolygon, badHemisphere]));
                if (diff) gs.validPolygon = optimizeGeometry(diff);
            } catch (e) { console.error("Hemisphere mask error", e); }
        }
    }
    else if (powerupId === POWERUP_IDS.RADAR_750) {
        const guessers = lobby.players.filter(p => p.id !== gs.setterId);
        if (guessers.length > 0) {
            const pick = guessers[Math.floor(Math.random() * guessers.length)];
            gs.radarPlacementPlayerId = pick.id;
            gs.radarPlacementRadiusKm = 750;
            gs.radarPlacementEndAt = Date.now() + 10000;
        }
    }
    else if (powerupId === POWERUP_IDS.RADAR_CUSTOM) {
        const guessers = lobby.players.filter(p => p.id !== gs.setterId);
        if (guessers.length > 0) {
            const pick = guessers[Math.floor(Math.random() * guessers.length)];
            gs.radarPlacementPlayerId = pick.id;
            gs.radarPlacementRadiusKm = null;
            gs.radarPlacementEndAt = Date.now() + 15000;
        }
    }
    else if (powerupId === POWERUP_IDS.SNIPING_IMMUNITY) { /* applied on same-country guess */ }
    else if (powerupId === POWERUP_IDS.REMOVE_4_COUNTRIES || powerupId === POWERUP_IDS.REMOVE_5_COUNTRIES) {
        const n = powerupId === POWERUP_IDS.REMOVE_4_COUNTRIES ? 4 : 5;
        const targetCode = (lobby.gameState.target.countryCode || '').toUpperCase();
        if (!REST_COUNTRIES_CACHE) {
            try {
                const restRes = await fetchWithTimeout('https://restcountries.com/v3.1/all?fields=cca2', { headers: { 'User-Agent': 'GTC-Game/1.0' }, timeout: 15000 });
                if (restRes.ok) REST_COUNTRIES_CACHE = await restRes.json();
            } catch (e) { console.warn('REST Countries fetch failed', e); }
        }
        const allCodes = (REST_COUNTRIES_CACHE || []).map(c => (c.cca2 || '').toUpperCase()).filter(Boolean);
        const wrong = allCodes.filter(c => c !== targetCode && !(gs.wrongCountries || []).includes(c));
        const toRemove = [];
        for (let i = 0; i < n && wrong.length > 0; i++) {
            const idx = Math.floor(Math.random() * wrong.length);
            toRemove.push(wrong.splice(idx, 1)[0]);
        }
        for (const code of toRemove) {
            gs.wrongCountries.push(code);
            try {
                const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${code}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, { headers: { 'User-Agent': 'GTC-Game/1.0' }, timeout: 10000 });
                if (polyRes.ok && gs.validPolygon) {
                    const polyData = await polyRes.json();
                    if (polyData?.[0]?.geojson) {
                        let countryFeat = turf.feature(polyData[0].geojson);
                        countryFeat = optimizeGeometry(countryFeat);
                        const diff = turf.difference(turf.featureCollection([gs.validPolygon, countryFeat]));
                        if (diff) gs.validPolygon = optimizeGeometry(diff);
                    }
                }
            } catch (e) { console.warn('Remove country polygon failed', code, e); }
        }
    }
    broadcastState(lobbyId);
}

// Countries that span multiple continents, normalized to a single one for game logic
const CONTINENT_OVERRIDES = {
    RU: 'Europe',          // Russia
    TR: 'Europe',          // Turkey
    KZ: 'Asia',            // Kazakhstan
    AZ: 'Asia',            // Azerbaijan
    GE: 'Asia',            // Georgia
    EG: 'Africa',          // Egypt
    ID: 'Asia',            // Indonesia
    FR: 'Europe',          // France (has overseas territories)
    ES: 'Europe',          // Spain (Canary Islands, etc.)
    PT: 'Europe',          // Portugal (Azores, Madeira)
    US: 'North America',   // United States (Alaska, Hawaii, territories)
    DK: 'Europe',          // Denmark (Greenland)
    NL: 'Europe',          // Netherlands (Caribbean territories)
    GB: 'Europe'           // United Kingdom
};

// Cache for REST Countries dataset so we only fetch once
let REST_COUNTRIES_CACHE = null;

function normalizeContinentForCountry(countryCode, continentsFromApi) {
    const code = (countryCode || '').toUpperCase();
    if (CONTINENT_OVERRIDES[code]) return CONTINENT_OVERRIDES[code];
    if (Array.isArray(continentsFromApi) && continentsFromApi.length > 0) {
        return continentsFromApi[0];
    }
    return null;
}

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

    // Sync player roles and ensure stats exist
    lobby.players.forEach(p => {
        p.role = (p.id === lobby.gameState.setterId) ? 'setter' : 'guesser';
        ensurePlayerStats(p);
    });

    // Sanitize state for guessers (hide target unless WON or they are setter)
    const fullState = lobby.gameState;
    
    // We send different views to different players
    lobby.players.forEach(player => {
        const socket = io.sockets.sockets.get(player.id);
        if (!socket) return;

        const isSetter = player.id === fullState.setterId;
        const isWon = fullState.phase === 'WON' || fullState.phase === 'HIDER_WON';

        const sanitizedState = {
            ...fullState,
            target: (isSetter || isWon) ? fullState.target : { lat: null, lon: null, name: null, countryCode: null, continent: null, countryName: null, placeId: null },
            players: lobby.players,
            myRole: isSetter ? 'setter' : 'guesser',
            settings: lobby.settings,
            isHost: player.id === lobby.hostId,
            turnState: lobby.turnState,
            timeLeft: lobby.turnState.deadline ? Math.max(0, Math.ceil((lobby.turnState.deadline - Date.now()) / 1000)) : null,
            guessCooldownUntil: (lobby.guessCooldownUntil && lobby.guessCooldownUntil[player.id]) ? lobby.guessCooldownUntil[player.id] : null,
            guessCooldownStarted: (lobby.guessCooldownStarted && lobby.guessCooldownStarted[player.id]) ? lobby.guessCooldownStarted[player.id] : null,
            powerupVote: fullState.powerupVote,
            powerupStage: fullState.powerupStage,
            activePowerups: fullState.activePowerups || [],
            snipingImmunityUntil: fullState.snipingImmunityUntil,
            snipingImmunityGuesserId: fullState.snipingImmunityGuesserId,
            cityNameLetterCount: fullState.cityNameLetterCount,
            cityNameRevealedLetters: fullState.cityNameRevealedLetters || [],
            scanZoneBonusKm: fullState.scanZoneBonusKm || 0,
            cooldownReductionSeconds: fullState.cooldownReductionSeconds || 0,
            radarPlacementPlayerId: fullState.radarPlacementPlayerId,
            radarPlacementRadiusKm: fullState.radarPlacementRadiusKm,
            radarPlacementEndAt: fullState.radarPlacementEndAt,
            radarResultPolygon: fullState.radarResultPolygon,
            secondImageUploadBy: fullState.secondImageUploadBy,
            secondImageUrl: fullState.secondImageUrl
        };

        socket.emit('game_state_update', sanitizedState);
    });
}

function ensurePlayerStats(player) {
    if (player.winsAsSetter == null) player.winsAsSetter = 0;
    if (player.winsAsGuesser == null) player.winsAsGuesser = 0;
    if (player.totalGuesses == null) player.totalGuesses = 0;
    if (player.roundsPlayed == null) player.roundsPlayed = 0;
}

function updateRoundStats(lobby, winType, winnerId) {
    const guesses = lobby.gameState.guesses || [];
    lobby.players.forEach(p => {
        ensurePlayerStats(p);
        p.roundsPlayed = (p.roundsPlayed || 0) + 1;
        const thisRoundGuesses = guesses.filter(g => g.socketId === p.id).length;
        p.totalGuesses = (p.totalGuesses || 0) + thisRoundGuesses;
        if (winType === 'guesser' && p.id === winnerId) p.winsAsGuesser = (p.winsAsGuesser || 0) + 1;
        if (winType === 'hider' && p.id === lobby.gameState.setterId) p.winsAsSetter = (p.winsAsSetter || 0) + 1;
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

function logSlowGuess(lobbyId, item, reason) {
    if (!item || item.enqueuedAt == null) return;
    const elapsed = Date.now() - item.enqueuedAt;
    if (elapsed >= 3000) {
        console.warn(`[guess_queue] Guess took ${(elapsed / 1000).toFixed(1)}s to register. ${reason}`);
    }
}

// --- Guess queue: FIFO, one-at-a-time, retry on API failure until success ---
async function processGuessQueue(lobbyId) {
    const lobby = getLobby(lobbyId);
    if (!lobby) return;
    if (lobby.gameState.phase !== 'PLAYING') return;
    if (!lobby.guessQueue) lobby.guessQueue = [];
    if (lobby.guessQueueProcessing) return;
    if (lobby.guessQueue.length === 0) return;

    lobby.guessQueueProcessing = true;
    const item = lobby.guessQueue[0];
    const player = lobby.players.find(p => p.id === item.socketId);
    const playerSocket = io.sockets.sockets.get(item.socketId);
    const queueLen = lobby.guessQueue.length;

    console.log(`[guess_queue] Lobby ${lobbyId} processing (1/${queueLen} FIFO): socket=${item.socketId} query="${item.query}"${player ? ` nickname=${player.nickname}` : ''}`);

    let done = false;
    while (!done) {
        try {
            const res = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(item.query)}&format=json&addressdetails=1&limit=1`, {
                headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' },
                timeout: 15000
            });
            if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
            const data = await res.json();
            if (!data || data.length === 0) {
                if (playerSocket) playerSocket.emit('error', 'Location not found');
                logSlowGuess(lobbyId, item, 'Nominatim returned no results for query.');
                lobby.guessQueue.shift();
                console.log(`[guess_queue] Lobby ${lobbyId} dequeued (user error: not found). Queue length now ${lobby.guessQueue.length}`);
                done = true;
                break;
            }

            const guess = data[0];
            const lat = parseFloat(guess.lat);
            const lon = parseFloat(guess.lon);
            const name = guess.display_name.split(',')[0];
            if (lobby.gameState.guesses.some(g => g.name === name)) {
                if (playerSocket) playerSocket.emit('error', 'Location already guessed!');
                logSlowGuess(lobbyId, item, 'Nominatim responded; duplicate guess.');
                lobby.guessQueue.shift();
                console.log(`[guess_queue] Lobby ${lobbyId} dequeued (user error: duplicate). Queue length now ${lobby.guessQueue.length}`);
                done = true;
                break;
            }

            const countryCode = guess.address?.country_code;
            console.log(`[submit_guess] User ${item.socketId} guessed: ${name} (${lat}, ${lon}). Target: ${lobby.gameState.target.name} (${lobby.gameState.target.lat}, ${lobby.gameState.target.lon})`);
            const dist = calculateHaversineDistance(lat, lon, lobby.gameState.target.lat, lobby.gameState.target.lon);
            const isSameCountry = (countryCode === lobby.gameState.target.countryCode);
            console.log(`[submit_guess] Distance: ${dist.toFixed(2)}km, Same Country: ${isSameCountry}`);

            const thresholds = lobby.settings.hintThresholds || [5, 10, 15, 20, 25];
            const countryThreshold = thresholds[4] != null ? Number(thresholds[4]) : 100;

            lobby.gameState.guesses.push({
                nickname: player ? player.nickname : 'Unknown',
                socketId: item.socketId,
                name, lat, lon, distance: dist, isSameCountry,
                timestamp: Date.now()
            });

            if (lobby.settings.gameMode === 'turn_based') {
                advanceTurn(lobby);
            }

            // Win only on exact place match (same red square / OSM place_id)
            const targetPlaceId = lobby.gameState.target.placeId;
            const isExactMatch = (targetPlaceId != null && guess.place_id != null && String(guess.place_id) === String(targetPlaceId));
            if (isExactMatch) {
                console.log(`[submit_guess] WIN! Exact place match (place_id ${guess.place_id})`);
                lobby.gameState.phase = 'WON';
                lobby.gameState.winnerId = item.socketId;
                lobby.gameState.setterId = item.socketId;
                updateRoundStats(lobby, 'guesser', item.socketId);
                if (lobby.settings.gameMode === 'ffa') {
                    if (!lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
                    if (!lobby.guessCooldownStarted) lobby.guessCooldownStarted = {};
                    const until = Date.now() + 10000;
                    lobby.guessCooldownUntil[item.socketId] = until;
                    lobby.guessCooldownStarted[item.socketId] = Date.now();
                }
                logSlowGuess(lobbyId, item, 'Win: Nominatim + server processing.');
                lobby.guessQueue.shift();
                console.log(`[guess_queue] Lobby ${lobbyId} dequeued (win). Queue length now ${lobby.guessQueue.length}`);
                broadcastState(lobbyId);
                done = true;
                break;
            }

            // Hider victory: setter wins if guess count reaches 1.25× country threshold
            const guessCount = lobby.gameState.guesses.length;
            const hiderWinThreshold = Math.round(1.25 * countryThreshold);
            if (lobby.settings.hiderVictoryEnabled && guessCount >= hiderWinThreshold) {
                console.log(`[submit_guess] HIDER WINS! Survived ${guessCount} guesses (threshold ${hiderWinThreshold})`);
                lobby.gameState.phase = 'HIDER_WON';
                lobby.gameState.winnerId = lobby.gameState.setterId; // setter won
                updateRoundStats(lobby, 'hider', lobby.gameState.setterId);
                lobby.guessQueue.shift();
                broadcastState(lobbyId);
                done = true;
                break;
            }

            // Second image required at 50% of hider victory threshold (default rule, not a powerup)
            const secondImageRequirementAt = Math.round(0.5 * hiderWinThreshold);
            if (!lobby.gameState.secondImageUploadBy && !lobby.gameState.secondImageUrl && guessCount >= secondImageRequirementAt) {
                lobby.gameState.secondImageUploadBy = Date.now() + 60000;
                lobby.gameState.secondImageWarningShown = false;
                lobby.gameState.secondImageLastPenaltyAt = null;
            }

            if (!lobby.gameState.validPolygon) {
                lobby.gameState.validPolygon = turf.polygon([[[-360, 90], [360, 90], [360, -90], [-360, -90], [-360, 90]]]);
            }
            let newPoly = lobby.gameState.validPolygon;
            const gs = lobby.gameState;
            const countryRevealed = gs.hintLabels && gs.hintLabels.country != null && gs.hintLabels.country !== '';

            if (isSameCountry && !countryRevealed) {
                try {
                    const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            let countryFeat = turf.feature(polyData[0].geojson);
                            countryFeat = optimizeGeometry(countryFeat);
                            const intersect = turf.intersect(turf.featureCollection([newPoly, countryFeat]));
                            if (intersect) newPoly = intersect;
                            else newPoly = countryFeat;
                            if (!gs.hintLabels) gs.hintLabels = { hemisphere: null, continent: null, country: null };
                            gs.hintLabels.country = lobby.gameState.target.countryName || (lobby.gameState.target.name && lobby.gameState.target.name.split(',').pop()?.trim()) || '';
                            if (gs.activePowerups && gs.activePowerups.includes(POWERUP_IDS.SNIPING_IMMUNITY)) {
                                gs.snipingImmunityGuesserId = item.socketId;
                                gs.snipingImmunityUntil = Date.now() + 15000;
                            }
                        }
                    }
                } catch (e) { console.error("Country reveal error:", e); }
            } else if (!isSameCountry && countryCode) {
                try {
                    const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            let countryFeat = turf.feature(polyData[0].geojson);
                            countryFeat = optimizeGeometry(countryFeat);
                            const diff = turf.difference(turf.featureCollection([newPoly, countryFeat]));
                            if (diff) newPoly = diff;
                            lobby.gameState.wrongCountries.push(countryCode);
                        }
                    }
                } catch (e) { console.error("Wrong country mask error:", e); }
            }

            const baseScanKm = 250 + (gs.scanZoneBonusKm || 0);
            const distThresholds = [baseScanKm, 100, 50, 20, 10, 5];
            let max_T = 0;
            for (let t of distThresholds) { if (dist > t) { max_T = t; break; } }
            if (max_T > 0) {
                const circle = turf.circle([lon, lat], max_T, { units: 'kilometers', steps: 24 });
                const diff = turf.difference(turf.featureCollection([newPoly, circle]));
                if (diff) newPoly = diff;
            }
            let min_T = Infinity;
            const ascendingThresholds = [...distThresholds].reverse();
            for (let t of ascendingThresholds) { if (dist <= t) { min_T = t; break; } }
            if (min_T !== Infinity) {
                const circle = turf.circle([lon, lat], min_T, { units: 'kilometers', steps: 24 });
                const intersect = turf.intersect(turf.featureCollection([newPoly, circle]));
                if (intersect) newPoly = intersect;
            }

            lobby.gameState.validPolygon = optimizeGeometry(newPoly);

            if (guessCount === thresholds[gs.powerupStage]) {
                if (gs.powerupStage === 4) {
                    if (!gs.hintLabels) gs.hintLabels = { hemisphere: null, continent: null, country: null };
                    gs.hintLabels.country = lobby.gameState.target.countryName || (lobby.gameState.target.name && lobby.gameState.target.name.split(',').pop()?.trim()) || '';
                    const targetCountryCode = (lobby.gameState.target.countryCode || '').toUpperCase();
                    if (targetCountryCode) {
                        try {
                            const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${targetCountryCode}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, {
                                headers: { 'User-Agent': 'GTC-Game/1.0', 'Accept-Language': 'en' }
                            });
                            if (polyRes.ok) {
                                const polyData = await polyRes.json();
                                if (polyData?.[0]?.geojson) {
                                    let countryFeat = turf.feature(polyData[0].geojson);
                                    countryFeat = optimizeGeometry(countryFeat);
                                    const intersect = turf.intersect(turf.featureCollection([lobby.gameState.validPolygon, countryFeat]));
                                    lobby.gameState.validPolygon = intersect ? optimizeGeometry(intersect) : countryFeat;
                                }
                            }
                        } catch (e) { console.error("Country reveal (stage 5) error", e); }
                    }
                    gs.powerupStage = 5;
                } else {
                    const options = drawTwoFromPool(gs.powerupStage, gs);
                    if (options.length > 0) {
                        gs.powerupVote = { options, endAt: Date.now() + 10000, votes: {}, votedBy: {} };
                        lobby.powerupVoteTimer = setTimeout(() => { finishPowerupVote(lobbyId); }, 10000);
                    } else {
                        gs.powerupStage++;
                    }
                }
            }

            if (dist <= 100 && !lobby.gameState.hintCities) {
                console.log(`[submit_guess] Distance <= 100km (${dist.toFixed(2)}km). Fetching hint cities...`);
                const radius = 100000;
                const overpassQuery = `
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
                        method: "POST", body: overpassQuery,
                        headers: { 'User-Agent': 'GTC-Game/1.0' },
                        timeout: 15000
                    });
                    if (hintRes.ok) {
                        const hintData = await hintRes.json();
                        const minPop = lobby.settings.minPop || 5000;
                        lobby.gameState.hintCities = hintData.elements.filter(n => {
                            const pop = parseInt(n.tags?.population?.replace(/,/g, '') || '0', 10);
                            return pop > minPop;
                        }).map(n => ({
                            lat: n.lat || n.center?.lat,
                            lon: n.lon || n.center?.lon,
                            name: n.tags.name,
                            pop: n.tags.population
                        }));
                        console.log(`[submit_guess] Fetched ${lobby.gameState.hintCities.length} hint cities.`);
                    }
                } catch (e) { console.error("[submit_guess] Failed to fetch hint cities:", e); }
            }

            if (lobby.settings.gameMode === 'ffa') {
                if (!lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
                if (!lobby.guessCooldownStarted) lobby.guessCooldownStarted = {};
                const baseMs = isSameCountry ? 10000 : 5000;
                const reductionMs = (lobby.gameState.cooldownReductionSeconds || 0) * 1000;
                const duration = Math.max(0, baseMs - reductionMs);
                lobby.guessCooldownUntil[item.socketId] = Date.now() + duration;
                lobby.guessCooldownStarted[item.socketId] = Date.now();
            }
            logSlowGuess(lobbyId, item, 'Success: Nominatim response time + server processing (powerup/mask/hint cities may add delay).');
            lobby.guessQueue.shift();
            console.log(`[guess_queue] Lobby ${lobbyId} dequeued (success). Queue length now ${lobby.guessQueue.length}`);
            broadcastState(lobbyId);
            done = true;
        } catch (e) {
            console.error(`[guess_queue] API error (retrying same guess in 2s):`, e.message || e);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    lobby.guessQueueProcessing = false;
    setImmediate(() => processGuessQueue(lobbyId));
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

app.post('/upload_second', upload.single('image'), (req, res) => {
    const { lobbyId, socketId } = req.body;
    const lobby = getLobby(lobbyId);
    if (!lobby || !req.file) {
        if (req.file) fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Invalid upload' });
    }
    if (lobby.gameState.setterId !== socketId) {
        fs.unlinkSync(req.file.path);
        return res.status(403).json({ error: 'Not authorized' });
    }
    if (!lobby.gameState.secondImageUploadBy || lobby.gameState.secondImageUrl) {
        fs.unlinkSync(req.file.path);
        return res.status(400).json({ error: 'Second image not available or already uploaded' });
    }
    lobby.gameState.secondImageUrl = '/uploads/' + req.file.filename;
    lobby.lastInteraction = Date.now();
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
        if (finalSettings.hintThresholds) {
            finalSettings.hintThresholds = finalSettings.hintThresholds.slice(0, 5).map(Number);
            while (finalSettings.hintThresholds.length < 5) {
                finalSettings.hintThresholds.push([5, 10, 15, 20, 25][finalSettings.hintThresholds.length]);
            }
        }
        if (finalSettings.minPop) finalSettings.minPop = Number(finalSettings.minPop);
        if (finalSettings.moveTimeLimit) finalSettings.moveTimeLimit = Number(finalSettings.moveTimeLimit);

        lobbies.set(lobbyId, {
            players: [{ id: socket.id, nickname, role: 'setter', score: 0, winsAsSetter: 0, winsAsGuesser: 0, totalGuesses: 0, roundsPlayed: 0 }],
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
            },
            guessQueue: [],
            guessQueueProcessing: false
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

        lobby.players.push({ id: socket.id, nickname, role: 'guesser', score: 0, winsAsSetter: 0, winsAsGuesser: 0, totalGuesses: 0, roundsPlayed: 0 });
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
            
            const overpassOptions = {
                method: "POST",
                body: query,
                headers: { 'User-Agent': 'GTC-Game/1.0' },
                timeout: 15000
            };

            let data;
            try {
                let response = await fetchWithTimeout("https://overpass-api.de/api/interpreter", overpassOptions);
                if (!response.ok && (response.status >= 500 || response.status === 429)) {
                    console.warn(`[set_target] Primary Overpass failed with ${response.status}, trying fallback instance...`);
                    response = await fetchWithTimeout("https://overpass.kumi.systems/api/interpreter", overpassOptions);
                }
                if (!response.ok) throw new Error(`Overpass API error: ${response.status}`);
                data = await response.json();
            } catch (err) {
                console.error(`[set_target] Overpass validation failed:`, err);
                socket.emit('error', 'Location validation service is temporarily unavailable. Please try again in a few seconds or choose a different area.');
                return;
            }
            
            const minPop = lobby.settings.minPop || 5000;
            const validPlaces = data.elements.filter(n => {
                const popStr = n.tags?.population?.replace(/,/g, '') || '0';
                return parseInt(popStr, 10) > minPop;
            });

            if (validPlaces.length === 0) {
                socket.emit('error', `Invalid location: Must be a city/town with >${minPop/1000}k population.`);
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
            const placeLat = placeToUse.lat ?? placeToUse.center?.lat;
            const placeLon = placeToUse.lon ?? placeToUse.center?.lon;
            const placePop = parseInt(String(placeToUse.tags?.population || '0').replace(/,/g, ''), 10);

            // Red-square eligibility: chosen city must be within 100km of click (same radius as lategame hint cities) and pass same pop criteria so it would appear as a red square for seekers
            const distKm = (placeLat != null && placeLon != null) ? calculateHaversineDistance(lat, lon, placeLat, placeLon) : 0;
            if (distKm > 100) {
                socket.emit('error', 'Invalid location: chosen city is too far from the clicked point. Please click closer to a valid city.');
                return;
            }
            if (placePop <= minPop) {
                socket.emit('error', `Invalid location: chosen city does not meet the >${minPop/1000}k population requirement.`);
                return;
            }

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
                countryCode,
                countryName: country || '',
                placeId: geoData.place_id || null
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

    socket.on('submit_guess', ({ lobbyId, query }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.gameState.phase !== 'PLAYING') return;
        if (lobby.gameState.setterId === socket.id) return;

        if (lobby.gameState.powerupVote) {
            socket.emit('error', 'Vote for a powerup first!');
            return;
        }
        if (lobby.gameState.radarPlacementPlayerId === socket.id) {
            socket.emit('error', 'Place your radar pin first!');
            return;
        }
        if (lobby.gameState.snipingImmunityUntil && Date.now() < lobby.gameState.snipingImmunityUntil) {
            if (lobby.gameState.snipingImmunityGuesserId !== socket.id) {
                socket.emit('error', 'Only the player who revealed the country can guess for 15 seconds!');
                return;
            }
        }

        if (lobby.settings.gameMode === 'turn_based') {
            if (lobby.turnState.currentGuesserId !== socket.id) {
                socket.emit('error', 'Not your turn!');
                return;
            }
        }

        lobby.lastInteraction = Date.now();
        if (!lobby.guessQueue) lobby.guessQueue = [];
        if (lobby.guessQueueProcessing === undefined) lobby.guessQueueProcessing = false;

        if (lobby.settings.gameMode === 'ffa') {
            if (!lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
            const until = lobby.guessCooldownUntil[socket.id];
            if (until && Date.now() < until) return;
        }

        lobby.guessQueue.push({ socketId: socket.id, query, enqueuedAt: Date.now() });
        const pos = lobby.guessQueue.length;
        const nickname = (lobby.players.find(p => p.id === socket.id) || {}).nickname || socket.id;
        console.log(`[guess_queue] Lobby ${lobbyId} queued (#${pos} FIFO): socket=${socket.id} nickname=${nickname} query="${query}"`);

        processGuessQueue(lobbyId);
    });

    socket.on('vote_powerup', ({ lobbyId, powerupId }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.gameState.phase !== 'PLAYING' || !lobby.gameState.powerupVote) return;
        if (lobby.gameState.setterId === socket.id) return;
        const vote = lobby.gameState.powerupVote;
        const opt = vote.options.find(o => o.id === powerupId);
        if (!opt) return;
        if (vote.votedBy && vote.votedBy[socket.id] !== undefined) return;
        if (!vote.votes) vote.votes = {};
        if (!vote.votedBy) vote.votedBy = {};
        vote.votes[powerupId] = (vote.votes[powerupId] || 0) + 1;
        vote.votedBy[socket.id] = powerupId;
        broadcastState(lobbyId);
    });

    socket.on('place_radar', ({ lobbyId, lat, lon, radiusKm }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby || lobby.gameState.phase !== 'PLAYING') return;
        if (lobby.gameState.radarPlacementPlayerId !== socket.id) return;
        const gs = lobby.gameState;
        let radius = gs.radarPlacementRadiusKm != null ? gs.radarPlacementRadiusKm : (radiusKm != null ? Math.min(2000, Math.max(50, Number(radiusKm))) : 750);
        if (gs.radarPlacementRadiusKm == null && (radiusKm == null || isNaN(radius))) radius = 750;
        (async () => {
            try {
                const circle = turf.circle([lon, lat], radius, { units: 'kilometers', steps: 32 });
                const poly = gs.validPolygon ? turf.intersect(turf.featureCollection([gs.validPolygon, circle])) : circle;
                if (poly) {
                    gs.radarResultPolygon = poly;
                    gs.radarPlacementPlayerId = null;
                    gs.radarPlacementRadiusKm = null;
                    gs.radarPlacementEndAt = null;
                    broadcastState(lobbyId);
                }
            } catch (e) { console.error('place_radar error', e); }
        })();
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
            lobby.gameState.target = { lat: null, lon: null, name: null, countryCode: null, continent: null, countryName: null, placeId: null };
            lobby.gameState.image = null;
            lobby.gameState.guesses = [];
            lobby.gameState.validPolygon = null;
            lobby.gameState.hintLabels = { hemisphere: null, continent: null, country: null, coastal: null };
            lobby.gameState.powerupStage = 0;
            lobby.gameState.activePowerups = [];
            lobby.gameState.powerupVote = null;
            lobby.gameState.secondImageUploadBy = null;
            lobby.gameState.secondImageUrl = null;
            lobby.gameState.secondImageWarningShown = false;
            lobby.gameState.secondImageLastPenaltyAt = null;
            lobby.gameState.snipingImmunityUntil = null;
            lobby.gameState.snipingImmunityGuesserId = null;
            lobby.gameState.cityNameLetterCount = null;
            lobby.gameState.cityNameRevealedLetters = [];
            lobby.gameState.scanZoneBonusKm = 0;
            lobby.gameState.cooldownReductionSeconds = 0;
            lobby.gameState.radarPlacementPlayerId = null;
            lobby.gameState.radarPlacementRadiusKm = null;
            lobby.gameState.radarPlacementEndAt = null;
            lobby.gameState.radarResultPolygon = null;
            if (lobby.powerupVoteTimer) { clearTimeout(lobby.powerupVoteTimer); lobby.powerupVoteTimer = null; }
            if (lobby.guessQueue) { lobby.guessQueue = []; lobby.guessQueueProcessing = false; }
            if (lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
            if (lobby.guessCooldownStarted) lobby.guessCooldownStarted = {};
            
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
                    lobby.gameState.setterId = lobby.players[0].id;
                    lobby.gameState.phase = 'SETUP_LOC';
                    lobby.gameState.target = { lat: null, lon: null, name: null, countryCode: null, continent: null, countryName: null, placeId: null };
                    lobby.gameState.image = null;
                    lobby.gameState.guesses = [];
                    lobby.gameState.validPolygon = null;
                    lobby.gameState.hintLabels = { hemisphere: null, continent: null, country: null, coastal: null };
                    lobby.gameState.secondImageUploadBy = null;
                    lobby.gameState.secondImageUrl = null;
                    lobby.gameState.secondImageWarningShown = false;
                    lobby.gameState.secondImageLastPenaltyAt = null;
                    lobby.gameState.powerupStage = 0;
                    lobby.gameState.activePowerups = [];
                    lobby.gameState.powerupVote = null;
                    if (lobby.powerupVoteTimer) { clearTimeout(lobby.powerupVoteTimer); lobby.powerupVoteTimer = null; }
                    if (lobby.guessQueue) { lobby.guessQueue = []; lobby.guessQueueProcessing = false; }
                    if (lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
                    if (lobby.guessCooldownStarted) lobby.guessCooldownStarted = {};
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

        // 2b. Radar placement timeout
        if (lobby.gameState.phase === 'PLAYING' && lobby.gameState.radarPlacementEndAt && now > lobby.gameState.radarPlacementEndAt) {
            lobby.gameState.radarPlacementPlayerId = null;
            lobby.gameState.radarPlacementRadiusKm = null;
            lobby.gameState.radarPlacementEndAt = null;
            broadcastState(lobbyId);
        }

        // 2c. Second image (stage 3): warn at 60s, penalty every 15s after 90s
        const gs = lobby.gameState;
        if (lobby.gameState.phase === 'PLAYING' && gs.secondImageUploadBy && !gs.secondImageUrl) {
            if (now >= gs.secondImageUploadBy && !gs.secondImageWarningShown) {
                gs.secondImageWarningShown = true;
                const setterSocket = io.sockets.sockets.get(gs.setterId);
                if (setterSocket) setterSocket.emit('second_image_warning', { message: 'Upload second image in 30s or 1 random country will be removed every 15s.' });
            }
            if (now >= gs.secondImageUploadBy + 30000) {
                const lastPenalty = gs.secondImageLastPenaltyAt || 0;
                if (now - lastPenalty >= 15000) {
                    gs.secondImageLastPenaltyAt = now;
                    (async () => {
                        const targetCode = (lobby.gameState.target.countryCode || '').toUpperCase();
                        let cache = REST_COUNTRIES_CACHE;
                        if (!cache) {
                            try {
                                const restRes = await fetchWithTimeout('https://restcountries.com/v3.1/all?fields=cca2', { headers: { 'User-Agent': 'GTC-Game/1.0' }, timeout: 15000 });
                                if (restRes.ok) { cache = await restRes.json(); REST_COUNTRIES_CACHE = cache; }
                            } catch (e) { console.warn('REST Countries fetch failed', e); }
                        }
                        const allCodes = (cache || []).map(c => (c.cca2 || '').toUpperCase()).filter(Boolean);
                        const wrong = allCodes.filter(c => c !== targetCode && !(gs.wrongCountries || []).includes(c));
                        if (wrong.length > 0) {
                            const code = wrong[Math.floor(Math.random() * wrong.length)];
                            gs.wrongCountries.push(code);
                            try {
                                const polyRes = await fetchWithTimeout(`https://nominatim.openstreetmap.org/search?country=${code}&format=json&polygon_geojson=1&polygon_threshold=0.01&limit=1`, { headers: { 'User-Agent': 'GTC-Game/1.0' }, timeout: 10000 });
                                if (polyRes.ok && gs.validPolygon) {
                                    const polyData = await polyRes.json();
                                    if (polyData?.[0]?.geojson) {
                                        let countryFeat = turf.feature(polyData[0].geojson);
                                        countryFeat = optimizeGeometry(countryFeat);
                                        const diff = turf.difference(turf.featureCollection([gs.validPolygon, countryFeat]));
                                        if (diff) gs.validPolygon = optimizeGeometry(diff);
                                    }
                                }
                            } catch (e) { console.warn('Second image penalty country mask failed', code, e); }
                            const setterSocket = io.sockets.sockets.get(gs.setterId);
                            if (setterSocket) setterSocket.emit('second_image_penalty', { message: '1 random country was removed (second image not uploaded).' });
                            broadcastState(lobbyId);
                        }
                    })();
                }
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
                        lobby.gameState.target = { lat: null, lon: null, name: null, countryCode: null, continent: null, countryName: null, placeId: null };
                        lobby.gameState.image = null;
                        lobby.gameState.guesses = [];
                        lobby.gameState.validPolygon = null;
                        lobby.gameState.hintLabels = { hemisphere: null, continent: null, country: null, coastal: null };
                        lobby.gameState.secondImageUploadBy = null;
                        lobby.gameState.secondImageUrl = null;
                        lobby.gameState.secondImageWarningShown = false;
                        lobby.gameState.secondImageLastPenaltyAt = null;
                        lobby.gameState.powerupStage = 0;
                        lobby.gameState.activePowerups = [];
                        lobby.gameState.powerupVote = null;
                        if (lobby.powerupVoteTimer) { clearTimeout(lobby.powerupVoteTimer); lobby.powerupVoteTimer = null; }
                        if (lobby.guessQueue) { lobby.guessQueue = []; lobby.guessQueueProcessing = false; }
                        if (lobby.guessCooldownUntil) lobby.guessCooldownUntil = {};
                        if (lobby.guessCooldownStarted) lobby.guessCooldownStarted = {};
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