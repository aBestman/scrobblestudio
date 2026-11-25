// Scrobble Studio - the pages. Asks engine.js (window.api) for data and draws it.
// (The h-index UI and the old Trends page are archived in /archive; the engine still has the logic.)

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString();
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const PALETTE = ["#d51007", "#2f6fdf", "#1db954", "#e8a317", "#8e44ad", "#16a3b8", "#e0559a", "#7a7a7a"];
// api(path, options) comes from engine.js: it answers the old "/api/..." questions inside the browser.

// Clean play / pause / restart icons for the players (Bar race, Deep Dive).
const ICONS = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>',
  restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4.5h4.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};
function setPlayIcon(btn, playing) {
  btn.innerHTML = playing ? ICONS.pause : ICONS.play;
  btn.setAttribute("aria-label", playing ? "Pause" : "Play");
  btn.title = playing ? "Pause" : "Play";
}

// A time slider is "being dragged" from its first input until the finger / mouse lets go. On phones the
// "change" event doesn't always come (e.g. touch the slider, then scroll), so also let go on these.
function onScrubRelease(el, fn) {
  for (const ev of ["change", "pointerup", "pointercancel", "touchend", "touchcancel", "blur"]) el.addEventListener(ev, fn, { passive: true });
}

function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- backdrop + insight
// Backdrop = the big picture (totals and lists). Insight = a shorter recent period inside it;
// what it added shows as green +N. The insight is always at least one level smaller.
const LEVEL = { today: 0, week: 1, "7d": 1, month: 2, "30d": 2, year: 3, "365d": 3, all: 4 };
const PERIOD_LABEL = {
  all: "All time", year: "This year", "365d": "Last 365 days", month: "This month", "30d": "Last 30 days",
  week: "This week", "7d": "Last 7 days", today: "Today",
};
// Every time the app opens: backdrop "This year", insight "This week" (changes last until you close it).
const view = { b: "year", a: "week" };

function syncPanel() {
  $("#backdrop").value = view.b;
  [...$("#insight").options].forEach((o) => (o.disabled = LEVEL[o.value] >= LEVEL[view.b]));
  $("#insight").value = view.a;
  $("#panelSummary").textContent = `${PERIOD_LABEL[view.b]} · + ${PERIOD_LABEL[view.a].toLowerCase()}`;
}
function viewChanged(backdropChanged) {
  syncPanel();
  if (backdropChanged) setGranularity(autoGranularity());
  loadAll();
}
$("#backdrop").addEventListener("change", (e) => {
  view.b = e.target.value;
  if (LEVEL[view.a] >= LEVEL[view.b]) view.a = "today";        // keep the insight smaller than the backdrop
  viewChanged(true);
});
$("#insight").addEventListener("change", (e) => { view.a = e.target.value; viewChanged(false); });
// Phones: the panel folds into one summary line; tap to open.
$("#panelToggle").addEventListener("click", () => {
  const open = $(".panel").classList.toggle("open");
  $("#panelToggle").setAttribute("aria-expanded", String(open));
});

