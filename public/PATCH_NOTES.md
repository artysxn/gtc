# Patch Notes

## v1.6.3

- **Terminology**: "Setter" is now **Hider** and "Guesser(s)" is now **Seeker(s)** throughout the app (roles, UI, scoreboard, patch notes).
- **Overpass 429/504**: If the eligible-cities request is rate-limited (429) or times out (504), the app shows a message and automatically retries once after 2s using a fallback Overpass server. If it still fails, a clear message is shown and existing red squares are kept. Debounce and cooldown reduce request volume.
- **Hider: one request per click**: The hider can place a marker by clicking anywhere on the map. One Overpass request finds the **closest** eligible city (within 20 km); one red square is shown at that city and the target is set there. Search only zooms the map; no bulk city loading. This reduces Overpass usage to a single request per placement.

## v1.6.2

- **Hider: lock location by clicking a red square**: Typing a city in hider search only zooms the map and shows eligible cities (red squares). To lock the target, the hider must **click a red square** on the map. Clicking elsewhere shows a reminder. Red squares use the same population rules as the game; panning/zooming in setup (zoom ≥ 10) loads red squares for the visible area.
- **Stop waiting button**: As a seeker, if your guess has been loading for 10 seconds or more, a **Stop waiting** button appears and a “Guess is taking longer than usual” toast is shown so you can cancel the loading state and guess again (the previous guess may still complete on the server).
- **Powerup vote**: When all seekers have voted, the 10 second countdown is skipped and the winning powerup is applied immediately.

## v1.6.1

- **Hint thresholds from lobby**: In-game stage bar and labels (P1 @5, Country @30, etc.) now always use the lobby’s configured hint thresholds from settings; no more wrong defaults (e.g. 20–40–60–80). Settings are merged from the server on every game state update.
- **Hider victory default**: Hider victory is now **on by default** when creating a lobby (checkbox checked).
- **Guess “Loading” fix**: Server now broadcasts state after “not found” or “duplicate” so the client clears the loading state. Client has a 3s safety timeout and clears loading + shows a toast if a guess isn’t processed in time.
- **Hider place name before confirm**: When setting a location, the hider sees the **resolved place name** (from Nominatim) before confirming. Same click + type-to-search flow as seekers; the chosen place’s **place_id** is sent so wins match the same OSM place when a seeker guesses it.
- **Second image at stage**: Lobby setting “Second image required at” lets you choose **Stage 2**, **Stage 3**, or **Stage 4** (default Stage 3). The hider must upload the second image when guess count reaches that stage’s threshold.
- **Guess logging**: Server logs every guess when **received** (RECEIVED), and again when **processed** (PROCESSED with outcome). If a guess is not processed within 3 seconds, the server logs why (queue backlog or Nominatim/API delay).

## v1.6.0

- **Powerup voting system**: Replaced the old 3 fixed hints (hemisphere/continent/country) with 5 stages. At stages 1–4, the server draws 2 powerups from a pool; seekers vote for 10 seconds via animated cards on the map; the winner is applied to all. Stage 5 always reveals the country (no vote). You must vote (or wait for the timer) before guessing again when a stage unlocks.
- **Lobby settings**: Create lobby now has 5 inputs for when each stage triggers (Stage 1–4 powerups and Country reveal), with defaults 20, 40, 60, 80, 100 guesses.
- **Powerup effects**: Remove 4/5 random countries, increase scan zone (+10/15/75/100 km, stacks), lower guess cooldown (−1 s, stacks), sniping immunity (only the seeker who revealed the country can guess for 15 s), reveal letter count and 1/2 random letters, reveal hemisphere, 750 km or custom-size radar (random player places pin), and automatic country reveal at stage 5.
- **Radar**: When a radar powerup wins, a random seeker is chosen to place a pin on the map; the server returns the scan area and it is shown as a green overlay. Custom radar lets the placer choose radius (client sends radius; 750 km radar uses a fixed radius).
- **City name hint**: Powerups can reveal the number of letters in the city name and then reveal 1 or 2 random letters; shown as "City name: _ _ _ _ _" in the lower-left of the map.
- **Continent hint removed**: The old continent hint (which could load forever) is removed; hemisphere and country are now only revealed via powerups or stage 5.
- **Play font**: All text on the site now uses the Play font.
- **Powerup vote UI**: Vote cards fade in once (no flashing); countdown shows 10–9–8… above the cards; vote counts update in place without re-animating.
- **Radar placement pins**: Radar and other placeable items appear as clickable pins in the bottom-left of the map; click a pin then click the map to place it.
- **Guess cooldown visibility**: During cooldown the Guess button is replaced by a countdown number (e.g. 5, 4, 3…) that updates every second; the input stays disabled.
- **Slow guess logging**: If a guess takes 3s or more to register, the server logs a reason (e.g. Nominatim no results, duplicate, or processing delay) and the client logs possible causes (queue backlog, API, network, server processing).
- **Second image (default)**: When 50% of the allowed guesses (to hider victory) have been used, the hider must upload a second image within 60s (then 30s warning, then 1 random country removed every 15s until uploaded). This is always on; it is no longer a stage-3 powerup.
- **Stage 4 – Coastal or landlocked**: New powerup option: "Coastal or landlocked?" reveals whether the **country** of the city is coastal or landlocked; shown in the Hints line with other powerup hints.
- **Red square click to guess**: Seekers can click the red hint (city) squares on the map to submit that city name as a guess instead of typing or clicking near them.
- **Hider victory**: New lobby setting "Hider victory (hider wins at 1.25× country threshold)". When enabled, if the hider survives until guess count reaches 1.25× the country-reveal threshold (e.g. 50 if country is at 40), the hider wins and the round ends.
- **Scoreboard (Tab)**: The Tab player list now shows a per-lobby scoreboard: each player’s wins as hider and as seeker (count and %), total wins, this round’s guess count, total guesses, and rounds played.
- **Lobby presets**: Create lobby has **Casual** (default) and **Competitive** presets. Casual: stages 5/10/15/20/25, FFA. Competitive: stages 20/35/50/65/80, Turn Based. Default stage inputs and game mode follow the selected preset.

