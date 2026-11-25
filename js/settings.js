// Settings page: Last.fm details, import, Spotify, export, start over.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => Number(n).toLocaleString();

function toast(text, ms = 4000) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => (t.hidden = true), ms);
}

// ---------------------------------------------------------------- 5 · Experimental pages (menu rebuilds on reload)
$("#showLab").checked = !!window.showLab;
$("#showLab").addEventListener("change", (e) => {
  try { localStorage.setItem("ss-show-lab", e.target.checked ? "1" : "0"); } catch {}
  location.reload();
});

// ---------------------------------------------------------------- 1 · Last.fm
const s = Studio.settings();
$("#lfUser").value = s.lastfm_user || "";
$("#lfKey").value = s.lastfm_api_key || "";
$("#spId").value = s.spotify_client_id || "";

$("#saveLastfm").addEventListener("click", () => {
  const user = $("#lfUser").value.trim(), key = $("#lfKey").value.trim();
  if (!user || !/^[0-9a-f]{32}$/i.test(key)) { toast("Fill in your username and a 32-character API key.", 6000); return; }
  Studio.saveSettings({ ...Studio.settings(), lastfm_user: user, lastfm_api_key: key });
  toast("Last.fm details saved on this device.");
});

// ---------------------------------------------------------------- 2 · data
async function showData() {
  const d = await api("/api/data/info");
  const est = await Studio.storageEstimate();
  const items = [];
  if (d.scrobbles) items.push(["ok", `${fmt(d.scrobbles)} scrobbles, from ${d.first} to ${d.last}.`]);
  else items.push(["warn", "No scrobbles on this device yet."]);
  items.push([d.locations ? "ok" : "warn", d.locations ? `${d.locations} weather location period(s), ${fmt(d.weather_rows)} hours of weather.` : "No weather locations yet."]);
  if (est?.usage) items.push(["ok", `Using about ${Math.round(est.usage / 1e6)} MB of this device's storage.`]);
  $("#dataStatus").innerHTML = items.map(([c, t]) => `<li class="${c}">${esc(t)}</li>`).join("");
}

$("#csvFile").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const msg = $("#importMsg");
  msg.className = "msg";
  msg.textContent = `Reading ${file.name} (${Math.round(file.size / 1e6)} MB)…`;
  try {
    const r = await Studio.importCSV(await file.text());
    msg.textContent = `Imported: ${fmt(r.added)} new scrobbles (${fmt(r.read)} in the file). You now have ${fmt(r.total)}.`;
    showData();
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = err.message;
  }
  e.target.value = "";
});

$("#downloadAll").addEventListener("click", async () => {
  if (!confirm("Download your whole Last.fm history to this device? About 25 minutes for 120,000 scrobbles; keep this page open.")) return;
  const btn = $("#downloadAll"), msg = $("#importMsg");
  btn.disabled = true;
  msg.className = "msg";
  try {
    let st = await api("/api/refresh?mode=full", { method: "POST" });
    while (st.running) {
      await new Promise((r) => setTimeout(r, 1000));
      st = await api("/api/refresh/status");
      if (st.pages) msg.textContent = `Downloading page ${fmt(st.page)} of ${fmt(st.pages)}…`;
    }
    if (st.error) throw new Error(st.error);
    msg.textContent = `Done: ${fmt(st.total)} scrobbles on this device.`;
    showData();
  } catch (err) {
    msg.className = "msg err";
    msg.textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------------------------------------------------------------- 3 · Spotify
$("#redirectUri").textContent = Studio.redirectUri();
$("#redirectUri").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText(Studio.redirectUri()); toast("Copied."); } catch {}
});

async function showSpotify() {
  const st = await api("/api/spotify/status");
  $("#spStatus").textContent = st.connected ? `Connected as ${st.user}` : st.configured ? "Not connected yet" : "";
  $("#spDisconnect").hidden = !st.connected;
}
$("#spConnect").addEventListener("click", () => {
  const id = $("#spId").value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) { toast("Paste the 32-character Client ID from the Spotify dashboard.", 6000); return; }
  Studio.saveSettings({ ...Studio.settings(), spotify_client_id: id });
  Studio.spotifyLogin().catch((e) => toast(e.message, 8000));
});
$("#spDisconnect").addEventListener("click", () => {
  localStorage.removeItem("ss-spotify-token");
  showSpotify();
});

// ---------------------------------------------------------------- 4 · export
$("#exportBtn").addEventListener("click", async () => {
  await api("/api/data/info");                       // makes sure data is loaded
  const files = Studio.exportFiles();
  for (const [name, text] of Object.entries(files)) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    await new Promise((r) => setTimeout(r, 400));    // browsers block many downloads at once
  }
  toast("CSV files downloaded (check your Downloads folder).", 6000);
});

// ---------------------------------------------------------------- 5 · start over
$("#wipeBtn").addEventListener("click", async () => {
  if (!confirm("Delete all scrobbles, weather and locations on this device? This can't be undone (you can re-import Scrobbles.csv).")) return;
  await Studio.clearAll();
  toast("Data on this device deleted.");
  showData();
});

// ---------------------------------------------------------------- start
(async () => {
  try { await Studio.spotifyCallback(); } catch (e) { toast(e.message, 8000); }
  showData();
  showSpotify();
})();
