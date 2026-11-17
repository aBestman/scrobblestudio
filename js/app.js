// Scrobble Studio - the dashboard page. Asks engine.js (window.api) for data and draws it.

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString();
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = ["#d51007", "#2f6fdf", "#1db954", "#e8a317", "#8e44ad", "#16a3b8", "#e0559a", "#7a7a7a"];
// api(path, options) comes from engine.js: it answers the old "/api/..." questions inside the browser.

function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}

// Click selection from the top lists (like Power BI cross-filtering).
// kind: "artist" | "track" | "album"; ids: artist name / song key / "artist<US>album"; labels for the pill.
let selection = { kind: null, ids: [], labels: {} };

// Query string with the date filter and the click selection.
// skipKind: the list the selection came from passes its own kind, so it keeps showing everything.
function rangeQuery(extra = {}, skipKind = null) {
  const p = new URLSearchParams();
  if ($("#start").value) p.set("start", $("#start").value);
  if ($("#end").value) p.set("end", $("#end").value);
  if (selection.kind && selection.kind !== skipKind)
    selection.ids.forEach((id) => p.append("sel_" + selection.kind, id));
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}

// ---------------------------------------------------------------- charts
const charts = {};
function drawChart(id, config) {
  charts[id]?.destroy();
  Chart.defaults.color = css("--muted");
  Chart.defaults.borderColor = css("--line");
  Chart.defaults.font.family = "Segoe UI, system-ui, sans-serif";
  charts[id] = new Chart(document.getElementById(id), config);
}

async function loadStats() {
  const s = await api("/api/summary?" + rangeQuery());
  const tiles = [
    [fmt(s.scrobbles), "scrobbles"],
    [fmt(s.artists), "artists"],
    [fmt(s.tracks), "different songs"],
    [fmt(s.albums), "albums"],
    [s.per_day, "plays per day"],
    [s.first ? `${s.first} → ${s.last}` : "–", "period"],
    [s.h_artist, "artist h-index", `${s.h_artist} artists with at least ${s.h_artist} plays each`],
    [s.h_song, "song h-index", `${s.h_song} songs with at least ${s.h_song} plays each`],
    [s.h_album, "album h-index", `${s.h_album} albums with at least ${s.h_album} plays each`],
  ];
  $("#stats").innerHTML = tiles
    .map(([v, l, tip]) => `<div class="stat${tip ? " h" : ""}"${tip ? ` title="${esc(tip)}"` : ""}>
      <div class="v"${l === "period" ? ' style="font-size:15px"' : ""}>${esc(v)}</div><div class="l">${l}</div></div>`)
    .join("");
}

async function loadTimeline() {
  const d = await api("/api/timeline?" + rangeQuery({ by: granularity }));
  const ink = css("--text");
  drawChart("timelineChart", {
    data: {
      labels: d.labels,
      datasets: [
        { type: "bar", label: "Scrobbles", data: d.values, backgroundColor: css("--accent"), borderRadius: 2, yAxisID: "y", order: 2 },
        // Artist h-index per period, on its own scale at the right.
        { type: "line", label: "Artist h-index", data: d.h_artist, borderColor: ink, backgroundColor: ink,
          borderWidth: 2, pointRadius: d.labels.length > 60 ? 0 : 3, yAxisID: "h", order: 1, tension: 0.25 },
      ],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top", align: "end", labels: { boxWidth: 12 } },
        tooltip: {
          callbacks: {
            label: (c) => (c.dataset.yAxisID === "h" ? ` Artist h-index: ${c.raw}` : ` Scrobbles: ${fmt(c.raw)}`),
            footer: (items) => {
              const i = items[0].dataIndex;
              return `Song h-index: ${d.h_song[i]}   ·   Album h-index: ${d.h_album[i]}`;
            },
          },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 16 } },
        y: { beginAtZero: true, title: { display: true, text: "scrobbles" } },
        h: { position: "right", beginAtZero: true, grid: { display: false }, title: { display: true, text: "artist h-index" } },
      },
    },
  });
}

// ---------------------------------------------------------------- top lists (artists / songs / albums)
let topN = 25;
try { topN = Number(localStorage.getItem("topN")) || 25; } catch {}

