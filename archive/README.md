# Archive: h-index UI and the separate Trends page

These files are **not loaded by the app**. They're kept so the features can be brought back easily.

| What | Where |
|---|---|
| Full app exactly as it was | git tag `archive/h-index-and-trends` (`git checkout archive/h-index-and-trends`) |
| Old dashboard script with all h-index UI | `app-with-h-index.js` |
| Old page layout (Scrobbles + Trends pages, h-index tiles, "By h-index" switch) | `index-with-trends.html` |
| Old Trends page script (A → B comparison, h-index before/after tiles) | `trends.js` |

## The h-index logic is still in the engine

`js/engine.js` still contains, unchanged and working:

- `hIndex(counts)` – h-index of one list of play counts
- `hBy(rows, groupOf, itemOf)` – h-index per group (per artist over songs, per period over artists, …)
- `hOverall(rows)` – artist / song / album h-index of a set of scrobbles (returned by `/api/summary` as `h_artist`, `h_song`, `h_album`)
- `/api/top?rank=h` – top lists ranked by h-index (each item has `h`)
- `/api/timeline` – returns `h_artist`, `h_song`, `h_album` per period
- `/api/trends` – the old A → B comparison (including `h_was` / `h_now`)

## To bring the h-index back on screen

1. From `app-with-h-index.js`, copy back:
   - the three h-index tiles in `loadStats()`
   - the "Artist h-index" line dataset and the right-hand `h` axis in `loadTimeline()`
   - `rankBy`, `H_TIPS`, `markRankBy()` and the `#rankBy` buttons
2. From `index-with-trends.html`, copy back the `#rankBy` "By scrobbles / By h-index" switch.
3. The `.stat.h` styles are still in `style.css`.
