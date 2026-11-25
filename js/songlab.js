// 🧪 Song visual test (temporary): several ways to show one song's journey, side by side.
// Each visual has its own slider and play/pause. Uses helpers from app.js ($, $$, esc, fmt, css, toast,
// setPlayIcon, ICONS) and niceDate() from song.js.

const lab = { key: null, range: "all", months: 12, rank: null, ladder: null, ladderFor: "" };
const LAB_FONT = "Segoe UI, system-ui, sans-serif";

// ---------------------------------------------------------------- search + shared controls
let labTimer;
$("#labQuery").addEventListener("input", () => {
  clearTimeout(labTimer);
  labTimer = setTimeout(async () => {
    const q = $("#labQuery").value.trim(), list = $("#labResults");
    if (!q) { list.hidden = true; return; }
    const { items } = await api("/api/songsearch?" + new URLSearchParams({ q, limit: 12 }));
    list.innerHTML = items.length
      ? items.map((s) => `<li data-key="${esc(s.key)}"><b>${esc(s.track)}</b> <span class="hint">${esc(s.artist)} · ${fmt(s.plays)} plays</span></li>`).join("")
      : '<li class="none">No songs found</li>';
    list.hidden = false;
  }, 150);
});
function pickLab(key) {
  $("#labResults").hidden = true;
  $("#labQuery").value = "";
  lab.key = key;
  try { localStorage.setItem("ss-lab-song", key); } catch {}
  loadLabData(true);
}
$("#labResults").addEventListener("mousedown", (e) => {
  const li = e.target.closest("li[data-key]");
  if (li) { e.preventDefault(); pickLab(li.dataset.key); }
});
$("#labQuery").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { const first = $("#labResults li[data-key]"); if (first) pickLab(first.dataset.key); }
  if (e.key === "Escape") $("#labResults").hidden = true;
});
$("#labQuery").addEventListener("blur", () => setTimeout(() => ($("#labResults").hidden = true), 150));

function markLabRange() { $$("#labRange button").forEach((b) => b.classList.toggle("active", b.dataset.range === lab.range)); }
$$("#labRange button").forEach((b) => b.addEventListener("click", () => { lab.range = b.dataset.range; markLabRange(); loadLabData(true); }));
markLabRange();

// Rolling months: empty while typing → keeps using 12 (field stays empty); 1-60 otherwise.
let monthsTimer;
$("#labMonths").addEventListener("input", () => {
  clearTimeout(monthsTimer);
  monthsTimer = setTimeout(() => {
    const raw = $("#labMonths").value.trim();
    const n = raw === "" ? 12 : Math.min(60, Math.max(1, Math.round(Number(raw)) || 12));
    if (raw !== "" && String(n) !== raw) $("#labMonths").value = n;
    if (n !== lab.months) { lab.months = n; loadLabData(false); }
  }, 400);
});

window.loadLab = () => {
  if (!lab.key) { try { lab.key = localStorage.getItem("ss-lab-song") || null; } catch {} }
  $("#labEmpty").hidden = !!lab.key;
  $("#labBody").hidden = !lab.key;
  if (lab.key && !lab.rank) loadLabData(true);
  else LAB_VISUALS.forEach((v) => v.draw());
};
window.addEventListener("hashchange", () => { if (!location.hash.startsWith("#lab")) LAB_VISUALS.forEach((v) => v.pause()); });

async function loadLabData(all) {
  LAB_VISUALS.forEach((v) => v.pause());
  const q = { key: lab.key, range: lab.range };
  try {
    lab.rank = await api("/api/songrank?" + new URLSearchParams({ ...q, months: lab.months }));
    const ladderFor = lab.key + "|" + lab.range;
    if (all || lab.ladderFor !== ladderFor) { lab.ladder = await api("/api/songladder?" + new URLSearchParams(q)); lab.ladderFor = ladderFor; }
  } catch (e) { toast(e.message, 6000); return; }
  const s = lab.ladder?.frames?.at(-1)?.rows.find((r) => r.me);
  $("#labSong").textContent = s ? `${s.track} · ${s.artist}` : "";
  $("#labEmpty").hidden = true;
  $("#labBody").hidden = false;
  LAB_VISUALS.forEach((v) => { v.t = 1; v.draw(); });   // start each visual on its full picture; press play to watch it grow
}

// ---------------------------------------------------------------- shared drawing helpers
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

