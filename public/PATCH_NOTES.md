# Patch Notes

## v1.4.1

- **Win condition**: Only the **exact location** (same OSM place) counts as a win. Guessing a nearby city (e.g. 1 km away) no longer wins; you must guess the same place the setter chose (matched by Nominatim `place_id`). Rules text updated to "First to guess the exact location (same place) wins!"
- **REST Countries fix**: Continent hint no longer fails with 400; the API now uses the required `?fields=cca2,continents` query for the `/all` endpoint.
- **Guess cooldown (FFA)**: No more "please wait X seconds" toast. The guess button shows cooldown state: disabled with a countdown (e.g. "5s") and an animated green progress bar that fills until you can guess again. Placeholder stays "Type or click map..." during cooldown.
- **Hint bar**: After each hint unlocks, the bar shows the **actual** value (e.g. NORTHERN, EUROPE, NORWAY) instead of the generic "Hemisphere", "Continent", "Country". Locked slots still show the threshold number and label.
- **Hint progress bar**: The three segments now fill by **percentage** toward each threshold (animated, synced to guess count).
- **Zoom to country**: When the country hint is revealed (by server at 90 guesses or same-country guess), the map zooms to fit the revealed country.
- **Setter UI**: Removed "Current Guesses: N". The setter now sees **Location: &lt;name&gt;** (the name of the place they set) under "You are the Setter."

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