// A ranked list with a thin bar behind each row showing plays relative to #1.
// Rank the lists by scrobbles or by h-index ("Rank by" switch). The other number is shown in the subtitle.
let rankBy = "plays";
try { rankBy = localStorage.getItem("rankBy") === "h" ? "h" : "plays"; } catch {}
const H_TIPS = {
  artist: (i) => `h-index ${i.h}: ${i.h} songs by this artist with at least ${i.h} plays each`,
  track: (i) => `h-index ${i.h}: played in ${i.h} different months, at least ${i.h} times each`,
  album: (i) => `h-index ${i.h}: ${i.h} songs on this album with at least ${i.h} plays each`,
};

const ID_OF = {
  artist: (i) => i.artist,
  track: (i) => i.key,
  album: (i) => i.artist + "\x1f" + i.album,
};
const LABEL_OF = {
  artist: (i) => i.artist,
  track: (i) => `${i.track} (${i.artist})`,
  album: (i) => `${i.album} (${i.artist})`,
};

function renderRank(el, items, kind, title, sub) {
  const val = (i) => (rankBy === "h" ? i.h : i.plays);
  const max = items.length ? Math.max(...items.map(val), 1) : 1;
  const active = selection.kind === kind;
  el.classList.toggle("has-selection", active);
  el.innerHTML = items
    .map((i) => {
      const id = ID_OF[kind](i);
      const picked = active && selection.ids.includes(id);
      const other = rankBy === "h" ? `${fmt(i.plays)} plays` : `h ${i.h}`;
      const subtitle = [sub ? sub(i) : "", other].filter(Boolean).join(" · ");
      const shown = rankBy === "h" ? `h ${i.h}` : fmt(i.plays);
      return `<li class="${picked ? "picked" : ""}" data-id="${esc(id)}" data-label="${esc(LABEL_OF[kind](i))}"
        style="--w:${((100 * val(i)) / max).toFixed(1)}%" title="${esc(H_TIPS[kind](i))}&#10;Click to filter, Ctrl+click to add">
        <span class="p">${shown}</span><span class="t">${esc(title(i))}</span><span class="a">${esc(subtitle)}</span></li>`;
    })
    .join("") || "<li>No plays in this period.</li>";
}

async function loadTopArtists() {
  const d = await api("/api/top?" + rangeQuery({ kind: "artist", limit: topN, rank: rankBy }, "artist"));
  renderRank($("#artistList"), d.items, "artist", (i) => i.artist,
    (i) => `${fmt(i.songs)} ${i.songs === 1 ? "song" : "songs"}`);
  $("#artistOptions").innerHTML = d.items.map((i) => `<option value="${esc(i.artist)}">`).join("");
}

async function loadTopTracks() {
  const d = await api("/api/top?" + rangeQuery({ kind: "track", limit: topN, rank: rankBy }, "track"));
  renderRank($("#trackList"), d.items, "track", (i) => i.track, (i) => i.artist);
}

async function loadTopAlbums() {
  const d = await api("/api/top?" + rangeQuery({ kind: "album", limit: topN, rank: rankBy }, "album"));
  renderRank($("#albumList"), d.items, "album", (i) => i.album, (i) => i.artist);
}

// ---------------------------------------------------------------- click selection (cross-filter)
// Click: filter to that item (click again to clear). Ctrl/Cmd+click: add or remove items of the same list.
function select(kind, id, label, add) {
  const same = selection.kind === kind;
  if (add) {
    if (!same) selection = { kind, ids: [], labels: {} };
    const at = selection.ids.indexOf(id);
    if (at >= 0) selection.ids.splice(at, 1);
    else { selection.ids.push(id); selection.labels[id] = label; }
    if (!selection.ids.length) selection.kind = null;
  } else if (same && selection.ids.length === 1 && selection.ids[0] === id) {
    selection = { kind: null, ids: [], labels: {} };
  } else {
    selection = { kind, ids: [id], labels: { [id]: label } };
  }
  showSelection();
  loadAll();
}

function clearSelection() {
  if (!selection.kind) return;
  selection = { kind: null, ids: [], labels: {} };
  showSelection();
  loadAll();
}