// The aging trail (fresh part dark and thick, older parts light and thin), drawn in 24 shades.
function agingPath(ctx, accent, count, upto, fadeSteps, point) {
  const B = 24, shade = (age) => Math.min(B - 1, Math.floor((age / fadeSteps) * B));
  ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.strokeStyle = accent;
  for (let b = B - 1; b >= 0; b--) {
    const fresh = 1 - b / (B - 1);
    ctx.globalAlpha = 0.14 + 0.86 * fresh; ctx.lineWidth = 1.2 + 1.8 * fresh;
    ctx.beginPath();
    for (let k = 1; k <= upto && k < count; k++) {
      if (shade(upto - k) !== b) continue;
      const a = point(k - 1), c = point(k);
      if (!a || !c) continue;
      ctx.moveTo(a[0], a[1]); ctx.lineTo(c[0], c[1]);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------- B + E: moving bar (E = as now, B = with mountain outline)
function drawMovingBar(v, withMountain) {
  const d = lab.rank;
  const g = prepCanvas(v.canvas, (W, narrow) => (narrow ? 320 : 340));
  if (!d) return;
  const { ctx, W, H, narrow, muted, line, accent } = g;
  const known = d.rank.filter((r) => r !== null);
  if (!known.length) return;
  const decades = Math.max(1, Math.ceil(Math.log10(Math.max(2, ...known))));
  const step = niceStep(Math.max(1, ...d.rolling)), top = Math.ceil(Math.max(1, ...d.rolling) / step) * step;
  const L = narrow ? 36 : 46, R = narrow ? 12 : 20, T = narrow ? 86 : 74, B = 36;
  const x = (r) => L + (1 - Math.log10(r) / decades) * (W - L - R);
  const y = (val) => H - B - (val / top) * (H - T - B);

  ctx.font = `11px ${LAB_FONT}`; ctx.lineWidth = 1;
  ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let val = 0; val <= top; val += step) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(L, y(val)); ctx.lineTo(W - R, y(val)); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(val), L - 6, y(val));
  }
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  for (let k = decades; k >= 0; k--) ctx.fillText(`#${fmt(10 ** k)}`, Math.min(W - R - 8, Math.max(L + 12, x(10 ** k))), H - B + 16);
  ctx.textAlign = "right"; ctx.fillText("position → #1", W - R, H - 4);

  const a = labAt(d, v.t);
  const pt = (k) => (d.rank[k] === null ? null : [x(d.rank[k]), y(d.rolling[k])]);

  if (withMountain) {
    // Skyline: for each slice of the position axis, the highest rolling total reached there so far.
    const plotW = W - L - R, NB = Math.max(60, Math.round(plotW / 3)), env = new Array(NB).fill(0);
    for (let k = 0; k <= a.i; k++) {
      const p = pt(k); if (!p) continue;
      const b = Math.min(NB - 1, Math.max(0, Math.floor(((p[0] - L) / plotW) * NB)));
      if (d.rolling[k] > env[b]) env[b] = d.rolling[k];
    }
    const used = env.map((e, b) => [b, e]).filter(([, e]) => e > 0);
    if (used.length) {
      const bx = (b) => L + ((b + 0.5) / NB) * plotW;
      ctx.beginPath();
      ctx.moveTo(bx(used[0][0]), y(0));
      used.forEach(([b, e]) => ctx.lineTo(bx(b), y(e)));
      ctx.lineTo(bx(used.at(-1)[0]), y(0));
      ctx.closePath();
      ctx.fillStyle = accent; ctx.globalAlpha = 0.12; ctx.fill(); ctx.globalAlpha = 1;
      if (v.t >= 1) {                                       // finished: highlight the mountain outline
        ctx.beginPath();
        used.forEach(([b, e], n) => (n ? ctx.lineTo(bx(b), y(e)) : ctx.moveTo(bx(b), y(e))));
        ctx.strokeStyle = accent; ctx.lineWidth = 2.5; ctx.globalAlpha = 0.9; ctx.stroke(); ctx.globalAlpha = 1;
      }
    }
  }

  agingPath(ctx, accent, a.N, a.i, Math.max(5, Math.min(365, Math.round(a.N * 0.12))), pt);
  if (a.r !== null) {
    const bw = narrow ? 10 : 14;
    ctx.fillStyle = accent; ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x(a.r) - bw / 2, y(a.v), bw, Math.max(2, y(0) - y(a.v)), [4, 4, 0, 0]) : ctx.rect(x(a.r) - bw / 2, y(a.v), bw, y(0) - y(a.v));
    ctx.fill();
  }
  const rk = d.rank[a.k];
  header(g, rk === null ? "–" : `#${fmt(rk)}`, `${fmt(d.rolling[a.k])} plays in the ${windowWord(d.months)}`,
    `${niceDate(d.labels[a.k])} · of ${fmt(d.total[a.k])} songs`);
}