// Click selection from the top lists (like Power BI cross-filtering).
// kind: "artist" | "track" | "album"; ids: artist name / song key / "artist<US>album"; labels for the pill.
let selection = { kind: null, ids: [], labels: {} };
function addSelection(p, skipKind) {
  if (selection.kind && selection.kind !== skipKind) selection.ids.forEach((id) => p.append("sel_" + selection.kind, id));
}
// For the backdrop/insight answers (cards and lists).
function viewQuery(extra = {}, skipKind = null) {
  const p = new URLSearchParams({ b: view.b, a: view.a });
  addSelection(p, skipKind);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
// For the date-based charts (timeline, artists over time, listening clock): the backdrop period.
function rangeQuery(extra = {}, skipKind = null) {
  const p = new URLSearchParams();
  const start = rangeStart(view.b);
  if (start) p.set("start", start);
  addSelection(p, skipKind);
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

// ---------------------------------------------------------------- collapsible groups (Cards, Lists, Graphs, Recent scrobbles)
// Which groups you closed is remembered on this device.
let closedGroups = [];
try { closedGroups = JSON.parse(localStorage.getItem("ss-closed-groups") || "[]"); } catch {}
$$("details.group").forEach((g) => {
  if (closedGroups.includes(g.dataset.group)) g.open = false;
  g.addEventListener("toggle", () => {
    closedGroups = $$("details.group").filter((x) => !x.open).map((x) => x.dataset.group);
    try { localStorage.setItem("ss-closed-groups", JSON.stringify(closedGroups)); } catch {}
    // Charts drawn while hidden have no size; fit them when the group opens again.
    if (g.open) Object.values(charts).forEach((c) => c.resize());
  });
});

// ---------------------------------------------------------------- cards
const plus = (n) => `<span class="plus${n ? "" : " zero"}">+${fmt(n)}</span>`;
async function loadStats() {
  const s = await api("/api/overview?" + viewQuery());
  const A = s.insight.label, B = s.backdrop.label;
  $("#ovTitle").textContent = PERIOD_LABEL[view.b];
  $("#ovHint").innerHTML = `${plus(1).replace("+1", "+N")} = what ${esc(A)} added`;
  $("#listsTitle").textContent = view.b === "all" ? "All-time top" : `Top of ${B}`;
  // extra: ready-made HTML after the value (e.g. a +N or a signed change)
  const tile = (value, label, extra, tip) => `<div class="stat"${tip ? ` title="${esc(tip)}"` : ""}>
    <div class="v">${value}${extra ? " " + extra : ""}</div><div class="l">${label}</div></div>`;
  // A change that can go both ways: green +0.4, red −0.4, grey ±0
  const signed = (n) => (n === null || n === 0 ? '<span class="plus zero">±0</span>'
    : n > 0 ? `<span class="plus">+${n}</span>` : `<span class="plus minus">−${Math.abs(n)}</span>`);
  const hNow = s.h_now, hWas = s.h_was;
  const hPart = (label, k) => `${label} ${hNow[k]}${hNow[k] > hWas[k] ? ` <span class="plus">+${hNow[k] - hWas[k]}</span>` : ""}`;
  $("#stats").innerHTML = [
    tile(fmt(s.scrobbles.total), "scrobbles", plus(s.scrobbles.added), `${fmt(s.scrobbles.added)} of them ${A}`),
    tile(fmt(s.artists.total), "artists", plus(s.artists.added), `${fmt(s.artists.added)} artists new to ${B}`),
    tile(fmt(s.songs.total), "different songs", plus(s.songs.added), `${fmt(s.songs.added)} songs new to ${B}`),
    tile(fmt(s.albums.total), "albums", plus(s.albums.added), `${fmt(s.albums.added)} albums new to ${B}`),
    tile(s.per_day, `plays per day · ${esc(A)}: ${s.insight_per_day}`, signed(s.per_day_change),
      `Average per day for ${B}; the change is how ${A} moved that average`),
    tile(hNow.h_artist, `artist h-index · ${hPart("songs", "h_song")} · ${hPart("albums", "h_album")}`,
      hNow.h_artist > hWas.h_artist ? plus(hNow.h_artist - hWas.h_artist) : "",
      `h-index: ${hNow.h_artist} artists with at least ${hNow.h_artist} plays each in ${B}. +N = raised by ${A}.`),
  ].join("");
  // First-time discoveries: a separate row, a little apart from the totals
  $("#stats2").innerHTML = [
    tile(fmt(s.new_songs), `first-time songs ${esc(A)}`, "", "Songs you played for the very first time ever"),
    tile(fmt(s.new_artists), `first-time artists ${esc(A)}`, "", "Artists you played for the very first time ever"),
  ].join("");
}

// ---------------------------------------------------------------- timeline
// "Year" shows every year you have (ignores the backdrop); "month" and "day" follow the backdrop.
// The click selection from the lists always applies.
function chartQuery(extra = {}) {
  if (granularity !== "year") return rangeQuery(extra);
  const p = new URLSearchParams();
  addSelection(p, null);
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p.toString();
}
let cumulative = false;
try { cumulative = localStorage.getItem("ss-cumulative") === "1"; } catch {}
$("#cumulative").checked = cumulative;
$("#cumulative").addEventListener("change", (e) => {
  cumulative = e.target.checked;
  try { localStorage.setItem("ss-cumulative", cumulative ? "1" : "0"); } catch {}
  loadTimeline();
  loadYears();
});
const runningTotal = (values) => { let s = 0; return values.map((v) => (s += v)); };
const periodWord = () => (granularity === "year" ? "year (all years)" : granularity);

async function loadTimeline() {
  const d = await api("/api/timeline?" + chartQuery({ by: granularity }));
  $("#timelineTitle").textContent = cumulative ? `Scrobbles, running total per ${periodWord()}` : `Scrobbles per ${periodWord()}`;
  const accent = css("--accent");
  drawChart("timelineChart", {
    type: cumulative ? "line" : "bar",
    data: {
      labels: d.labels,
      datasets: [{
        label: "Scrobbles", data: cumulative ? runningTotal(d.values) : d.values,
        backgroundColor: cumulative ? accent + "33" : accent, borderColor: accent, borderRadius: 2,
        fill: cumulative, pointRadius: 0, borderWidth: 2, tension: 0.2,
      }],
    },
    options: {
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => ` ${fmt(c.raw)} scrobbles` } } },
      scales: { x: { grid: { display: false }, ticks: { maxTicksLimit: 16 } }, y: { beginAtZero: true } },
    },
  });
}