function showSelection() {
  const pill = $("#selectionPill");
  if (!selection.kind) { pill.hidden = true; return; }
  const names = selection.ids.map((id) => selection.labels[id] || id);
  const shown = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  $("#selectionText").textContent = shown;
  pill.title = names.join("\n");
  pill.hidden = false;
}

[["artist", "#artistList"], ["track", "#trackList"], ["album", "#albumList"]].forEach(([kind, sel]) =>
  $(sel).addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) select(kind, li.dataset.id, li.dataset.label, e.ctrlKey || e.metaKey);
  })
);
$("#selectionClear").addEventListener("click", clearSelection);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.target.closest?.("input, select, textarea")) clearSelection();
});

function markRankBy() {
  $$("#rankBy button").forEach((b) => b.classList.toggle("active", b.dataset.rank === rankBy));
}
$$("#rankBy button").forEach((b) =>
  b.addEventListener("click", () => {
    rankBy = b.dataset.rank;
    try { localStorage.setItem("rankBy", rankBy); } catch {}
    markRankBy();
    loadTopArtists(); loadTopTracks(); loadTopAlbums();
  })
);
markRankBy();

function markTopN() {
  document.querySelectorAll("#topN button").forEach((b) => b.classList.toggle("active", Number(b.dataset.n) === topN));
}
document.querySelectorAll("#topN button").forEach((b) =>
  b.addEventListener("click", () => {
    topN = Number(b.dataset.n);
    try { localStorage.setItem("topN", topN); } catch {}
    markTopN();
    loadTopArtists(); loadTopTracks(); loadTopAlbums();
  })
);
markTopN();

async function loadClock() {
  const { grid } = await api("/api/clock?" + rangeQuery());
  const max = Math.max(1, ...grid.flat());
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  let html = "<span></span>";
  for (let h = 0; h < 24; h++) html += `<span class="hr">${h % 3 === 0 ? h : ""}</span>`;
  grid.forEach((row, d) => {
    html += `<span class="lab">${days[d]}</span>`;
    row.forEach((n, h) => {
      const opacity = n === 0 ? 0.04 : 0.12 + 0.88 * (n / max);
      html += `<span class="cell" style="opacity:${opacity.toFixed(2)}" title="${days[d]} ${h}:00 – ${fmt(n)} plays"></span>`;
    });
  });
  $("#clock").innerHTML = html;
}

// Top artists over time, using the same year / month / day setting as "Scrobbles over time".
// How many artists (lines) to show: 1-25, remembered between visits.
function artistLines() {
  const el = $("#artistLines");
  const n = Math.min(25, Math.max(1, Math.round(Number(el.value) || 8)));
  el.value = n;
  return n;
}
try { const saved = localStorage.getItem("artistLines"); if (saved) $("#artistLines").value = saved; } catch {}
let linesTimer;
$("#artistLines").addEventListener("input", () => {
  clearTimeout(linesTimer);
  linesTimer = setTimeout(() => {
    try { localStorage.setItem("artistLines", artistLines()); } catch {}
    loadYears();
  }, 400);
});