// ---------------------------------------------------------------- A: stacked charts, one shared timeline
function drawStacked(v) {
  const d = lab.rank;
  const g = prepCanvas(v.canvas, (W, narrow) => (narrow ? 400 : 420));
  if (!d) return;
  const { ctx, W, H, narrow, muted, line, accent, ink } = g;
  const known = d.rank.filter((r) => r !== null);
  const decades = Math.max(1, Math.ceil(Math.log10(Math.max(2, ...known))));
  const maxV = Math.max(1, ...d.rolling), step = niceStep(maxV), top = Math.ceil(maxV / step) * step;
  const L = narrow ? 44 : 54, R = 14, T = narrow ? 76 : 70, B = 26, gap = 26;
  const ph = (H - T - B - gap) / 2;                      // each panel's height
  const a = labAt(d, v.t);
  const x = (k) => L + (a.N > 1 ? (k / (a.N - 1)) * (W - L - R) : 0);
  const yR = (r) => T + (Math.log10(r) / decades) * ph;                  // top panel: rank, #1 at the top
  const yV = (val) => T + ph + gap + ph - (val / top) * ph;              // bottom panel: rolling plays

  ctx.font = `11px ${LAB_FONT}`; ctx.lineWidth = 1; ctx.textAlign = "right"; ctx.textBaseline = "middle";
  for (let k = 0; k <= decades; k++) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(L, yR(10 ** k)); ctx.lineTo(W - R, yR(10 ** k)); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(`#${fmt(10 ** k)}`, L - 6, yR(10 ** k));
  }
  for (let val = 0; val <= top; val += step) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(L, yV(val)); ctx.lineTo(W - R, yV(val)); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(val), L - 6, yV(val));
  }
  ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  ctx.fillText("rank", L + 4, T - 4);
  ctx.fillText(`plays in the ${windowWord(d.months)}`, L + 4, T + ph + gap - 4);
  ctx.fillText(niceDate(d.labels[0]), L, H - 6);
  ctx.textAlign = "right"; ctx.fillText(niceDate(d.labels[a.N - 1]), W - R, H - 6);

  const line2 = (yOf, val, upto, color, width) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    let on = false;
    for (let k = 0; k <= upto; k++) {
      const vv = val(k); if (vv === null) { on = false; continue; }
      on ? ctx.lineTo(x(k), yOf(vv)) : (ctx.moveTo(x(k), yOf(vv)), (on = true));
    }
    ctx.stroke();
  };
  line2(yR, (k) => d.rank[k], a.N - 1, muted + "44", 1.5);
  line2(yV, (k) => d.rolling[k], a.N - 1, muted + "44", 1.5);
  line2(yR, (k) => d.rank[k], a.i, accent, 2.2);
  line2(yV, (k) => d.rolling[k], a.i, ink, 2.2);
  // The shared cursor through both panels
  ctx.strokeStyle = accent; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(x(a.f), T); ctx.lineTo(x(a.f), H - B); ctx.stroke(); ctx.setLineDash([]);
  if (a.r !== null) {
    ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(x(a.f), yR(a.r), 4.5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ink; ctx.beginPath(); ctx.arc(x(a.f), yV(a.v), 4.5, 0, Math.PI * 2); ctx.fill();
  }
  const rk = d.rank[a.k];
  header(g, rk === null ? "–" : `#${fmt(rk)}`, `${fmt(d.rolling[a.k])} plays in the ${windowWord(d.months)}`, niceDate(d.labels[a.k]));
}

