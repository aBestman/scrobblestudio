// Bar race page: an animated ranking of artists / songs / albums over time, drawn on a canvas.
// Uses helpers from app.js ($, $$, fmt, css, toast, rangeStart).

const race = { data: null, playing: false, t: 0, duration: 30000, last: 0, pos: new Map(), raf: 0, recorder: null, dragging: false };
const raceOpts = { kind: "artist", range: "all", start: "", end: "", n: 10, dur: 30, step: "auto", mode: "cumulative", win: 12 };
try { Object.assign(raceOpts, JSON.parse(localStorage.getItem("ss-race") || "{}")); } catch {}
const MON3 = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_WORD = { artist: "artists", track: "songs", album: "albums" };

// ---------------------------------------------------------------- form
function fillRaceForm() {
  $("#raceRange").value = raceOpts.range;
  $("#raceStart").value = raceOpts.start;
  $("#raceEnd").value = raceOpts.end;
  $("#raceN").value = raceOpts.n;
  $("#raceDur").value = raceOpts.dur;
  $("#raceStep").value = raceOpts.step;
  $("#raceMode").value = raceOpts.mode;
  $("#raceWin").value = raceOpts.win;
  $("#raceWinWrap").hidden = raceOpts.mode !== "rolling";
  $$("#raceKind button").forEach((b) => b.classList.toggle("active", b.dataset.kind === raceOpts.kind));
}
$$("#raceKind button").forEach((b) => b.addEventListener("click", () => { raceOpts.kind = b.dataset.kind; fillRaceForm(); }));
$("#raceRange").addEventListener("change", () => {
  const r = $("#raceRange").value;
  if (r === "custom") return;
  $("#raceStart").value = rangeStart(r);
  $("#raceEnd").value = "";
});
["#raceStart", "#raceEnd"].forEach((s) => $(s).addEventListener("change", () => ($("#raceRange").value = "custom")));
$("#raceMode").addEventListener("change", () => ($("#raceWinWrap").hidden = $("#raceMode").value !== "rolling"));
fillRaceForm();

function readRaceForm() {
  const clamp = (v, lo, hi, def) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
  Object.assign(raceOpts, {
    range: $("#raceRange").value, start: $("#raceStart").value, end: $("#raceEnd").value,
    n: clamp($("#raceN").value, 3, 30, 10), dur: clamp($("#raceDur").value, 5, 300, 30),
    step: $("#raceStep").value, mode: $("#raceMode").value, win: clamp($("#raceWin").value, 1, 1000, 12),
  });
  fillRaceForm();
  try { localStorage.setItem("ss-race", JSON.stringify(raceOpts)); } catch {}
}

async function generateRace() {
  pauseRace();
  readRaceForm();
  const p = new URLSearchParams({ kind: raceOpts.kind, n: raceOpts.n, mode: raceOpts.mode, window: raceOpts.win, step: raceOpts.step });
  if (raceOpts.start) p.set("start", raceOpts.start);
  if (raceOpts.end) p.set("end", raceOpts.end);
  const btn = $("#raceGo");
  btn.disabled = true;
  btn.textContent = "Building…";
  try {
    race.data = await api("/api/barrace?" + p);
  } catch (e) {
    toast(e.message, 8000);
    return;
  } finally {
    btn.disabled = false;
    btn.textContent = "Generate";
  }
  race.duration = raceOpts.dur * 1000;
  race.t = 0;
  race.pos.clear();
  drawRace(Infinity);
  playRace();
}
$("#raceGo").addEventListener("click", generateRace);

// ---------------------------------------------------------------- drawing
const hueOf = (name) => { let h = 7; for (const ch of name) h = (h * 31 + ch.codePointAt(0)) >>> 0; return h % 360; };

function stepLabel(label, step) {
  if (step === "year") return label;
  if (step === "month") { const [y, m] = label.split("-"); return `${MON3[m - 1]} ${y}`; }
  const [y, m, d] = label.split("-");
  return `${step === "week" ? "Week of " : ""}${Number(d)} ${MON3[m - 1]} ${y}`;
}

function fitText(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let s = text;
  while (s.length > 1 && ctx.measureText(s + "…").width > maxW) s = s.slice(0, -1);
  return s + "…";
}

