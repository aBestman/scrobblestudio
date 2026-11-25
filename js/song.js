// Song deep dive: one song's numbers, its rank among all your songs over time, and what you play around it.
// Uses helpers from app.js ($, $$, esc, fmt, css, toast, openSong, setPlayIcon, ICONS).

const sd = { key: null, info: null, rank: null, range: "all", t: 1, playing: false, last: 0, raf: 0, dragging: false };
const MON3S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const niceDate = (ymd) => { const [y, m, d] = ymd.split("-"); return `${Number(d)} ${MON3S[m - 1]} ${y}`; };
const songDuration = () => ({ all: 14000, year: 9000, month: 6000 }[sd.range]);

// ---------------------------------------------------------------- search
let searchTimer;
$("#songQuery").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(async () => {
    const q = $("#songQuery").value.trim();
    const list = $("#songResults");
    if (!q) { list.hidden = true; return; }
    const { items } = await api("/api/songsearch?" + new URLSearchParams({ q, limit: 12 }));
    list.innerHTML = items.length
      ? items.map((s) => `<li data-key="${esc(s.key)}"><b>${esc(s.track)}</b> <span class="hint">${esc(s.artist)} · ${fmt(s.plays)} plays</span></li>`).join("")
      : '<li class="none">No songs found</li>';
    list.hidden = false;
  }, 150);
});
$("#songResults").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-key]");
  if (!li) return;
  e.preventDefault();
  $("#songResults").hidden = true;
  $("#songQuery").value = "";
  openSong(li.dataset.key);
});
$("#songQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const first = $("#songResults li[data-key]"); if (first) { $("#songResults").hidden = true; $("#songQuery").value = ""; openSong(first.dataset.key); } }
  if (e.key === "Escape") $("#songResults").hidden = true;
});
$("#songQuery").addEventListener("blur", () => setTimeout(() => ($("#songResults").hidden = true), 150));

// ---------------------------------------------------------------- page
window.loadSong = async () => {
  let key = decodeURIComponent(location.hash.split("=").slice(1).join("=") || "");
  if (!key) { try { key = localStorage.getItem("ss-song") || ""; } catch {} }
  $("#songEmpty").hidden = !!key;
  $("#songBody").hidden = !key;
  if (!key) { setTimeout(() => $("#songQuery").focus(), 50); return; }
  if (key === sd.key && sd.info) { drawSong(); return; }
  pauseSong();
  try {
    sd.info = await api("/api/song?" + new URLSearchParams({ key }));
  } catch (e) {
    toast(e.message, 6000);
    $("#songEmpty").hidden = false;
    $("#songBody").hidden = true;
    return;
  }
  sd.key = key;
  try { localStorage.setItem("ss-song", key); } catch {}
  renderSongInfo();
  await loadSongRank();
};

function renderSongInfo() {
  const s = sd.info;
  $("#songTitle").textContent = s.track;
  $("#songSub").textContent = `${s.artist}${s.album ? " · " + s.album : ""} · #${fmt(s.rank_all)} of ${fmt(s.songs_total)} songs all time`;
  const g = s.gap;
  const tile = (v, l, tip) => `<div class="stat"${tip ? ` title="${esc(tip)}"` : ""}><div class="v">${v}</div><div class="l">${l}</div></div>`;
  $("#songStats").innerHTML = [
    tile(fmt(s.scrobbles), "scrobbles"),
    tile(`<span class="v-date">${niceDate(s.first.slice(0, 10))}</span>`, `first listen · ${s.first.slice(11)}`, `Last listen: ${s.last}`),
    tile(fmt(s.days), "different days listened"),
    tile(`${fmt(g.days)} <span class="v-unit">days</span>`,
      g.days ? `longest without it · ${niceDate(g.from)} → ${g.ongoing ? "today (still going)" : niceDate(g.to)}` : "longest without it",
      "The longest stretch of days you didn't play this song, counted up to today"),
  ].join("");
  $("#songTogether").innerHTML = s.together.length
    ? s.together.map((x) => `<li class="link" data-key="${esc(x.key)}" title="Open this song's deep dive">
        <span class="p">${fmt(x.times)}×</span><span class="t">${esc(x.track)}</span>
        <span class="a">${esc(x.artist)} · in the top 3 around ${fmt(x.times)} of ${fmt(x.of)} plays</span></li>`).join("")
    : "<li>Not enough plays around this song yet.</li>";
}
$("#songTogether").addEventListener("click", (e) => { const li = e.target.closest("li[data-key]"); if (li) openSong(li.dataset.key); });