// ---------------------------------------------------------------- top lists: backdrop chart + what the insight changed
const topN = 100;                      // lists always hold the top 100 (they scroll; on phones: first 10 + "Show all")
let listSort = "chart";
try { listSort = localStorage.getItem("ss-listsort") === "climb" ? "climb" : "chart"; } catch {}

const LABEL_OF = {
  artist: (i) => i.artist,
  track: (i) => `${i.track} (${i.artist})`,
  album: (i) => `${i.album} (${i.artist})`,
};
function moveBadge(i) {
  if (i.was === null) return '<span class="mv new" title="New in this chart">NEW</span>';
  const d = i.was - i.rank;
  if (d > 0) return `<span class="mv up" title="Up ${d} place${d === 1 ? "" : "s"} (was #${i.was})">▲${d}</span>`;
  if (d < 0) return `<span class="mv down" title="Down ${-d} place${d === -1 ? "" : "s"} (was #${i.was})">▼${-d}</span>`;
  return "";
}

function renderMovers(listEl, droppedEl, d, kind, title, sub) {
  const A = d.insight;
  let items = d.items.slice();
  if (listSort === "climb") {
    const score = (i) => (i.was === null ? 1e6 - i.rank : i.was - i.rank);
    items.sort((x, y) => score(y) - score(x) || x.rank - y.rank);
  }
  const max = Math.max(1, ...items.map((i) => i.plays));
  const active = selection.kind === kind;
  listEl.classList.toggle("has-selection", active);
  listEl.innerHTML = items.map((i) => {
    const picked = active && selection.ids.includes(i.id);
    const subtitle = [sub ? sub(i) : "", i.was !== null && i.was !== i.rank ? `was #${i.was}` : ""].filter(Boolean).join(" · ");
    const tip = `${fmt(i.plays)} plays, ${fmt(i.added)} of them ${A}\nClick to filter, Ctrl+click to add, hold for its Deep Dive`;
    return `<li value="${i.rank}" class="${picked ? "picked" : ""}" data-id="${esc(i.id)}" data-label="${esc(LABEL_OF[kind](i))}"
      style="--w:${((100 * i.plays) / max).toFixed(1)}%;--g:${i.plays ? ((100 * i.added) / i.plays).toFixed(1) : 0}%" title="${esc(tip)}">
      <span class="p"><b>${fmt(i.plays)}</b>${i.added ? `<span class="plus">+${fmt(i.added)}</span>` : ""}${moveBadge(i)}</span>
      <span class="t">${esc(title(i))}</span><span class="a">${esc(subtitle)}</span></li>`;
  }).join("") || "<li>No plays in this period.</li>";
  renderListSize(listEl);
  droppedEl.innerHTML = d.dropped.length
    ? `<span class="hint">Pushed out of the top ${d.n} by ${esc(A)}:</span> ` +
      d.dropped.map((i) => `<span class="drop">${esc(title(i))} <span class="hint">#${i.was} → #${i.rank}</span></span>`).join(", ")
    : "";
}
async function loadTopArtists() {
  const d = await api("/api/movers?" + viewQuery({ kind: "artist", n: topN }, "artist"));
  renderMovers($("#artistList"), $("#artistDropped"), d, "artist", (i) => i.artist, (i) => `${fmt(i.songs)} ${i.songs === 1 ? "song" : "songs"}`);
}
async function loadTopTracks() {
  const d = await api("/api/movers?" + viewQuery({ kind: "track", n: topN }, "track"));
  renderMovers($("#trackList"), $("#trackDropped"), d, "track", (i) => i.track, (i) => i.artist);
}
async function loadTopAlbums() {
  const d = await api("/api/movers?" + viewQuery({ kind: "album", n: topN }, "album"));
  renderMovers($("#albumList"), $("#albumDropped"), d, "album", (i) => i.album, (i) => i.artist);
}
const loadLists = () => Promise.all([loadTopArtists(), loadTopTracks(), loadTopAlbums()]);

