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
  const H = narrow ? 260 : 320;
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
  // Rank axis on a log scale (#1 at the top), so climbing from #5,000 to #50 and from #50 to #5 both show.
  const worst = Math.max(...known), decades = Math.max(1, Math.ceil(Math.log10(Math.max(worst, 2))));
  const L = narrow ? 46 : 58, R = 14, T = narrow ? 64 : 74, B = 30;
  const x = (i) => L + (N > 1 ? (i / (N - 1)) * (W - L - R) : 0);
  const y = (r) => T + (Math.log10(r) / decades) * (H - T - B);

  ctx.font = "11px Segoe UI, system-ui, sans-serif";
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let k = 0; k <= decades; k++) {
    const r = 10 ** k, yy = y(r);
    ctx.strokeStyle = line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(L, yy); ctx.lineTo(W - R, yy); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(`#${fmt(r)}`, L - 6, yy);
  }
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left"; ctx.fillText(niceDate(d.labels[0]), L, H - 10);
  ctx.textAlign = "right"; ctx.fillText(niceDate(d.labels[N - 1]), W - R, H - 10);

  const pos = sd.t * (N - 1), cur = Math.min(N - 1, Math.floor(pos));
  const path = (upto) => {
    ctx.beginPath();
    let on = false;
    for (let i = 0; i <= upto; i++) {
      if (ranks[i] === null) { on = false; continue; }
      if (on) ctx.lineTo(x(i), y(ranks[i])); else { ctx.moveTo(x(i), y(ranks[i])); on = true; }
    }
    ctx.stroke();
  };
  ctx.lineJoin = "round";
  ctx.strokeStyle = muted + "55"; ctx.lineWidth = 1.5; path(N - 1);      // the whole story, faint
  ctx.strokeStyle = accent; ctx.lineWidth = 2.5; path(cur);              // up to the current moment

  // Current moment: dot, rank, date, plays so far
  const r = ranks[cur];
  ctx.textAlign = "left";
  if (r !== null) {
    ctx.fillStyle = accent;
    ctx.beginPath(); ctx.arc(x(cur), y(r), 5, 0, Math.PI * 2); ctx.fill();
  }
  ctx.fillStyle = ink;
  ctx.font = `700 ${narrow ? 28 : 36}px Segoe UI, system-ui, sans-serif`;
  ctx.fillText(r === null ? "not yet played" : `#${fmt(r)}`, L, narrow ? 34 : 40);
  ctx.fillStyle = muted;
  ctx.font = "12px Segoe UI, system-ui, sans-serif";
  ctx.fillText(r === null ? niceDate(d.labels[cur])
    : `of ${fmt(d.total[cur])} songs · ${niceDate(d.labels[cur])} · ${fmt(d.plays[cur])} plays${sd.range === "all" ? "" : " in this period"}`,
    L, narrow ? 52 : 60);
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
