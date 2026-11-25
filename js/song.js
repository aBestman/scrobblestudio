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
window.addEventListener("resize", () => { if (!$("#songBody").hidden) { drawSong(); drawRingsCard(); } });
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