function markListControls() {
  $$("#listSort button").forEach((b) => b.classList.toggle("active", b.dataset.sort === listSort));
}
// Each list shows its top 50 first; two buttons switch to the other sizes (10 or 100).
function renderListSize(listEl) {
  const box = document.querySelector(`.list-size[data-list="${listEl.id}"]`);
  const now = Number(listEl.dataset.show), rows = listEl.children.length;
  // Folded (top 10): only "Show top 50". From 50 on: fold options, plus 100 when there are more rows.
  const options = now === 10 ? [50] : [10, 50, 100].filter((n) => n < now || (n > now && rows > now));
  box.innerHTML = options.filter((n) => n < now || rows > now)
    .map((n) => `<button type="button" data-show="${n}">${n < now ? "Fold to" : "Show"} top ${n}</button>`).join("");
}
$$(".list-size").forEach((box) => box.addEventListener("click", (e) => {
  const b = e.target.closest("button[data-show]");
  if (!b) return;
  const list = document.getElementById(box.dataset.list);
  const folding = Number(b.dataset.show) < Number(list.dataset.show);
  list.dataset.show = b.dataset.show;
  renderListSize(list);
  if (folding) list.closest(".card").scrollIntoView({ block: "nearest", behavior: "smooth" });
}));
$$("#listSort button").forEach((b) => b.addEventListener("click", () => {
  listSort = b.dataset.sort;
  try { localStorage.setItem("ss-listsort", listSort); } catch {}
  markListControls();
  loadLists();
}));
markListControls();

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
  $("#selectionText").textContent = names.length > 3 ? `${names.slice(0, 3).join(", ")} +${names.length - 3}` : names.join(", ");
  pill.title = names.join("\n");
  pill.hidden = false;
}
// Tap/click = filter (Ctrl/Cmd+click adds to it). Hold ~½ s = open its Deep Dive.
// onHold(list, selector, fn): calls fn(item) on a long press and swallows the click that follows it.
function onHold(list, selector, fn) {
  let timer = 0, start = null, fired = false;
  const cancel = () => { clearTimeout(timer); timer = 0; };
  list.addEventListener("pointerdown", (e) => {
    const li = e.target.closest(selector);
    if (!li || e.button > 0) return;
    fired = false; start = { x: e.clientX, y: e.clientY };
    cancel();
    timer = setTimeout(() => { fired = true; timer = 0; navigator.vibrate?.(15); fn(li); }, 500);
  });
  list.addEventListener("pointermove", (e) => { if (timer && start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
  ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => list.addEventListener(ev, cancel));
  list.addEventListener("click", (e) => { if (fired) { fired = false; e.stopImmediatePropagation(); e.preventDefault(); } }, true);
  list.addEventListener("contextmenu", (e) => { if (e.target.closest(selector)) e.preventDefault(); });   // phones: no menu on hold
}
const DIVE_KIND = { artist: "artist", track: "song", album: "album" };
[["artist", "#artistList"], ["track", "#trackList"], ["album", "#albumList"]].forEach(([kind, sel]) => {
  $(sel).addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (!li) return;
    select(kind, li.dataset.id, li.dataset.label, e.ctrlKey || e.metaKey);
  });
  onHold($(sel), "li[data-id]", (li) => openDive(DIVE_KIND[kind], li.dataset.id));
});
$("#selectionClear").addEventListener("click", clearSelection);
// Deep Dive address: #song=<song key>&a=<artist>&b=<album>&k=<artist|song|album> (the song, its artist and its
// album, so you can swipe between them). openDive looks up the other two first.
const songKey = (artist, track) => artist.trim().toLowerCase() + "\x1f" + track.trim().toLowerCase();
const diveHash = (trio, kind) => "#song=" + encodeURIComponent(trio.song) + "&a=" + encodeURIComponent(trio.artist)
  + (trio.album ? "&b=" + encodeURIComponent(trio.album) : "") + (kind && kind !== "song" ? "&k=" + kind : "");
