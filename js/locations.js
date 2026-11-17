// Weather locations page: edit where you lived when (stored on this device by engine.js).

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let rows = [];               // {place, admin, country, latitude, longitude, start_date, end_date}
let range = { first: null, last: null };
// api(path, options) comes from engine.js.

function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}

const placeLabel = (r) => [r.place, r.admin, r.country].filter(Boolean).join(", ");
const hasPlace = (r) => r.latitude !== null && r.latitude !== undefined && r.latitude !== "";
const today = () => new Date().toISOString().slice(0, 10);
const dayAfter = (d) => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() + 1); return x.toISOString().slice(0, 10); };
const dayBefore = (d) => { const x = new Date(d + "T12:00"); x.setDate(x.getDate() - 1); return x.toISOString().slice(0, 10); };

// ---------------------------------------------------------------- table
function render() {
  const body = $("#rows");
  body.innerHTML = "";
  rows.forEach((r, i) => {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><input type="date" class="from" value="${esc(r.start_date)}"></td>
      <td><input type="date" class="to" value="${esc(r.end_date)}" title="Leave empty = until now"></td>
      <td class="place-cell">
        <input type="text" class="place" placeholder="Search a city or village…" value="${esc(hasPlace(r) ? placeLabel(r) : "")}" autocomplete="off">
        <ul class="suggest" hidden></ul>
        <div class="coords">${hasPlace(r) ? `${Number(r.latitude).toFixed(2)}, ${Number(r.longitude).toFixed(2)}` : ""}</div>
      </td>
      <td><button class="x" title="Remove this period">×</button></td>`;

    tr.querySelector(".from").addEventListener("change", (e) => { r.start_date = e.target.value; check(); });
    tr.querySelector(".to").addEventListener("change", (e) => { r.end_date = e.target.value; check(); });
    tr.querySelector(".x").addEventListener("click", () => { rows.splice(i, 1); render(); });

    const input = tr.querySelector(".place");
    const list = tr.querySelector(".suggest");
    const coords = tr.querySelector(".coords");
    let timer;
    input.addEventListener("input", () => {
      // Typing again means the old pick is no longer valid until a new suggestion is chosen.
      r.latitude = r.longitude = null;
      coords.textContent = "";
      check();
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const q = input.value.trim();
        if (q.length < 2) { list.hidden = true; return; }
        try {
          const { results } = await api("/api/geocode?q=" + encodeURIComponent(q));
          list.innerHTML = results.length
            ? results.map((x, k) => `<li data-k="${k}">${esc(placeLabel(x))} <span class="hint">${x.latitude.toFixed(2)}, ${x.longitude.toFixed(2)}</span></li>`).join("")
            : `<li class="none">No places found</li>`;
          list.hidden = false;
          list.querySelectorAll("li[data-k]").forEach((li) =>
            li.addEventListener("mousedown", (ev) => {
              ev.preventDefault();
              Object.assign(r, results[Number(li.dataset.k)]);
              input.value = placeLabel(r);
              coords.textContent = `${r.latitude.toFixed(2)}, ${r.longitude.toFixed(2)}`;
              list.hidden = true;
              check();
            })
          );
        } catch (e) {
          list.innerHTML = `<li class="none">Search failed: ${esc(e.message)}</li>`;
          list.hidden = false;
        }
      }, 350);
    });
    input.addEventListener("blur", () => setTimeout(() => (list.hidden = true), 150));
    body.appendChild(tr);
  });
  if (!rows.length) body.innerHTML = `<tr><td colspan="4" class="hint">No periods yet. Click “+ Add period”.</td></tr>`;
  check();
}

// ---------------------------------------------------------------- checks
// Errors (red) block saving; warnings (amber) are gaps where scrobbles won't get weather.
function check() {
  const errors = [], warnings = [];
  rows.forEach((r, i) => {
    const n = `Row ${i + 1}`;
    if (!r.start_date) errors.push(`${n}: fill in the From date.`);
    if (!hasPlace(r)) errors.push(`${n}: pick a place from the search suggestions.`);
    if (r.start_date && r.end_date && r.end_date < r.start_date) errors.push(`${n}: To is before From.`);
  });

  const sorted = rows.filter((r) => r.start_date).slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
  sorted.forEach((r, i) => {
    const next = sorted[i + 1];
    if (!next) return;
    const name = r.place || "a period";
    if (!r.end_date) errors.push(`Only the latest period can be open-ended. Give ${name} a To date.`);
    else if (next.start_date <= r.end_date) errors.push(`${name} and ${next.place || "the next period"} overlap.`);
    else if (dayAfter(r.end_date) < next.start_date)
      warnings.push(`Gap from ${dayAfter(r.end_date)} to ${dayBefore(next.start_date)}: no weather for those scrobbles.`);
  });
  if (sorted.length && range.first && sorted[0].start_date > range.first)
    warnings.push(`Your scrobbles start on ${range.first}, but the first period starts on ${sorted[0].start_date}.`);
  const last = sorted[sorted.length - 1];
  if (last && last.end_date && last.end_date < today())
    warnings.push(`The last period ends on ${last.end_date}. Leave To empty if you still live there.`);

  $("#checks").innerHTML =
    errors.map((e) => `<li class="err">${esc(e)}</li>`).join("") +
    warnings.map((w) => `<li class="warn">${esc(w)}</li>`).join("") +
    (rows.length && !errors.length && !warnings.length ? `<li class="ok">All your scrobbles are covered.</li>` : "");
  $("#saveBtn").disabled = errors.length > 0 || rows.length === 0;
}

// ---------------------------------------------------------------- buttons
$("#addBtn").addEventListener("click", () => {
  const sorted = rows.slice().sort((a, b) => (a.start_date || "").localeCompare(b.start_date || ""));
  const last = sorted[sorted.length - 1];
  const start = !last ? range.first || "" : last.end_date ? dayAfter(last.end_date) : "";
  rows.push({ place: "", admin: "", country: "", latitude: null, longitude: null, start_date: start, end_date: "" });
  render();
  const inputs = document.querySelectorAll(".place");
  inputs[inputs.length - 1]?.focus();
});

$("#saveBtn").addEventListener("click", async () => {
  const btn = $("#saveBtn");
  btn.disabled = true;
  try {
    const { periods } = await api("/api/locations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ periods: rows }),
    });
    rows = periods;
    render();
    toast("Locations saved on this device.");
  } catch (e) {
    toast("Not saved: " + e.message, 8000);
    check();
  }
});

// ---------------------------------------------------------------- weather download
const fmt = (n) => Number(n).toLocaleString();

function showWeather(s) {
  const pct = s.scrobbles ? Math.round((100 * s.with_weather) / s.scrobbles) : 0;
  const items = [];
  if (s.weather_rows) {
    items.push([pct >= 99 ? "ok" : "warn",
      `${fmt(s.with_weather)} of ${fmt(s.scrobbles)} scrobbles (${pct}%) have weather.`]);
    items.push(["ok", `${fmt(s.weather_rows)} hours of weather, from ${s.weather_from} to ${s.weather_to}.`]);
  } else {
    items.push(["warn", "No weather downloaded yet."]);
  }
  if (s.with_location < s.scrobbles)
    items.push(["warn", `${fmt(s.scrobbles - s.with_location)} scrobbles fall outside your location periods.`]);
  if (s.error) items.push(["err", s.error]);
  $("#weatherStatus").innerHTML = items.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join("");
}

async function followWeather(s) {
  const btn = $("#weatherBtn");
  btn.disabled = true;
  btn.textContent = "Planning…";
  while (s.running) {
    await new Promise((r) => setTimeout(r, 1000));
    s = await api("/api/weather/status");
    if (s.jobs) btn.textContent = `Downloading ${s.done} of ${s.jobs}…`;
  }
  btn.disabled = false;
  btn.textContent = "Download weather";
  showWeather(s);
  if (!s.error) toast(s.added ? `Added ${fmt(s.added)} hours of weather.` : "Weather is already up to date.");
}

$("#weatherBtn").addEventListener("click", async () => {
  try {
    followWeather(await api("/api/weather/update", { method: "POST" }));
  } catch (e) {
    toast("Weather download failed: " + e.message, 8000);
  }
});

api("/api/weather/status").then((s) => {
  showWeather(s);
  if (s.running) followWeather(s);
}).catch(() => {});

// ---------------------------------------------------------------- start
api("/api/locations").then((d) => {
  rows = d.periods;
  range = { first: d.first, last: d.last };
  $("#range").textContent = d.first ? `Your scrobbles run from ${d.first} to ${d.last}.` : "";
  render();
}).catch((e) => toast("Couldn't load locations: " + e.message, 8000));