// dt = milliseconds since the last frame (Infinity = jump straight to the right positions).
function drawRace(dt) {
  const d = race.data, c = $("#raceCanvas");
  if (!d) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth || 800;
  const narrow = W < 600;
  const barH = narrow ? 30 : 36, top = 56, bottom = narrow ? 84 : 64;
  const H = top + bottom + d.n * barH;
  if (c.width !== Math.round(W * dpr) || c.height !== Math.round(H * dpr)) {
    c.width = Math.round(W * dpr);
    c.height = Math.round(H * dpr);
    c.style.height = H + "px";
  }
  const ctx = c.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ink = css("--text"), muted = css("--muted");
  ctx.fillStyle = css("--card");
  ctx.fillRect(0, 0, W, H);

  // Where are we in the race? f = fractional step index.
  const F = d.labels.length;
  const f = F > 1 ? Math.min(F - 1, (race.t / race.duration) * (F - 1)) : 0;
  const i = Math.floor(f), j = Math.min(i + 1, F - 1), u = f - i;
  const vals = [];
  for (const e of d.entities) {
    const v = e.values[i] + (e.values[j] - e.values[i]) * u;
    if (v > 0) vals.push({ e, v });
  }
  vals.sort((a, b) => b.v - a.v);
  const max = vals[0]?.v || 1;

  const labelW = Math.min(W * (narrow ? 0.38 : 0.3), 280);
  const barMax = W - labelW - (narrow ? 56 : 80);
  const ease = Math.min(1, dt / 160);

  vals.forEach(({ e, v }, rank) => {
    const target = rank < d.n ? rank : d.n + 0.6;
    const prev = race.pos.has(e.id) ? race.pos.get(e.id) : target;
    const pos = dt === Infinity ? target : prev + (target - prev) * ease;
    race.pos.set(e.id, pos);
    if (pos > d.n + 0.4) return;
    const alpha = Math.max(0, Math.min(1, d.n + 0.4 - pos));
    const y = top + pos * barH;
    const bh = barH * 0.78;
    const w = Math.max(2, (v / max) * barMax);
    const hue = hueOf(e.artist);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = `hsl(${hue}, 62%, 52%)`;
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(labelW, y, w, bh, 4) : ctx.rect(labelW, y, w, bh);
    ctx.fill();

    // Name (and artist for songs/albums) to the left of the bar
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillStyle = ink;
    if (e.sub && !narrow) {
      ctx.font = "600 13px Segoe UI, system-ui, sans-serif";
      ctx.fillText(fitText(ctx, e.name, labelW - 12), labelW - 8, y + bh * 0.34);
      ctx.fillStyle = muted;
      ctx.font = "11px Segoe UI, system-ui, sans-serif";
      ctx.fillText(fitText(ctx, e.sub, labelW - 12), labelW - 8, y + bh * 0.76);
    } else {
      ctx.font = `600 ${narrow ? 12 : 13}px Segoe UI, system-ui, sans-serif`;
      ctx.fillText(fitText(ctx, e.name, labelW - 12), labelW - 8, y + bh / 2);
    }
    // Play count at the end of the bar
    ctx.textAlign = "left";
    ctx.fillStyle = ink;
    ctx.font = `${narrow ? 11 : 12}px Segoe UI, system-ui, sans-serif`;
    ctx.fillText(fmt(Math.round(v)), labelW + w + 6, y + bh / 2);
    ctx.globalAlpha = 1;
  });
  for (const id of [...race.pos.keys()]) if (!vals.some((x) => x.e.id === id)) race.pos.delete(id);

  // Title, date and total
  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ink;
  ctx.font = `700 ${narrow ? 15 : 18}px Segoe UI, system-ui, sans-serif`;
  const how = d.mode === "rolling" ? `hottest (last ${d.window} ${d.step}${d.window === 1 ? "" : "s"})` : "running total";
  ctx.fillText(`Top ${d.n} ${KIND_WORD[d.kind]} · ${how}`, 12, 30);
  ctx.fillStyle = muted;
  ctx.font = "12px Segoe UI, system-ui, sans-serif";
  ctx.fillText(`${stepLabel(d.labels[0], d.step)} → ${stepLabel(d.labels[F - 1], d.step)}`, 12, 48);

  ctx.textAlign = "right";
  ctx.font = `700 ${narrow ? 26 : 40}px Segoe UI, system-ui, sans-serif`;
  ctx.globalAlpha = 0.55;
  ctx.fillText(stepLabel(d.labels[Math.round(f)], d.step), W - 14, H - 16);
  ctx.globalAlpha = 1;
  const total = d.totals[i] + (d.totals[j] - d.totals[i]) * u;
  ctx.textAlign = "left";
  ctx.font = "12px Segoe UI, system-ui, sans-serif";
  // On phones the total sits on its own line above the date, so they don't overlap.
  ctx.fillText(narrow ? `${fmt(Math.round(total))} scrobbles so far` : `${fmt(Math.round(total))} scrobbles in this timeframe so far`,
    12, narrow ? H - 52 : H - 18);

  if (!race.dragging) $("#raceScrub").value = Math.round((race.t / race.duration) * 1000);
}