async function openDive(kind, key) {
  try {
    const info = await api("/api/song?" + new URLSearchParams({ kind, key }));
    location.hash = diveHash(info.links, kind);
  } catch (e) { toast(e.message, 6000); }
}
function openSong(key) { openDive("song", key); }
$("#recentList").addEventListener("click", (e) => {
  const li = e.target.closest("li[data-key]");
  if (li) select("track", li.dataset.key, li.dataset.label, e.ctrlKey || e.metaKey);
});
onHold($("#recentList"), "li[data-key]", (li) => openDive("song", li.dataset.key));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !e.target.closest?.("input, select, textarea")) clearSelection();
});

// ---------------------------------------------------------------- listening clock
// Phone held upright: days across, hours down (easier to read). Otherwise: hours across, days down.
const portraitPhone = matchMedia("(max-width: 700px) and (orientation: portrait)");
let clockGrid = null;
async function loadClock() {
  clockGrid = (await api("/api/clock?" + rangeQuery())).grid;
  renderClock();
}
function renderClock() {
  const grid = clockGrid;
  if (!grid) return;
  const max = Math.max(1, ...grid.flat());
  const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
  const cell = (d, h) => {
    const n = grid[d][h];
    const opacity = n === 0 ? 0.04 : 0.12 + 0.88 * (n / max);
    return `<span class="cell" style="opacity:${opacity.toFixed(2)}" title="${days[d]} ${h}:00 – ${fmt(n)} plays"></span>`;
  };
  const vertical = portraitPhone.matches;
  let html = "<span></span>";
  if (vertical) {
    days.forEach((d) => (html += `<span class="hr">${d.slice(0, 2)}</span>`));
    for (let h = 0; h < 24; h++) {
      html += `<span class="lab">${h % 3 === 0 ? `${h}:00` : ""}</span>`;
      for (let d = 0; d < 7; d++) html += cell(d, h);
    }
  } else {
    for (let h = 0; h < 24; h++) html += `<span class="hr">${h % 3 === 0 ? h : ""}</span>`;
    for (let d = 0; d < 7; d++) {
      html += `<span class="lab">${days[d]}</span>`;
      for (let h = 0; h < 24; h++) html += cell(d, h);
    }
  }
  $("#clock").classList.toggle("vertical", vertical);
  $("#clock").innerHTML = html;
}
portraitPhone.addEventListener("change", renderClock);

// ---------------------------------------------------------------- top artists over time
// How many artists (lines) to show: 1-25, remembered between visits.
function artistLines() {
  const el = $("#artistLines");
  if (el.value.trim() === "") return 8;                 // empty while typing: draw 8, but leave the field empty
  const n = Math.min(25, Math.max(1, Math.round(Number(el.value) || 8)));
  if (String(n) !== el.value) el.value = n;
  return n;
}
try { const saved = localStorage.getItem("artistLines"); if (saved) $("#artistLines").value = saved; } catch {}
let linesTimer;
$("#artistLines").addEventListener("input", () => {
  clearTimeout(linesTimer);
  linesTimer = setTimeout(() => {
    if ($("#artistLines").value.trim() !== "") { try { localStorage.setItem("artistLines", artistLines()); } catch {} }
    loadYears();
  }, 400);
});
// Colours: the fixed palette first, then evenly spread hues for line 9 and up.
const lineColor = (i) => (i < PALETTE.length ? PALETTE[i] : `hsl(${Math.round((i * 137.5) % 360)}, 55%, 50%)`);