// ---------------------------------------------------------------- rank over time
function markSongRange() { $$("#songRange button").forEach((b) => b.classList.toggle("active", b.dataset.range === sd.range)); }
$$("#songRange button").forEach((b) => b.addEventListener("click", () => { sd.range = b.dataset.range; markSongRange(); loadSongRank(); }));
markSongRange();

async function loadSongRank() {
  pauseSong();
  try {
    sd.rank = await api("/api/songrank?" + new URLSearchParams({ key: sd.key, range: sd.range }));
  } catch (e) {
    sd.rank = null;
    toast(e.message, 6000);
  }
  sd.t = 0;
  playSong();                                           // a quick replay every time you open a song or period
}

function drawSong() {
  const c = $("#songCanvas"), d = sd.rank;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 800, narrow = W < 600;
  const H = narrow ? 310 : 340;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr); c.height = Math.round(H * dpr); c.style.height = H + "px";
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = css("--text"), muted = css("--muted"), line = css("--line"), accent = css("--accent");
  ctx.fillStyle = css("--card");
  ctx.fillRect(0, 0, W, H);
  if (!d) return;

  const N = d.labels.length;
  const ranks = d.rank;
  const known = ranks.filter((r) => r !== null);
  if (!known.length) {
    ctx.fillStyle = muted; ctx.font = "14px Segoe UI, system-ui, sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Not played in this period yet", W / 2, H / 2);
    return;
  }
  // A moving bar: left-right = the song's position among all your songs (#1 on the far right, log scale so
  // #8,000 → #200 shows as clearly as #20 → #1); height = its plays in the last 365 days at that moment.
  const worst = Math.max(...known), decades = Math.max(1, Math.ceil(Math.log10(Math.max(worst, 2))));
  const maxRoll = Math.max(1, ...d.rolling);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500].find((s) => maxRoll / s <= 5) || 1000;
  const top = Math.ceil(maxRoll / step) * step;
  const L = narrow ? 38 : 48, R = narrow ? 14 : 22, T = narrow ? 104 : 90, B = 40;
  const x = (rank) => L + (1 - Math.log10(rank) / decades) * (W - L - R);
  const y = (v) => H - B - (v / top) * (H - T - B);

  ctx.font = "11px Segoe UI, system-ui, sans-serif";
  ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let v = 0; v <= top; v += step) {                 // height: plays in the last 365 days
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(L, y(v)); ctx.lineTo(W - R, y(v)); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(v), L - 6, y(v));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  for (let k = decades; k >= 0; k--) {                    // position: #10,000 … #10, #1
    const xx = x(10 ** k);
    ctx.strokeStyle = line;
    ctx.beginPath(); ctx.moveTo(xx, H - B); ctx.lineTo(xx, H - B + 4); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(`#${fmt(10 ** k)}`, Math.min(W - R - 8, Math.max(L + 12, xx)), H - B + 16);
  }
  ctx.textAlign = "right";
  ctx.fillText(narrow ? "position → #1" : "position among all your songs → #1", W - R, H - 6);
  ctx.textAlign = "left";
  ctx.fillText(narrow ? "plays / 365 days" : "plays in the last 365 days", L, T - 10);

  // Where are we? Interpolate between days so the bar glides.
  const f = sd.t * (N - 1), i = Math.floor(f), j = Math.min(N - 1, i + 1), u = f - i;
  const rankAt = (k) => ranks[k];
  let rNow = rankAt(i), vNow = d.rolling[i];
  if (rankAt(i) !== null && rankAt(j) !== null) {
    rNow = 10 ** (Math.log10(rankAt(i)) * (1 - u) + Math.log10(rankAt(j)) * u);
    vNow = d.rolling[i] * (1 - u) + d.rolling[j] * u;
  }

  // Trail of where it has been, aging as it goes: the fresh part is dark and thick, older parts fade to a
  // light thin line, so when it doubles back over itself you can still see which part is recent.
  // The fade takes about a year in "All time", ~6 weeks in "This year", a few days in "This month".
  const fade = Math.max(5, Math.min(365, Math.round(N * 0.12)));
  const BUCKETS = 24;                                       // draw in 24 shades instead of thousands of separate strokes
  ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = accent;
  const shade = (age) => Math.min(BUCKETS - 1, Math.floor((age / fade) * BUCKETS));
  for (let b = BUCKETS - 1; b >= 0; b--) {                  // oldest first, so fresh lines end up on top
    const freshness = 1 - b / (BUCKETS - 1);                // 1 = newest, 0 = oldest
    ctx.globalAlpha = 0.14 + 0.86 * freshness;
    ctx.lineWidth = 1.2 + 1.8 * freshness;
    ctx.beginPath();
    for (let k = 1; k <= i; k++) {
      if (ranks[k] === null || ranks[k - 1] === null || shade(i - k) !== b) continue;
      ctx.moveTo(x(ranks[k - 1]), y(d.rolling[k - 1]));
      ctx.lineTo(x(ranks[k]), y(d.rolling[k]));
    }
    if (b === 0 && rNow !== null && ranks[i] !== null) {    // the tiny bit between today's step and the gliding bar
      ctx.moveTo(x(ranks[i]), y(d.rolling[i]));
      ctx.lineTo(x(rNow), y(vNow));
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (rNow !== null) {
    const bw = narrow ? 10 : 14, bx = x(rNow) - bw / 2;
    ctx.fillStyle = accent;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx, y(vNow), bw, Math.max(2, y(0) - y(vNow)), [4, 4, 0, 0]) : ctx.rect(bx, y(vNow), bw, y(0) - y(vNow));
    ctx.fill();
  }

  // Header: rank and rolling-year plays now, date and totals
  const rShown = ranks[Math.round(f)] ?? rankAt(i);
  ctx.textAlign = "left";
  ctx.fillStyle = ink;
  ctx.font = `700 ${narrow ? 28 : 36}px Segoe UI, system-ui, sans-serif`;
  const big = rShown === null ? "not yet played" : `#${fmt(rShown)}`;
  ctx.fillText(big, L, narrow ? 34 : 40);
  const bigW = ctx.measureText(big).width;
  ctx.font = `600 ${narrow ? 13 : 15}px Segoe UI, system-ui, sans-serif`;
  ctx.fillStyle = accent;
  // Phones: the rolling-year number goes on its own line under the rank
  ctx.fillText(`${fmt(d.rolling[Math.round(f)])} plays in the last 365 days`, narrow ? L : L + bigW + 12, narrow ? 54 : 40);
  ctx.fillStyle = muted;
  ctx.font = "12px Segoe UI, system-ui, sans-serif";
  ctx.fillText(`${niceDate(d.labels[Math.round(f)])} · of ${fmt(d.total[Math.round(f)])} songs · ${fmt(d.plays[Math.round(f)])} plays${sd.range === "all" ? " in total" : " in this period"}`,
    L, narrow ? 72 : 60);
  if (!sd.dragging) $("#songScrub").value = Math.round(sd.t * 1000);
}