// ---------------------------------------------------------------- C: neighbours ladder (who it overtakes)
function drawLadder(v) {
  const d = lab.ladder;
  const g = prepCanvas(v.canvas, (W, narrow) => (narrow ? 90 : 76) + 10 * (narrow ? 30 : 32) + 10);
  if (!d || !d.frames.length) return;
  const { ctx, W, narrow, muted, accent, ink } = g;
  const F = d.frames.length, fr = d.frames[Math.round(v.t * (F - 1))];
  const rowH = narrow ? 30 : 32, top0 = narrow ? 90 : 76, labelW = Math.min(W * (narrow ? 0.46 : 0.36), 320);
  const max = Math.max(1, ...fr.rows.map((r) => r.plays)), barMax = W - labelW - 70;
  fr.rows.forEach((r, n) => {
    const y = top0 + n * rowH, w = Math.max(3, (r.plays / max) * barMax);
    ctx.fillStyle = r.me ? accent : muted + "55";
    ctx.beginPath(); ctx.roundRect ? ctx.roundRect(labelW, y, w, rowH - 8, 4) : ctx.rect(labelW, y, w, rowH - 8); ctx.fill();
    ctx.textBaseline = "middle"; ctx.textAlign = "right";
    ctx.fillStyle = r.me ? accent : ink; ctx.font = `${r.me ? 700 : 500} ${narrow ? 12 : 13}px ${LAB_FONT}`;
    const name = `#${fmt(r.rank)}  ${r.track}`;
    let s = name; while (s.length > 4 && ctx.measureText(s + "…").width > labelW - 10) s = s.slice(0, -1);
    ctx.fillText(s === name ? s : s + "…", labelW - 8, y + (rowH - 8) / 2);
    ctx.textAlign = "left"; ctx.fillStyle = muted; ctx.font = `12px ${LAB_FONT}`;
    ctx.fillText(fmt(r.plays), labelW + w + 6, y + (rowH - 8) / 2);
  });
  header(g, `#${fmt(fr.rank)}`, `${fmt(fr.plays)} plays · of ${fmt(fr.songs)} songs`, `${niceDate(fr.day)} · the 5 songs just above it and 4 just below`);
}