async function loadYears() {
  const by = granularity;
  const n = artistLines();
  $("#yearsTitle").textContent = `Your top ${n === 1 ? "artist" : n + " artists"}${cumulative ? ", running total" : ""} per ${periodWord()}`;
  const d = await api("/api/artists-over-time?" + chartQuery({ by, n }));
  if (cumulative) d.series.forEach((s) => (s.values = runningTotal(s.values)));
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

// ---------------------------------------------------------------- recent scrobbles (sidebar)
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
    html += `<li class="link" data-key="${esc(songKey(i.artist, i.track))}" data-label="${esc(`${i.track} (${i.artist})`)}" title="${esc(i.album)} · click to filter on this song, hold for its Deep Dive"><span class="w" style="float:right">${esc(i.time.slice(11))}</span>
      <span class="t">${esc(i.track)}</span><span class="a">${esc(i.artist)}</span></li>`;
  }
  $("#recentList").innerHTML = html || "<li>No scrobbles yet.</li>";
  // (clicks are handled once on the list, further down: tap = filter on the song, hold = Deep Dive)
  $("#recentCount").textContent = items.length ? `last ${items.length}` : "";
}

async function loadAll() {
  const jobs = [loadRecent, loadStats, loadTimeline, loadTopArtists, loadTopTracks, loadTopAlbums, loadClock, loadYears];
  const results = await Promise.allSettled(jobs.map((j) => j()));
  const failed = results.find((r) => r.status === "rejected");
  if (failed) toast("Something went wrong loading a chart: " + failed.reason.message, 8000);
}

// ---------------------------------------------------------------- dates and chart granularity
function iso(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function rangeStart(range) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysBack = (n) => iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
  switch (range) {
    case "today": return iso(today);
    case "year":  return `${now.getFullYear()}-01-01`;
    case "month": return iso(new Date(now.getFullYear(), now.getMonth(), 1));
    case "week":  return daysBack((today.getDay() + 6) % 7);   // back to Monday
    case "365d":  return daysBack(364);                        // today counts as day 1
    case "30d":   return daysBack(29);
    case "7d":    return daysBack(6);
    default:      return "";                                   // all time
  }
}
// Chart granularity ("Charts show per year / month / day"). Not a filter.
let granularity = "year";
function setGranularity(by) {
  granularity = by;
  $$("#timeBy button").forEach((b) => b.classList.toggle("active", b.dataset.by === by));
}
// all time -> per year, a year-ish backdrop -> per month, anything shorter -> per day.
function autoGranularity() {
  if (view.b === "all") return "year";
  if (view.b === "year" || view.b === "365d") return "month";
  return "day";
}
$$("#timeBy button").forEach((b) =>
  b.addEventListener("click", () => { setGranularity(b.dataset.by); loadTimeline(); loadYears(); })
);
syncPanel();
setGranularity(autoGranularity());

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
    // The update itself worked; a problem redrawing the page is reported separately.
    try { await refreshPage(); }
    catch (e) { toast(`Scrobbles updated, but this page couldn't redraw (${e.message}). Reload the page.`, 10000); }
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