function tickSong(now) {
  const dt = sd.last ? now - sd.last : 16;
  sd.last = now;
  sd.t = Math.min(1, sd.t + dt / songDuration());
  drawSong();
  if (sd.t >= 1) { pauseSong(); return; }
  sd.raf = requestAnimationFrame(tickSong);
}
function playSong() {
  if (!sd.rank) return;
  if (sd.t >= 1) sd.t = 0;
  sd.playing = true;
  sd.last = 0;
  setPlayIcon($("#songPlay"), true);
  cancelAnimationFrame(sd.raf);
  sd.raf = requestAnimationFrame(tickSong);
}
function pauseSong() {
  sd.playing = false;
  cancelAnimationFrame(sd.raf);
  setPlayIcon($("#songPlay"), false);
}
$("#songPlay").addEventListener("click", () => (sd.playing ? pauseSong() : playSong()));
$("#songRestart").innerHTML = ICONS.restart;
$("#songRestart").title = "Restart";
$("#songRestart").addEventListener("click", () => { sd.t = 0; playSong(); });
$("#songScrub").addEventListener("input", (e) => { sd.dragging = true; pauseSong(); sd.t = Number(e.target.value) / 1000; drawSong(); });
$("#songScrub").addEventListener("change", () => (sd.dragging = false));
setPlayIcon($("#songPlay"), false);
window.addEventListener("resize", () => { if (!$("#songBody").hidden) drawSong(); });
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#song")) pauseSong(); });
