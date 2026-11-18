// Trends page: how a short period (A) changed the chart of a longer one (B).
// Uses helpers from app.js ($, esc, fmt, css, drawChart, toast).

const TREND_OPTIONS = [
  ["today", "Today"], ["week", "This week"], ["month", "This month"], ["year", "This year"],
  ["7d", "Last 7 days"], ["30d", "Last 30 days"], ["365d", "Last 365 days"],
];
const trend = { a: "today", b: "week", n: 25, sort: "chart" };          // default: today vs this week
try { Object.assign(trend, JSON.parse(localStorage.getItem("ss-trend") || "{}")); } catch {}
const saveTrend = () => { try { localStorage.setItem("ss-trend", JSON.stringify(trend)); } catch {} };
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

["#trendA", "#trendB"].forEach((sel) => {
  $(sel).innerHTML = TREND_OPTIONS.map(([v, l]) => `<option value="${v}">${l}</option>`).join("");
});
function markTrendControls() {
  $("#trendA").value = trend.a;
  $("#trendB").value = trend.b;
  $$("#trendN button").forEach((b) => b.classList.toggle("active", Number(b.dataset.n) === trend.n));
  $$("#trendSort button").forEach((b) => b.classList.toggle("active", b.dataset.sort === trend.sort));
}
const changed = () => { saveTrend(); markTrendControls(); loadTrends().catch((e) => toast(e.message, 8000)); };
$("#trendA").addEventListener("change", (e) => { trend.a = e.target.value; changed(); });
$("#trendB").addEventListener("change", (e) => { trend.b = e.target.value; changed(); });
$("#trendSwap").addEventListener("click", () => { [trend.a, trend.b] = [trend.b, trend.a]; changed(); });
$$("#trendN button").forEach((b) => b.addEventListener("click", () => { trend.n = Number(b.dataset.n); changed(); }));
$$("#trendSort button").forEach((b) => b.addEventListener("click", () => { trend.sort = b.dataset.sort; saveTrend(); markTrendControls(); renderMovers(); }));
markTrendControls();

let lastTrend = null;

function moveBadge(i) {
  if (i.was === null) return '<span class="mv new" title="Not in this chart before">NEW</span>';
  const d = i.was - i.rank;
  if (d > 0) return `<span class="mv up" title="Up ${d} place${d === 1 ? "" : "s"}">▲ ${d}</span>`;
  if (d < 0) return `<span class="mv down" title="Down ${-d} place${d === -1 ? "" : "s"}">▼ ${-d}</span>`;
  return '<span class="mv same" title="Same place">=</span>';
}

function renderList(data, listSel, droppedSel, title, sub) {
  const R = lastTrend.recent.label;
  let items = data.items.slice();
  if (trend.sort === "climb") {
    const score = (i) => (i.was === null ? 1e6 - i.rank : i.was - i.rank);
    items.sort((x, y) => score(y) - score(x) || x.rank - y.rank);
  }
  $(listSel).innerHTML = items.map((i) => {
    const bits = [sub ? sub(i) : "", `${fmt(i.plays)} plays`];
    if (i.recent_plays) bits.push(`+${fmt(i.recent_plays)} ${R}`);
    if (i.was !== null && i.was !== i.rank) bits.push(`was #${i.was}`);
    return `<li value="${i.rank}" class="${i.recent_plays ? "touched" : ""}">
      <span class="p">${moveBadge(i)}</span><span class="t">${esc(title(i))}</span>
      <span class="a">${esc(bits.filter(Boolean).join(" · "))}</span></li>`;
  }).join("") || "<li>No plays in this period.</li>";
  $(droppedSel).innerHTML = data.dropped.length
    ? `<span class="hint">Pushed out of the top ${lastTrend.n}:</span> ` +
      data.dropped.map((i) => `<span class="drop">${esc(title(i))} <span class="hint">#${i.was} → #${i.rank}</span></span>`).join(", ")
    : "";
}

function renderMovers() {
  if (!lastTrend) return;
  const k = lastTrend.kinds;
  renderList(k.track, "#trendSongs", "#trendSongsDropped", (i) => i.track, (i) => i.artist);
  renderList(k.artist, "#trendArtists", "#trendArtistsDropped", (i) => i.artist);
  renderList(k.album, "#trendAlbums", "#trendAlbumsDropped", (i) => i.album, (i) => i.artist);
}

async function loadTrends() {
  const d = await api("/api/trends?" + new URLSearchParams({ a: trend.a, b: trend.b, n: trend.n }));
  lastTrend = d;
  const R = d.recent.label, C = d.chart.label, s = d.summary;

  $("#trendQuestion").textContent = d.same
    ? `A and B are both ${R}`
    : `How did ${R} change your chart for ${C}?`;
  let explain;
  if (d.same) explain = "Pick two different periods to see how one changed the other.";
  else if (!s.recent_plays) explain = `You haven't played anything ${R} yet, so your chart for ${C} is unchanged.`;
  else explain = `The lists below are your top ${d.n} for ${C}. ▲ / ▼ shows how each entry moved because of what you played ${R}; "was #14" is where it would stand without ${R}.`;
  if (d.swapped) explain += ` (A was the longer period, so I compared it the other way round.)`;
  $("#trendExplain").textContent = explain;

  const hTile = (kind, label) => {
    const was = s.h_was[kind], now = s.h_now[kind], diff = now - was;
    const delta = diff ? ` <span class="mv ${diff > 0 ? "up" : "down"}">${diff > 0 ? "+" : ""}${diff}</span>` : "";
    return `<div class="stat h" title="Your ${label} for ${C}, without ${R} → with ${R}">
      <div class="v">${was} → ${now}${delta}</div><div class="l">${label} ${C}</div></div>`;
  };
  $("#trendStats").innerHTML = [
    `<div class="stat"><div class="v">${fmt(s.recent_plays)}</div><div class="l">plays ${R}</div></div>`,
    `<div class="stat"><div class="v">${s.share}%</div><div class="l">of ${C}'s ${fmt(s.chart_plays)} plays</div></div>`,
    hTile("h_artist", "artist h-index"), hTile("h_song", "song h-index"), hTile("h_album", "album h-index"),
    `<div class="stat" title="Songs you played for the very first time ${R}"><div class="v">${fmt(s.new_songs)}</div><div class="l">new songs ${R}</div></div>`,
    `<div class="stat" title="Artists you played for the very first time ${R}"><div class="v">${fmt(s.new_artists)}</div><div class="l">new artists ${R}</div></div>`,
  ].join("");

  $("#trendListsTitle").textContent = `Chart movers: ${C}`;
  renderMovers();
}
window.loadTrends = loadTrends;