## v1.4.1

- **Win condition**: Only the **exact location** (same OSM place) counts as a win. Guessing a nearby city (e.g. 1 km away) no longer wins; you must guess the same place the hider chose (matched by Nominatim `place_id`). Rules text updated to "First to guess the exact location (same place) wins!"
- **REST Countries fix**: Continent hint no longer fails with 400; the API now uses the required `?fields=cca2,continents` query for the `/all` endpoint.
- **Guess cooldown (FFA)**: No more "please wait X seconds" toast. The guess button shows cooldown state: disabled with a countdown (e.g. "5s") and an animated green progress bar that fills until you can guess again. Placeholder stays "Type or click map..." during cooldown.
- **Hint bar**: After each hint unlocks, the bar shows the **actual** value (e.g. NORTHERN, EUROPE, NORWAY) instead of the generic "Hemisphere", "Continent", "Country". Locked slots still show the threshold number and label.
- **Hint progress bar**: The three segments now fill by **percentage** toward each threshold (animated, synced to guess count).
- **Zoom to country**: When the country hint is revealed (by server at 90 guesses or same-country guess), the map zooms to fit the revealed country.
- **Hider UI**: Removed "Current Guesses: N". The hider now sees **Location: &lt;name&gt;** (the name of the place they set) under "You are the Hider."
- **Changelog formatting**: Patch notes modal now renders Markdown (headings, bold, lists) instead of plain text.

## v1.4.0

- **Version & patch notes**: In-game version label is now visible (bottom-left), does not overlap other UI, and is clickable to open patch notes. Patch notes are loaded from `PATCH_NOTES.md`.
- **Changelog rule**: Added Cursor rule so code changes are appended to this file; entries are never removed (cleared manually on release commit).
- **FFA guess cooldown**: In free-for-all mode, after each guess you must wait 5 seconds before guessing again; if the guess was in the correct country, the cooldown is 10 seconds. Cooldown is enforced server-side; the client disables the guess button until the cooldown ends (v1.4.1 replaced the countdown text with a button animation).
- **Set target vs red squares**: Location validation when setting the city now uses the same criteria as lategame red-square (hint) cities. Hint cities use the lobby’s minPop threshold (no longer hardcoded 5000). Before confirming the target, the server checks that the chosen city is within 100km of the click and passes the same population rule so it would appear as a red square for seekers—preventing mismatches between “valid to set” and “can appear as red square.”
- **Guess queue (FIFO)**: Guesses are queued per lobby and processed one at a time in order. If an API (Nominatim, Overpass, etc.) fails, the same guess is retried every 2s until it succeeds; no other guess is processed until the current one completes. Queue is visible in server logs.
- **Guess input preserved**: Typing in the guess field is no longer cleared when another player submits a guess; draft and focus are restored after each game state update.
- **Player list overlay**: Close button and backdrop click to close; Tab still opens/closes the overlay.
- **Overpass validation**: Longer timeout, fallback Overpass instance, and clearer error message when location validation is temporarily unavailable.
- **Continent hint**: Uses target city’s country and REST Countries to determine continent; masks the map to show only countries in that continent (with overrides for Russia, Turkey, Kazakhstan, etc.).
- **Country hint**: When unlocked (e.g. at 90 guesses), blacks out all countries except the target country (same behavior as a correct-country guess).