// Colours: the fixed palette first, then evenly spread hues for line 9 and up.
const lineColor = (i) => (i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.5) % 360)}, 55%, 50%)`);

async function loadYears() {
  const by = granularity;
  const n = artistLines();
  $("#yearsTitle").textContent = `Your top ${n === 1 ? "artist" : n + " artists"} per ${by}`;
  const d = await api("/api/artists-over-time?" + rangeQuery({ by, n }));
  const many = d.series.length > 15;      // with lots of lines: no legend, tooltip shows only the line you hover
  drawChart("yearsChart", {
    type: "line",
    data: {
      labels: d.labels,
      datasets: d.series.map((s, i) => ({
        label: s.artist, data: s.values, borderColor: lineColor(i), backgroundColor: lineColor(i),
        cubicInterpolationMode: "monotone",
        pointRadius: d.labels.length > 60 || many ? 0 : 2, borderWidth: many ? 1.5 : 2,
      })),
    },
    options: {
      maintainAspectRatio: false,
      interaction: many ? { mode: "nearest", intersect: false } : { mode: "index", intersect: false },
      plugins: {
        legend: { display: !many, position: "bottom" },
        tooltip: { itemSort: (a, b) => b.raw - a.raw, filter: (item) => item.raw > 0 },
      },
      scales: { y: { beginAtZero: true }, x: { grid: { display: false }, ticks: { maxTicksLimit: 16 } } },
    },
  });
}

async function loadRecent() {
  const { items } = await api("/api/recent?limit=25");
  const today = iso(new Date());
  const yesterday = iso(new Date(Date.now() - 86400000));
  let lastDay = null;
  let html = "";
  for (const i of items) {
    const day = i.time.slice(0, 10);
    if (day !== lastDay) {
      const label = day === today ? "Today" : day === yesterday ? "Yesterday"
        : new Date(day + "T12:00").toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric" });
      html += `<li class="day">${esc(label)}</li>`;
      lastDay = day;
    }
    html += `<li title="${esc(i.album)}"><span class="w" style="float:right">${esc(i.time.slice(11))}</span>
      <span class="t">${esc(i.track)}</span><span class="a">${esc(i.artist)}</span></li>`;
  }
  $("#recentList").innerHTML = html || "<li>No scrobbles yet.</li>";
  $("#recentCount").textContent = items.length ? `last ${items.length}` : "";
}

async function loadAll() {
  const jobs = [loadRecent, loadStats, loadTimeline, loadTopArtists, loadTopTracks, loadTopAlbums, loadClock, loadYears];
  const results = await Promise.allSettled(jobs.map((j) => j()));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) toast("Something went wrong loading a chart: " + failed.reason.message, 8000);
}

// ---------------------------------------------------------------- date filter
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function rangeStart(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBack = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  switch (range) {
    case "year":  return `${now.getFullYear()}-01-01`;
    case "month": return iso(new Date(now.getFullYear(), now.getMonth(), 1));
    case "week":  return daysBack((today.getDay() + 6) % 7);   // back to Monday
    case "365d":  return daysBack(364);                        // today counts as day 1
    case "30d":   return daysBack(29);
    case "7d":    return daysBack(6);
    default:      return "";                                   // all time
  }
}
function markChip(active) {
  $$(".chip").forEach((c) => c.classList.toggle("active", c === active));
}
// Chart granularity ("Charts show per year / month / day" in the top bar). Not a filter.
let granularity = "year";
function setGranularity(by) {
  granularity = by;
  $$("#timeBy button").forEach((b) => b.classList.toggle("active", b.dataset.by === by));
}

// Pick a sensible chart granularity for the chosen period:
// all time -> per year, a year-ish period -> per month, anything shorter -> per day.
// You can still change it in the dropdown; it resets when you change the period.
function autoGranularity(range) {
  if (range === "all") return "year";
  if (range === "year" || range === "365d") return "month";
  if (range) return "day";
  const start = $("#start").value, end = $("#end").value || iso(new Date());   // own dates: go by length
  if (!start) return "year";
  const days = (new Date(end) - new Date(start)) / 86400000;
  return days > 400 ? "year" : days > 62 ? "month" : "day";
}

$$(".chip").forEach((chip) =>
  chip.addEventListener("click", () => {
    $("#start").value = rangeStart(chip.dataset.range);
    $("#end").value = "";
    markChip(chip);
    setGranularity(autoGranularity(chip.dataset.range));
    loadAll();
  })
);
// Picking your own dates un-highlights the quick buttons.
function ownDates() {
  markChip(null);
  setGranularity(autoGranularity(null));
  loadAll();
}
$("#start").addEventListener("change", ownDates);
$("#end").addEventListener("change", ownDates);
$$("#timeBy button").forEach((b) =>
  b.addEventListener("click", () => { setGranularity(b.dataset.by); loadTimeline(); loadYears(); })
);
setGranularity(autoGranularity("all"));

// ---------------------------------------------------------------- update buttons
// "What's new": red if the data wasn't loaded today, green if it was.
// "Full reload": always grey; rebuilds the whole history.
const newBtn = $("#newBtn");
const fullBtn = $("#fullBtn");

// Green "Up to date" when your newest scrobble matches Last.fm's newest one; red "What's new" otherwise.
let lastStatus = {};
function paintNewButton(s) {
  lastStatus = s;
  if (newBtn.disabled) return;                       // an update is running; leave its progress text alone
  newBtn.classList.remove("grey");                   // grey only while the first check runs
  newBtn.classList.toggle("fresh", !!s.fresh);
  newBtn.classList.toggle("stale", !s.fresh);
  newBtn.textContent = s.fresh ? "Up to date" : "What's new";
  newBtn.title = s.checked_with === "lastfm"
    ? `Newest on Last.fm: ${s.lastfm_newest}\nNewest here: ${s.local_newest}`
    : `Couldn't reach Last.fm. Last loaded: ${s.last_load || "never"}`;
}

