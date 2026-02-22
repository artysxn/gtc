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
        "img-src 'self' data: blob: https://*.openstreetmap.org https://images.unsplash.com https://unpkg.com; " + // Added https://unpkg.com here
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

// --- Game State Storage ---
// lobbies[lobbyId] = { players: [], gameState: { ... } }
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
            myRole: isSetter ? 'setter' : 'guesser'
        };

        socket.emit('game_state_update', sanitizedState);
    });
}

function calculateHaversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371; 
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon/2) * Math.sin(dLon/2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
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
    
    // Initialize polygon if needed
    if (!lobby.gameState.validPolygon) {
        lobby.gameState.validPolygon = turf.polygon([[[-360, 90], [360, 90], [360, -90], [-360, -90], [-360, 90]]]);
    }

    broadcastState(lobbyId);
    res.json({ success: true });
});

// --- Socket.IO Logic ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('create_lobby', ({ nickname }) => {
        const lobbyId = generateLobbyId();
        lobbies.set(lobbyId, {
            players: [{ id: socket.id, nickname, role: 'setter', score: 0 }],
            gameState: JSON.parse(JSON.stringify(INITIAL_GAME_STATE))
        });
        
        socket.join(lobbyId);
        socket.emit('lobby_created', { lobbyId });
        
        // Auto-assign setter for fresh lobby
        const lobby = lobbies.get(lobbyId);
        lobby.gameState.setterId = socket.id;
        
        broadcastState(lobbyId);
    });

    socket.on('join_lobby', ({ lobbyId, nickname }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby) {
            socket.emit('error', 'Lobby not found');
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

    socket.on('start_game', ({ lobbyId }) => {
        const lobby = lobbies.get(lobbyId);
        if (!lobby) return;

        // Capture the winner (who is now the setter) BEFORE resetting state
        const nextSetterId = lobby.gameState.setterId;

        // Reset state
        lobby.gameState = JSON.parse(JSON.stringify(INITIAL_GAME_STATE));
        lobby.gameState.phase = 'SETUP_LOC';
        
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
            const response = await fetch("https://overpass-api.de/api/interpreter", {
                method: "POST", body: query,
                headers: { 'User-Agent': 'GTC-Game/1.0' }
            });
            if (!response.ok) throw new Error(`Overpass API error: ${response.status}`);
            const data = await response.json();
            
            const validPlace = data.elements.find(n => {
                const popStr = n.tags?.population?.replace(/,/g, '') || '0';
                return parseInt(popStr, 10) > 5000;
            });

            if (!validPlace) {
                // Fallback: If no population tag, accept if it's a city/town node
                // This is lenient for testing but keeps some validation
                const anyPlace = data.elements.find(n => n.tags && (n.tags.place === 'city' || n.tags.place === 'town'));
                if (!anyPlace) {
                    socket.emit('error', 'Invalid location: Must be near a city/town > 5k pop');
                    return;
                }
                // Use the fallback place
                // validPlace = anyPlace; // Can't reassign const
            }
            
            const placeToUse = validPlace || data.elements.find(n => n.tags && (n.tags.place === 'city' || n.tags.place === 'town'));

            if (!placeToUse) {
                 console.error(`[set_target] Validation failed: No city/town found near ${lat}, ${lon}`);
                 socket.emit('error', 'Invalid location: Must be near a city/town');
                 return;
            }

            console.log(`[set_target] Valid location found: ${placeToUse.tags.name || 'Unknown'}`);

            // Reverse geocode for name
            const nominatimRes = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&addressdetails=1&zoom=10`, {
                headers: { 'User-Agent': 'GTC-Game/1.0' }
            });
            if (!nominatimRes.ok) throw new Error(`Nominatim API error: ${nominatimRes.status}`);
            const geoData = await nominatimRes.json();
            
            const name = placeToUse.tags.name || geoData.address.city || geoData.address.town || geoData.name;
            const countryCode = geoData.address.country_code;

            lobby.gameState.target = { 
                lat, lon, 
                name: `${name}, ${geoData.address.country}`, 
                countryCode 
            };

            // Fetch continent
            try {
                const restRes = await fetch(`https://restcountries.com/v3.1/alpha/${countryCode}`, {
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

        try {
            // Geocode
            const res = await fetch(`https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&addressdetails=1&limit=1`, {
                headers: { 'User-Agent': 'GTC-Game/1.0' }
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
            const countryCode = guess.address?.country_code;

            console.log(`[submit_guess] User ${socket.id} guessed: ${name} (${lat}, ${lon}). Target: ${lobby.gameState.target.name} (${lobby.gameState.target.lat}, ${lobby.gameState.target.lon})`);

            const dist = calculateHaversineDistance(lat, lon, lobby.gameState.target.lat, lobby.gameState.target.lon);
            const isSameCountry = (countryCode === lobby.gameState.target.countryCode);
            
            console.log(`[submit_guess] Distance: ${dist.toFixed(2)}km, Same Country: ${isSameCountry}`);
            
            const player = lobby.players.find(p => p.id === socket.id);
            
            // Update State
            lobby.gameState.guesses.push({
                nickname: player.nickname,
                name, lat, lon, distance: dist, isSameCountry
            });
            lobby.gameState.guesses.sort((a, b) => a.distance - b.distance);

            // Win Condition
            if (dist <= 5) {
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

            // Country Logic
            if (isSameCountry && !lobby.gameState.hints.country) {
                // Reveal Country Logic (Simplified for server: fetch geojson)
                // Note: Fetching heavy geojson on every guess might be slow. 
                // For MVP, we'll mark it revealed and let clients fetch mask or fetch here.
                // Better: Fetch here and update polygon.
                try {
                    const polyRes = await fetch(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            const countryFeat = turf.feature(polyData[0].geojson);
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
                    const polyRes = await fetch(`https://nominatim.openstreetmap.org/search?country=${countryCode}&format=json&polygon_geojson=1&limit=1`, {
                        headers: { 'User-Agent': 'GTC-Game/1.0' }
                    });
                    if (polyRes.ok) {
                        const polyData = await polyRes.json();
                        if (polyData?.[0]?.geojson) {
                            const countryFeat = turf.feature(polyData[0].geojson);
                            const diff = turf.difference(turf.featureCollection([newPoly, countryFeat]));
                            if (diff) newPoly = diff;
                            lobby.gameState.wrongCountries.push(countryCode);
                        }
                    }
                } catch(e) { console.error("Wrong country mask error:", e); }
            }

            // Distance Rings
            const thresholds = [250, 100, 50, 20, 10, 5];
            let max_T = 0;
            for (let t of thresholds) { if (dist > t) { max_T = t; break; } }
            
            if (max_T > 0) {
                const circle = turf.circle([lon, lat], max_T, {units: 'kilometers', steps: 32});
                const diff = turf.difference(turf.featureCollection([newPoly, circle]));
                if (diff) newPoly = diff;
            }

            let min_T = Infinity;
            const ascendingThresholds = [...thresholds].reverse();
            for (let t of ascendingThresholds) { if (dist <= t) { min_T = t; break; } }

            if (min_T !== Infinity) {
                const circle = turf.circle([lon, lat], min_T, {units: 'kilometers', steps: 32});
                const intersect = turf.intersect(turf.featureCollection([newPoly, circle]));
                if (intersect) newPoly = intersect;
            }

            lobby.gameState.validPolygon = newPoly;

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
                    const hintRes = await fetch("https://overpass-api.de/api/interpreter", {
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

    socket.on('disconnect', () => {
        // Find lobby player was in
        for (const [lobbyId, lobby] of lobbies.entries()) {
            const index = lobby.players.findIndex(p => p.id === socket.id);
            if (index !== -1) {
                const wasSetter = lobby.gameState.setterId === socket.id;
                lobby.players.splice(index, 1);
                
                if (lobby.players.length === 0) {
                    lobbies.delete(lobbyId);
                } else {
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
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});