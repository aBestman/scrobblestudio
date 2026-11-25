// Song deep dive: one song's numbers, its rank among all your songs over time, and what you play around it.
// Uses helpers from app.js ($, $$, esc, fmt, css, toast, openSong, setPlayIcon, ICONS).

const sd = { key: null, info: null, rank: null, ladder: null, range: "all", t: 1, playing: false, last: 0, raf: 0, dragging: false };
const MON3S = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const niceDate = (ymd) => { const [y, m, d] = ymd.split("-"); return `${Number(d)} ${MON3S[m - 1]} ${y}`; };
const songDuration = () => ({ all: 14000, year: 9000, month: 6000 }[sd.range]);
// Regular speed in ms per day. Year and month: the whole period in 9 s / 6 s. All time: your whole history
// in 14 s, but the part from the song's first play takes at least 6 s.
function msPerDay() {
  const d = sd.rank, N = Math.max(2, d ? d.labels.length : 2);
  if (sd.range !== "all") return songDuration() / N;
  const after = Math.max(1, N - Math.max(0, d.firstIdx));
  return Math.max(14000 / N, 6000 / after);
}

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
  if (key === sd.key && sd.info) { drawSong(); drawRingsCard(); return; }
  pauseSong();
  pauseRings();
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
  loadRings();
  await loadSongRank();
};

function renderSongInfo() {
  const s = sd.info;
  $("#songTitle").textContent = s.track;
  $("#songSub").textContent = `${s.artist}${s.album ? " · " + s.album : ""}`;
  $("#songHeadNums").innerHTML = `<span><b>${fmt(s.scrobbles)}</b> scrobbles</span>`
    + `<span title="Position among all your songs, all time"><b>#${fmt(s.rank_all)}</b> of ${fmt(s.songs_total)}</span>`;
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

// ---------------------------------------------------------------- shared chart helpers (also used by the test page)
const LAB_FONT = "Segoe UI, system-ui, sans-serif";
function prepCanvas(canvas, wantH) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 800, narrow = W < 600;
  const H = typeof wantH === "function" ? wantH(W, narrow) : wantH;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.height = H + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = css("--card"); ctx.fillRect(0, 0, W, H);
  return { ctx, W, H, narrow, ink: css("--text"), muted: css("--muted"), line: css("--line"), accent: css("--accent") };
}
// Position in the data for player time t (0..1), with the rank interpolated on a log scale.
function labAt(d, t) {
  const N = d.labels.length, f = t * (N - 1), i = Math.floor(f), j = Math.min(N - 1, i + 1), u = f - i;
  let r = d.rank[i], v = d.rolling[i];
  if (d.rank[i] !== null && d.rank[j] !== null) {
    r = 10 ** (Math.log10(d.rank[i]) * (1 - u) + Math.log10(d.rank[j]) * u);
    v = d.rolling[i] * (1 - u) + d.rolling[j] * u;
  }
  return { N, f, i, r, v, k: Math.round(f) };
}
const niceStep = (max) => [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => max / s <= 5) || 2000;
const windowWord = (m) => (m === 12 ? "last 12 months" : `last ${m} month${m === 1 ? "" : "s"}`);

function header(g, big, red, sub) {
  const { ctx, narrow, ink, muted, accent } = g;
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink; ctx.font = `700 ${narrow ? 24 : 30}px ${LAB_FONT}`;
  ctx.fillText(big, 12, narrow ? 30 : 34);
  const w = ctx.measureText(big).width;
  ctx.font = `600 ${narrow ? 12 : 14}px ${LAB_FONT}`; ctx.fillStyle = accent;
  ctx.fillText(red, narrow ? 12 : 24 + w, narrow ? 48 : 34);
  ctx.font = `12px ${LAB_FONT}`; ctx.fillStyle = muted;
  ctx.fillText(sub, 12, narrow ? 64 : 54);
}