function resetButtons() {
  newBtn.disabled = fullBtn.disabled = false;
  fullBtn.textContent = "Full reload";
  paintNewButton(lastStatus);
}

// Re-check against Last.fm every 5 minutes, so the button turns red when you've listened to new music.
setInterval(() => {
  if (!newBtn.disabled) api("/api/refresh/status").then(paintNewButton).catch(() => {});
}, 5 * 60 * 1000);

async function followUpdate(s) {
  newBtn.disabled = fullBtn.disabled = true;
  const btn = s.mode === "full" ? fullBtn : newBtn;
  btn.textContent = "Contacting Last.fm…";
  try {
    while (s.running) {
      await new Promise((r) => setTimeout(r, 1000));
      s = await api("/api/refresh/status");
      if (s.pages) btn.textContent = `Page ${fmt(s.page)} of ${fmt(s.pages)}…`;
    }
    if (s.error) throw new Error(s.error);
    toast(s.mode === "full"
      ? `Full reload done: ${fmt(s.total)} scrobbles (${s.added >= 0 ? "+" : ""}${fmt(s.added)} compared to before).`
      : `${fmt(s.added)} new scrobbles added (total ${fmt(s.total)}).`, 6000);
    await loadAll();
  } catch (e) {
    toast("Update failed: " + e.message, 10000);
  } finally {
    resetButtons();
    paintNewButton(await api("/api/refresh/status").catch(() => ({})));
  }
}

newBtn.addEventListener("click", async () => {
  try { followUpdate(await api("/api/refresh", { method: "POST" })); }
  catch (e) { toast(e.message, 8000); }
});

fullBtn.addEventListener("click", async () => {
  const ok = confirm(
    "Full reload downloads your entire Last.fm history again and rebuilds your data on this device.\n\n" +
    "With 120,000+ scrobbles (about 600 pages) this takes roughly 25 minutes. Keep this page open (and on a phone, the screen on). " +
    "Your current data is kept as a backup.\n\nStart?"
  );
  if (!ok) return;
  try { followUpdate(await api("/api/refresh?mode=full", { method: "POST" })); }
  catch (e) { toast(e.message, 8000); }
});

// On page load: colour the button, and pick up an update that's already running.
api("/api/refresh/status").then((s) => {
  paintNewButton(s);
  if (s.running) followUpdate(s);
}).catch(() => {});

// ---------------------------------------------------------------- spotify status
async function loadSpotify() {
  const el = $("#spotifyStatus");
  try {
    const s = await api("/api/spotify/status");
    if (!s.configured) el.innerHTML = 'Spotify: <a href="settings.html">set up in Settings</a>';
    else if (!s.connected) {
      el.innerHTML = '<a href="#" id="spLogin">Connect Spotify</a>';
      $("#spLogin").addEventListener("click", (e) => { e.preventDefault(); Studio.spotifyLogin().catch((x) => toast(x.message, 8000)); });
    }
    else el.innerHTML = `Spotify: connected as <b>${esc(s.user)}</b>`;
  } catch {
    el.textContent = "Spotify: status unknown";
  }
}

// ---------------------------------------------------------------- playlist maker
let kind = "top";
let playlist = [];

$$(".tab").forEach((tab) =>
  tab.addEventListener("click", () => {
    kind = tab.dataset.kind;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
    $$(".param-group").forEach((g) => (g.hidden = g.dataset.for !== kind));
  })
);