// ---------------------------------------------------------------- D: year rings (seasons)
function drawRings(v) {
  const d = lab.rank;
  const g = prepCanvas(v.canvas, (W, narrow) => Math.min(W, narrow ? 380 : 470) + (narrow ? 70 : 60));
  if (!d) return;
  const { ctx, W, H, narrow, muted, line, accent } = g;
  const top = narrow ? 70 : 60, size = H - top - 10, cx = W / 2, cy = top + size / 2;
  const r0 = size * 0.08, R = size / 2 - 22;
  const maxV = Math.max(1, ...d.rolling), step = niceStep(maxV), topV = Math.ceil(maxV / step) * step;
  const rad = (val) => r0 + (val / topV) * (R - r0);
  const doy = (ymd) => { const t = Date.parse(ymd + "T00:00:00Z"), y0 = Date.UTC(Number(ymd.slice(0, 4)), 0, 1); return (t - y0) / 86400000; };
  const ang = (ymd) => (doy(ymd) / 365.25) * Math.PI * 2 - Math.PI / 2;      // January at the top, clockwise

  // Guide circles (rolling plays) and month spokes
  ctx.lineWidth = 1; ctx.font = `10px ${LAB_FONT}`; ctx.textAlign = "left"; ctx.textBaseline = "middle";
  for (let val = step; val <= topV; val += step) {
    ctx.strokeStyle = line; ctx.beginPath(); ctx.arc(cx, cy, rad(val), 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(fmt(val), cx + 3, cy - rad(val) + 6);
  }
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  ctx.textAlign = "center";
  MON.forEach((m, k) => {
    const a = (k / 12) * Math.PI * 2 - Math.PI / 2;
    ctx.strokeStyle = line; ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R); ctx.stroke();
    ctx.fillStyle = muted; ctx.fillText(m, cx + Math.cos(a + 0.26) * (R + 12), cy + Math.sin(a + 0.26) * (R + 12));
  });

  // One ring per year: older years pale, the current year dark.
  const a = labAt(d, v.t), curYear = Number(d.labels[a.i].slice(0, 4)), firstYear = Number(d.labels[0].slice(0, 4));
  const years = Math.max(1, curYear - firstYear);
  ctx.strokeStyle = accent; ctx.lineJoin = "round"; ctx.lineCap = "round";
  let prevYear = null;
  ctx.beginPath();
  for (let k = 0; k <= a.i; k++) {
    const ymd = d.labels[k], yr = Number(ymd.slice(0, 4));
    if (yr !== prevYear) {
      if (prevYear !== null) ctx.stroke();
      const age = curYear - yr;
      ctx.globalAlpha = age === 0 ? 1 : 0.12 + 0.6 * (1 - age / (years + 1));
      ctx.lineWidth = age === 0 ? 2.6 : 1.4;
      ctx.beginPath(); prevYear = yr;
      const p = [cx + Math.cos(ang(ymd)) * rad(d.rolling[k]), cy + Math.sin(ang(ymd)) * rad(d.rolling[k])];
      ctx.moveTo(p[0], p[1]);
    } else {
      ctx.lineTo(cx + Math.cos(ang(ymd)) * rad(d.rolling[k]), cy + Math.sin(ang(ymd)) * rad(d.rolling[k]));
    }
  }
  ctx.stroke(); ctx.globalAlpha = 1;
  const ymd = d.labels[a.k];
  ctx.fillStyle = accent; ctx.beginPath(); ctx.arc(cx + Math.cos(ang(ymd)) * rad(d.rolling[a.k]), cy + Math.sin(ang(ymd)) * rad(d.rolling[a.k]), 5, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = muted; ctx.font = `700 ${narrow ? 14 : 16}px ${LAB_FONT}`; ctx.textAlign = "center";
  ctx.fillText(String(curYear), cx, cy);
  const rk = d.rank[a.k];
  header(g, rk === null ? "–" : `#${fmt(rk)}`, `${fmt(d.rolling[a.k])} plays in the ${windowWord(d.months)}`, `${niceDate(ymd)} · one ring per year, distance = plays`);
}

// ---------------------------------------------------------------- visuals + their own players
const LAB_DEFS = [
  ["stack", "A · Stacked charts", "Rank (top) and rolling plays (bottom) on one shared timeline; the dashed line is the moment you're at.", drawStacked, 14000],
  ["mountain", "B · Mountain", "Like the current visual, plus a soft 'skyline' of the highest rolling total reached at each position. Its outline lights up when the animation finishes.", (v) => drawMovingBar(v, true), 14000],
  ["ladder", "C · Neighbours ladder (idea)", "The song with the 5 songs just above and 4 just below it in your all-time ranking: watch who it overtakes.", drawLadder, 16000],
  ["rings", "D · Year rings (idea)", "One ring per year around the months (January at the top); further out = more plays in the rolling window. Shows seasonal habits. Try 1–3 rolling months.", drawRings, 16000],
  ["current", "E · Current visual", "What the Song deep dive page shows now, for comparison.", (v) => drawMovingBar(v, false), 14000],
];
const LAB_VISUALS = LAB_DEFS.map(([id, title, desc, draw, duration]) => {
  const card = document.createElement("section");
  card.className = "card";
  card.innerHTML = `<div class="card-head"><h2>${esc(title)}</h2></div><p class="hint" style="margin-top:0">${esc(desc)}</p>
    <canvas class="lab-canvas" id="lab-${id}"></canvas>
    <div class="player">
      <input type="range" class="scrub" min="0" max="1000" value="1000" aria-label="Position in time">
      <div class="player-controls">
        <button class="icon-btn" type="button" data-act="play"></button>
        <button class="icon-btn ghost" type="button" data-act="restart" title="Restart">${ICONS.restart}</button>
      </div>
    </div>`;
  $("#labBody").appendChild(card);
  const v = { id, t: 1, playing: false, last: 0, raf: 0, dragging: false, duration, canvas: card.querySelector("canvas") };
  const play = card.querySelector('[data-act="play"]'), scrub = card.querySelector(".scrub");
  v.draw = () => { if (!$("#labBody").hidden) draw(v); if (!v.dragging) scrub.value = Math.round(v.t * 1000); };
  const tick = (now) => {
    const dt = v.last ? now - v.last : 16; v.last = now;
    v.t = Math.min(1, v.t + dt / v.duration);
    v.draw();
    if (v.t >= 1) { v.pause(); return; }
    v.raf = requestAnimationFrame(tick);
  };
  v.play = () => { if (v.t >= 1) v.t = 0; v.playing = true; v.last = 0; setPlayIcon(play, true); cancelAnimationFrame(v.raf); v.raf = requestAnimationFrame(tick); };
  v.pause = () => { v.playing = false; cancelAnimationFrame(v.raf); setPlayIcon(play, false); };
  play.addEventListener("click", () => (v.playing ? v.pause() : v.play()));
  card.querySelector('[data-act="restart"]').addEventListener("click", () => { v.t = 0; v.play(); });
  scrub.addEventListener("input", () => { v.dragging = true; v.pause(); v.t = Number(scrub.value) / 1000; v.draw(); });
  scrub.addEventListener("change", () => (v.dragging = false));
  setPlayIcon(play, false);
  return v;
});
window.addEventListener("resize", () => { if (location.hash.startsWith("#lab")) LAB_VISUALS.forEach((v) => v.draw()); });