// ---------------------------------------------------------------- playing
function setPlayButton() {
  $("#racePlay").textContent = race.playing ? "⏸ Pause" : race.t >= race.duration ? "▶ Replay" : "▶ Play";
}
function tickRace(now) {
  const dt = race.last ? now - race.last : 16;
  race.last = now;
  race.t = Math.min(race.duration, race.t + dt);
  drawRace(dt);
  if (race.t >= race.duration) {
    race.playing = false;
    setPlayButton();
    finishRecording();
    return;
  }
  race.raf = requestAnimationFrame(tickRace);
}
function playRace() {
  if (!race.data) return;
  if (race.t >= race.duration) { race.t = 0; race.pos.clear(); }
  race.playing = true;
  race.last = 0;
  setPlayButton();
  cancelAnimationFrame(race.raf);
  race.raf = requestAnimationFrame(tickRace);
}
function pauseRace() {
  race.playing = false;
  cancelAnimationFrame(race.raf);
  setPlayButton();
}
$("#racePlay").addEventListener("click", () => (race.playing ? pauseRace() : playRace()));
$("#raceRestart").addEventListener("click", () => { race.t = 0; race.pos.clear(); drawRace(Infinity); playRace(); });
$("#raceScrub").addEventListener("input", (e) => {
  race.dragging = true;
  pauseRace();
  race.t = (Number(e.target.value) / 1000) * race.duration;
  drawRace(Infinity);
});
$("#raceScrub").addEventListener("change", () => { race.dragging = false; setPlayButton(); });
window.addEventListener("resize", () => drawRace(Infinity));
window.addEventListener("hashchange", () => { if (location.hash !== "#race") pauseRace(); });

// ---------------------------------------------------------------- record as video
$("#raceRecord").addEventListener("click", () => {
  const c = $("#raceCanvas");
  if (!race.data) return;
  if (race.recorder) { finishRecording(); return; }
  if (!window.MediaRecorder || !c.captureStream) { toast("This browser can't record video.", 6000); return; }
  const type = ["video/mp4;codecs=avc1", "video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) { toast("This browser can't record video.", 6000); return; }
  const rec = new MediaRecorder(c.captureStream(60), { mimeType: type, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    const ext = type.startsWith("video/mp4") ? "mp4" : "webm";
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(chunks, { type: type.split(";")[0] }));
    a.download = `scrobble-studio-bar-race-${KIND_WORD[race.data.kind]}.${ext}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Video saved (${ext.toUpperCase()}). Check your Downloads folder.`, 6000);
  };
  race.recorder = rec;
  $("#raceRecord").textContent = "■ Stop recording";
  $$("#raceGo, #racePlay, #raceRestart, #raceScrub").forEach((el) => (el.disabled = true));
  race.t = 0;
  race.pos.clear();
  drawRace(Infinity);
  rec.start();
  playRace();
});
function finishRecording() {
  if (!race.recorder) return;
  const rec = race.recorder;
  race.recorder = null;
  setTimeout(() => rec.state !== "inactive" && rec.stop(), 600);   // hold the last frame briefly
  pauseRace();
  $("#raceRecord").textContent = "● Record video";
  $$("#raceGo, #racePlay, #raceRestart, #raceScrub").forEach((el) => (el.disabled = false));
}

// Called by app.js when the page is opened: build a first race with the saved settings.
window.loadRace = () => (race.data ? drawRace(Infinity) : generateRace());