$("#loadTags").addEventListener("click", async () => {
  const btn = $("#loadTags");
  btn.disabled = true;
  btn.textContent = "Looking up genres…";
  try {
    const { tags } = await api("/api/tags");
    $("#tagOptions").innerHTML = tags.map((t) => `<option value="${esc(t)}">`).join("");
    toast(`Found ${tags.length} genres. Click the Genre box to pick one.`);
  } catch (e) {
    toast("Could not load genres: " + e.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Suggest genres from my artists";
  }
});

function renderPlaylist() {
  $("#plList").innerHTML = playlist
    .map((t, i) => `<li><button class="x" title="Remove" data-i="${i}">×</button><span class="p">${fmt(t.plays)} plays</span>
      <span class="t">${esc(t.track)}</span><br><span class="a">${esc(t.artist)}</span>${t.note ? ` <span class="n">· ${esc(t.note)}</span>` : ""}</li>`)
    .join("") || "<li>No songs matched. Try different settings.</li>";
}
$("#plList").addEventListener("click", (e) => {
  if (!e.target.matches(".x")) return;
  playlist.splice(Number(e.target.dataset.i), 1);
  renderPlaylist();
});

$("#previewBtn").addEventListener("click", async () => {
  const params = { kind, limit: $("#limit").value };
  if (kind === "forgotten") Object.assign(params, { min_plays: $("#minPlays").value, months: $("#months").value });
  if (kind === "artists") params.artists = $("#artistInput").value;
  if (kind === "genre") params.tag = $("#tagInput").value;
  if (kind === "onthisday") params.window = $("#window").value;
  if (kind === "weather") {
    Object.assign(params, {
      cond: $("#wCond").value, scope: $("#wScope").value, sort: $("#wSort").value,
      tmin: $("#wTmin").value, tmax: $("#wTmax").value,
      months: [...document.querySelectorAll("#wMonths input:checked")].map((c) => c.value).join(","),
    });
  }
  const query = kind === "top" || kind === "weather" ? rangeQuery(params) : new URLSearchParams(params).toString();

  const btn = $("#previewBtn");
  btn.disabled = true;
  btn.textContent = kind === "genre" ? "Working (can take a minute the first time)…" : "Working…";
  try {
    const d = await api("/api/playlist?" + query);
    playlist = d.tracks;
    $("#plName").value = d.name;
    $("#plName").dataset.description = d.description;
    $("#createMsg").textContent = "";
    $("#createMsg").className = "msg";
    $("#preview").hidden = false;
    renderPlaylist();
  } catch (e) {
    toast(e.message, 8000);
  } finally {
    btn.disabled = false;
    btn.textContent = "Preview playlist";
  }
});

$("#createBtn").addEventListener("click", async () => {
  const btn = $("#createBtn");
  const msg = $("#createMsg");
  btn.disabled = true;
  btn.textContent = "Finding songs on Spotify…";
  msg.className = "msg";
  msg.textContent = `Searching Spotify for ${playlist.length} songs. This takes a few seconds per 10 songs.`;
  try {
    const r = await api("/api/spotify/create", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: $("#plName").value, description: $("#plName").dataset.description || "", tracks: playlist }),
    });
    msg.innerHTML = `Done! Added ${r.added} songs. <a href="${esc(r.url)}" target="_blank">Open in Spotify</a>` +
      (r.missing.length ? `<br><span class="hint">Not found on Spotify (${r.missing.length}): ${r.missing.map(esc).join("; ")}</span>` : "");
  } catch (e) {
    msg.className = "msg err";
    msg.textContent = e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = "Create on Spotify";
  }
});

// ---------------------------------------------------------------- start
(async () => {
  // Coming back from the Spotify login page? Finish logging in first.
  try { await Studio.spotifyCallback(); } catch (e) { toast(e.message, 8000); }
  // No data on this device yet: point to Settings.
  const info = await api("/api/data/info");
  $("#welcome").hidden = info.scrobbles > 0;
  loadAll();
  loadSpotify();
})();

// Offline support / "install as app" (only works when served over https or 127.0.0.1).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