// On page load: colour the button, pick up an update that's already running, and otherwise fetch your
// new scrobbles straight away when Last.fm has newer ones than this device.
api("/api/refresh/status").then(async (s) => {
  paintNewButton(s);
  if (s.running) { followUpdate(s); return; }
  if (s.checked_with === "lastfm" && !s.fresh) {
    try { followUpdate(await api("/api/refresh", { method: "POST" })); } catch (e) { toast(e.message, 8000); }
  }
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
    .map((t, i) => `<li><button class="x" title="Remove" data-i="${i}">×</button><span class="p">${t.pct != null ? `${t.pct}%` : `${fmt(t.plays)} plays`}</span>
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
  if (kind === "obsession") Object.assign(params, { days: $("#obDays").value, pct: $("#obPct").value, min_plays: $("#obMin").value });
  if (kind === "weather") {
    Object.assign(params, {
      cond: $("#wCond").value, scope: $("#wScope").value, sort: $("#wSort").value,
      tmin: $("#wTmin").value, tmax: $("#wTmax").value,
      months: [...document.querySelectorAll("#wMonths input:checked")].map((c) => c.value).join(","),
    });
  }
  // Top tracks, Weather and Obsession finder use Playlist Studio's own period (not the Scrobbles page filters).
  if (kind === "top" || kind === "weather" || kind === "obsession") {
    if ($("#plStart").value) params.start = $("#plStart").value;
    if ($("#plEnd").value) params.end = $("#plEnd").value;
  }
  const query = new URLSearchParams(params).toString();

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
    if (d.found > playlist.length) toast(`${fmt(d.found)} songs qualify; showing the top ${playlist.length}. Raise "Number of songs" for more.`, 6000);
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

// ---------------------------------------------------------------- Playlist Studio period
$("#plRange").addEventListener("change", () => {
  const r = $("#plRange").value;
  if (r === "custom") return;
  $("#plStart").value = rangeStart(r);
  $("#plEnd").value = "";
});
["#plStart", "#plEnd"].forEach((s) => $(s).addEventListener("change", () => ($("#plRange").value = "custom")));

async function loadPlaylistsPage() {
  // Suggestions for the "Artist deep-dive" box: your top 100 artists of all time.
  if (!$("#artistOptions").children.length) {
    const d = await api("/api/top?kind=artist&limit=100");
    $("#artistOptions").innerHTML = d.items.map((i) => `<option value="${esc(i.artist)}">`).join("");
  }
}

// ---------------------------------------------------------------- pages (#scrobbles, #trends, #playlists)
const PAGES = { scrobbles: "", song: "· Deep Dive", lab: "· Song visual test", race: "· Bar race", playlists: "· Playlist Studio" };
let currentPage = null;

function pageFromHash() {
  const p = location.hash.slice(1).split("=")[0];          // "#song=<key>" -> "song"
  if (p === "trends") return "scrobbles";               // Trends was merged into Scrobbles
  if (p === "lab" && !window.showLab) return "scrobbles"; // experimental: only when switched on in Settings
  return p in PAGES ? p : "scrobbles";
}
async function refreshPage() {
  api("/api/data/info").then((i) => ($("#welcome").hidden = i.scrobbles > 0)).catch(() => {});
  if (currentPage === "scrobbles") return loadAll();
  if (currentPage === "race") return window.loadRace?.();
  if (currentPage === "song") return window.loadSong?.();
  if (currentPage === "lab") return window.loadLab?.();
  if (currentPage === "playlists") return loadPlaylistsPage();
}
function showPage() {
  currentPage = pageFromHash();
  document.querySelectorAll(".page[data-page], .filters[data-page]").forEach((el) => (el.hidden = el.dataset.page !== currentPage));
  $("#pageTitle").textContent = PAGES[currentPage];
  document.title = currentPage === "scrobbles" ? "Scrobble Studio" : `${PAGES[currentPage].slice(2)} · Scrobble Studio`;
  window.scrollTo(0, 0);
  refreshPage().catch((e) => toast(e.message, 8000));
}
window.addEventListener("hashchange", showPage);

// ---------------------------------------------------------------- start
(async () => {
  // Coming back from the Spotify login page? Finish logging in first.
  try { await Studio.spotifyCallback(); } catch (e) { toast(e.message, 8000); }
  // No data on this device yet: point to Settings.
  const info = await api("/api/data/info");
  $("#welcome").hidden = info.scrobbles > 0;
  showPage();
  loadSpotify();
})();

// Offline support / "install as app" (only works when served over https or 127.0.0.1).
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});

// Collapsible group headers stick just below the top bar; keep its (changing) height in --stick.
new ResizeObserver(([e]) => document.documentElement.style.setProperty("--stick", e.target.offsetHeight + "px"))
  .observe(document.querySelector(".sticky-top"));