// ---------------------------------------------------------------- skyline (also used by the test page)
// Every song as a grey bar: left-right = position (#1 on the right, log scale over ALL songs in the period, so
// the axis never moves), height = its plays so far. This song is the wider red bar. When it overtakes songs,
// a small "+N" floats up from it.
function drawSkyline(canvas, d, ld, t, duration) {
  t = Math.min(1, Math.max(0, t));
  const g = prepCanvas(canvas, (W, narrow) => (narrow ? 300 : 320));
  if (!d || !ld || !ld.frames.length) return;
  const { ctx, W, H, narrow, muted, line, accent } = g;
  // Softened log scale: log(rank + 20) instead of log(rank), so the top 10 doesn't take a huge share of the width.
  const SOFT = 20, lg0 = Math.log10(1 + SOFT), lgSpan = Math.log10(Math.max(10, ld.songsEnd) + SOFT) - lg0;
  const decades = Math.log10(Math.max(10, ld.songsEnd));
  const topPlays = Math.max(1, ...ld.frames.at(-1).dist);
  const step = niceStep(topPlays), topV = Math.ceil(topPlays / step) * step;
  const L = narrow ? 36 : 46, R = narrow ? 16 : 24, T = narrow ? 96 : 86, B = 36;
  const x = (r) => Math.min(W - R, L + (1 - (Math.log10(r + SOFT) - lg0) / lgSpan) * (W - L - R));
  const y = (val) => H - B - (val / topV) * (H - T - B);

  // Grid: plays so far, and positions
  ctx.font = `11px ${LAB_FONT}`; ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let val = 0; val <= topV; val += step) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(L, y(val)); ctx.lineTo(W - R, y(val)); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(val), L - 6, y(val));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  let lastLabel = -1e9;
  for (let k = Math.floor(decades); k >= 0; k--) {
    const xx = x(10 ** k), lx = Math.min(W - R - 8, Math.max(L + 12, xx));
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(xx, H - B); ctx.lineTo(xx, H - B + 4); ctx.stroke();
    if (lx - lastLabel < 34) continue;                    // too close to the previous label (#1 next to #10 on phones)
    ctx.fillStyle = muted; ctx.fillText(`#${fmt(10 ** k)}`, lx, H - B + 16);
    lastLabel = lx;
  }
  ctx.textAlign = "right"; ctx.fillText(`position among all ${fmt(ld.songsEnd)} songs → #1`, W - R, H - 4);
  ctx.textAlign = "left"; ctx.fillText("plays so far", L, T - 10);

  // The other songs, blended between the two nearest snapshots
  const F = ld.frames.length, ff = t * (F - 1), fi = Math.floor(ff), fj = Math.min(F - 1, fi + 1), fu = ff - fi;
  const A = ld.frames[fi].dist, Bv = ld.frames[fj].dist, ranks = ld.distRanks;
  ctx.fillStyle = muted; ctx.globalAlpha = 0.45;
  ctx.beginPath();
  for (let s = 0; s < ranks.length; s++) {
    const val = A[s] * (1 - fu) + Bv[s] * fu;
    if (val <= 0) continue;
    // Each bar fills its whole slot: from halfway to the next-better song to halfway to the next sampled one,
    // so there are no gaps between bars.
    const right = x(ranks[s] - 0.5), left = s + 1 < ranks.length ? x(ranks[s + 1] - 0.5) : L;
    ctx.rect(left, y(val), right - left + 0.4, y(0) - y(val));
  }
  ctx.fill(); ctx.globalAlpha = 1;

  // This song: the red bar (wider than the rest), plays so far
  const a = labAt(d, t);
  if (a.r !== null) {
    const i = a.i, j = Math.min(a.N - 1, i + 1), u = a.f - i;
    const mine = d.plays[i] * (1 - u) + d.plays[j] * u;
    const bw = narrow ? 10 : 14, bx = x(a.r), by = y(mine);
    ctx.fillStyle = accent; ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(bx - bw / 2, by, bw, Math.max(2, y(0) - by), [4, 4, 0, 0]) : ctx.rect(bx - bw / 2, by, bw, y(0) - by);
    ctx.fill();

    // Overtakes: "+N" (songs passed) floats up from the bar and fades; ~0.7 s of playback per label.
    const life = Math.max(2, (a.N - 1) * (700 / duration)), slot = Math.max(1, Math.round(life / 4));
    ctx.textAlign = "center"; ctx.font = `600 11px ${LAB_FONT}`; ctx.fillStyle = accent;
    for (let end = Math.floor(a.f / slot) * slot; end > 0 && a.f - end < life; end -= slot) {
      const r0 = d.rank[Math.max(0, end - slot)], r1 = d.rank[end];
      if (r0 === null || r1 === null || r0 <= r1) continue;
      const age = (a.f - end) / life;
      ctx.globalAlpha = 0.9 * (1 - age);
      ctx.fillText(`+${fmt(r0 - r1)}`, bx, by - 8 - age * 26);
    }
    ctx.globalAlpha = 1;
  }
  const rk = d.rank[a.k];
  header(g, rk === null ? "–" : `#${fmt(rk)}`, `${fmt(d.plays[a.k])} plays so far`,
    `${niceDate(d.labels[a.k])} · of ${fmt(d.total[a.k])} songs`);
}

// ---------------------------------------------------------------- rank over time
function markSongRange() { $$("#songRange button").forEach((b) => b.classList.toggle("active", b.dataset.range === sd.range)); }
$$("#songRange button").forEach((b) => b.addEventListener("click", () => { sd.range = b.dataset.range; markSongRange(); loadSongRank(); }));
markSongRange();

async function loadSongRank() {
  pauseSong();
  try {
    const q = new URLSearchParams({ key: sd.key, range: sd.range });
    [sd.rank, sd.ladder] = await Promise.all([api("/api/songrank?" + q), api("/api/songladder?" + q)]);
  } catch (e) {
    sd.rank = null; sd.ladder = null;
    toast(e.message, 6000);
  }
  sd.t = 0;
  playSong();                                           // a quick replay every time you open a song or period
}

// The skyline: every song as a grey bar (plays so far, at its position), this song as the wide red bar.
function drawSong() {
  // (the last value = how long the whole timeline takes at regular speed, so "+N" labels last ~0.7 s)
  drawSkyline($("#songCanvas"), sd.rank, sd.ladder, sd.t, sd.rank ? msPerDay() * Math.max(1, sd.rank.labels.length - 1) : 14000);
  if (!sd.dragging) $("#songScrub").value = Math.round(sd.t * 1000);
  const L = sd.rank && sd.rank.labels;                    // the date you're at, as "Mmm YYYY"
  $("#songDate").textContent = L ? monthYear(L[Math.round(sd.t * (L.length - 1))]) : "";
}
const monthYear = (ymd) => `${MON3S[Number(ymd.slice(5, 7)) - 1]} ${ymd.slice(0, 4)}`;

function tickSong(now) {
  const dt = sd.last ? now - sd.last : 16;
  sd.last = now;
  // Walk through the days: All time runs 5× faster until the song's first play, then at regular speed.
  const d = sd.rank, N = d.labels.length;
  const fast = sd.range === "all" && d.firstIdx > 0 && sd.t * (N - 1) < d.firstIdx;
  // (the run-up never takes more than 3 s: for a song you found recently it goes faster than 5×)
  const boost = fast ? Math.max(5, (d.firstIdx * msPerDay()) / 3000) : 1;
  sd.t = Math.min(1, sd.t + (dt / msPerDay()) * boost / Math.max(1, N - 1));
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
// Redraw when the page's width really changes (window resize, phone rotation, sidebar folding)
let songBodyW = 0;
new ResizeObserver(([e]) => {
  const w = Math.round(e.contentRect.width);
  if (!w || w === songBodyW) return;
  songBodyW = w;
  if (sd.info) { drawSong(); drawRingsCard(); }
}).observe($("#songBody"));
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#song")) { pauseSong(); pauseRings(); } });

// ---------------------------------------------------------------- year rings
// One ring per year around the calendar; distance from the centre = plays in a window around that date.
const rg = { data: null, half: 1, t: 1, playing: false, last: 0, raf: 0, dragging: false };
const RING_MS = 14000;

// Read the "months before and after" field. Empty or nonsense → 1, without rewriting what you typed.
function ringHalf() {
  const n = parseInt($("#ringHalf").value, 10);
  return Number.isFinite(n) ? Math.min(12, Math.max(0, n)) : 1;
}
async function loadRings() {
  pauseRings();
  rg.half = ringHalf();
  try {
    rg.data = await api("/api/songrings?" + new URLSearchParams({ key: sd.key, half: rg.half }));
  } catch (e) {
    rg.data = null;
    toast(e.message, 6000);
  }
  rg.t = 1;                                              // start on the full picture (with the fill); press play to watch
  drawRingsCard();
}
let ringTimer;
$("#ringHalf").addEventListener("input", () => {
  clearTimeout(ringTimer);
  ringTimer = setTimeout(() => { if (sd.key && ringHalf() !== rg.half) loadRings(); }, 300);
});

// Draws year rings for days `labels` with values `values` at player time t (0..1) on `canvas`.
// Shared with the test page. caption(ymd, value) gives the red line under the big number.
function drawYearRings(canvas, labels, values, t, caption) {
  const dpr = window.devicePixelRatio || 1;
  const W = canvas.clientWidth || 800, narrow = W < 600;
  const top = narrow ? 70 : 60, H = Math.min(W, narrow ? 380 : 470) + top;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr); canvas.style.height = H + "px";
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = css("--text"), muted = css("--muted"), line = css("--line"), accent = css("--accent");
  ctx.fillStyle = css("--card"); ctx.fillRect(0, 0, W, H);
  if (!labels || !labels.length) return;
  const FONT = "Segoe UI, system-ui, sans-serif";
  const size = H - top - 10, cx = W / 2, cy = top + size / 2;
  const r0 = size * 0.08, R = size / 2 - 22;
  const maxV = Math.max(1, ...values);
  const step = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000].find((s) => maxV / s <= 5) || 2000;
  const topV = Math.ceil(maxV / step) * step;
  const rad = (val) => r0 + (val / topV) * (R - r0);
  const ang = (ymd) => {                                  // January at the top, clockwise
    const d = (Date.parse(ymd + "T00:00:00Z") - Date.UTC(Number(ymd.slice(0, 4)), 0, 1)) / 86400000;
    return (d / 365.25) * Math.PI * 2 - Math.PI / 2;
  };
  const pt = (k) => [cx + Math.cos(ang(labels[k])) * rad(values[k]), cy + Math.sin(ang(labels[k])) * rad(values[k])];

  // Guide circles (plays) and month spokes
  ctx.lineWidth = 1; ctx.font = `10px ${FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let val = step; val <= topV; val += step) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.arc(cx, cy, rad(val), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(val), cx + 3, cy - rad(val) + 6);
  }
  ctx.textAlign = "center";
  MON3S.forEach((m, k) => {
    const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(m, cx + Math.cos(a + 0.26) * (R + 12), cy + Math.sin(a + 0.26) * (R + 12));
  });

  // Split the days into years (index ranges)
  const N = labels.length, f = t * (N - 1), i = Math.floor(f), k = Math.round(f);
  const years = [];
  for (let n = 0; n <= i; n++) {
    const yr = Number(labels[n].slice(0, 4));
    if (!years.length || years.at(-1).yr !== yr) years.push({ yr, from: n, to: n });
    else years.at(-1).to = n;
  }
  const curYear = years.at(-1).yr, span = Math.max(1, curYear - years[0].yr);

  // Finished: fill each year's ring very lightly. Fills stack, so where many years overlap it gets darker.
  if (t >= 1) {
    ctx.fillStyle = accent;
    ctx.globalAlpha = Math.max(0.05, Math.min(0.12, 0.5 / years.length));
    for (const y of years) {
      ctx.beginPath();                                    // the ring, then back along the inner circle: the centre stays clear
      for (let n = y.from; n <= y.to; n++) (n === y.from ? ctx.moveTo : ctx.lineTo).apply(ctx, pt(n));
      ctx.arc(cx, cy, r0, ang(labels[y.to]), ang(labels[y.from]), true);
      ctx.closePath();
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  // The rings: older years pale and thin, the current year dark
  ctx.strokeStyle = accent; ctx.lineJoin = "round"; ctx.lineCap = "round";
  for (const y of years) {
    const age = curYear - y.yr;
    ctx.globalAlpha = age === 0 ? 1 : 0.12 + 0.6 * (1 - age / (span + 1));
    ctx.lineWidth = age === 0 ? 2.6 : 1.4;
    ctx.beginPath();
    for (let n = y.from; n <= y.to; n++) (n === y.from ? ctx.moveTo : ctx.lineTo).apply(ctx, pt(n));
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(...pt(k), 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = muted; ctx.font = `700 ${narrow ? 14 : 16}px ${FONT}`; ctx.textAlign = "center"; ctx.textBaseline = "middle";
  ctx.fillText(String(Number(labels[k].slice(0, 4))), cx, cy);

  // Header
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  const big = `${fmt(values[k])} plays`;
  ctx.fillStyle = ink; ctx.font = `700 ${narrow ? 24 : 30}px ${FONT}`;
  ctx.fillText(big, 12, narrow ? 30 : 34);
  const w = ctx.measureText(big).width;
  ctx.font = `600 ${narrow ? 12 : 14}px ${FONT}`; ctx.fillStyle = accent;
  ctx.fillText(caption(labels[k], values[k]), narrow ? 12 : 24 + w, narrow ? 48 : 34);
  ctx.font = `12px ${FONT}`; ctx.fillStyle = muted;
  ctx.fillText(`${niceDate(labels[k])} · one ring per year, distance = plays`, 12, narrow ? 64 : 54);
}

function drawRingsCard() {
  const d = rg.data;
  const word = (m) => `${m} month${m === 1 ? "" : "s"}`;
  drawYearRings($("#ringCanvas"), d && d.labels, d ? d.values : [], rg.t,
    () => (d.half === 0 ? "in that month" : `in the ${word(d.months)} around it (${word(d.half)} before and after)`));
  if (!rg.dragging) $("#ringScrub").value = Math.round(rg.t * 1000);
  $("#ringDate").textContent = d ? monthYear(d.labels[Math.round(rg.t * (d.labels.length - 1))]) : "";
}
function tickRings(now) {
  const dt = rg.last ? now - rg.last : 16;
  rg.last = now;
  rg.t = Math.min(1, rg.t + dt / RING_MS);
  drawRingsCard();
  if (rg.t >= 1) { pauseRings(); return; }
  rg.raf = requestAnimationFrame(tickRings);
}
function playRings() {
  if (!rg.data) return;
  if (rg.t >= 1) rg.t = 0;
  rg.playing = true; rg.last = 0;
  setPlayIcon($("#ringPlay"), true);
  cancelAnimationFrame(rg.raf);
  rg.raf = requestAnimationFrame(tickRings);
}
function pauseRings() {
  rg.playing = false;
  cancelAnimationFrame(rg.raf);
  setPlayIcon($("#ringPlay"), false);
}
$("#ringPlay").addEventListener("click", () => (rg.playing ? pauseRings() : playRings()));
$("#ringRestart").innerHTML = ICONS.restart;
$("#ringRestart").title = "Restart";
$("#ringRestart").addEventListener("click", () => { rg.t = 0; playRings(); });
$("#ringScrub").addEventListener("input", (e) => { rg.dragging = true; pauseRings(); rg.t = Number(e.target.value) / 1000; drawRingsCard(); });
$("#ringScrub").addEventListener("change", () => (rg.dragging = false));
setPlayIcon($("#ringPlay"), false);
