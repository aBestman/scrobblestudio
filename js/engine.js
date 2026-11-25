// Scrobble Studio engine: everything the old app.py did, but inside the browser.
//
// Your data lives in this browser's own storage (IndexedDB) on this device.
// api(path, options) answers the same "/api/..." questions the Python server used to,
// so the page code (app.js, locations.js, settings.js) barely had to change.

(() => {
  "use strict";

  // ------------------------------------------------------------------ small helpers
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July",
    "August", "September", "October", "November", "December"];
  const MON = MONTHS.map((m) => m.slice(0, 3));
  const ymdLocal = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const ymdUTC = (ms) => new Date(ms).toISOString().slice(0, 10);
  const addDaysUTC = (ymd, n) => ymdUTC(Date.parse(ymd + "T00:00:00Z") + n * 86400000);
  const intArg = (v, def, lo, hi) => {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
  };
  const fail = (msg) => { throw new Error(msg); };

  // ------------------------------------------------------------------ settings (small, in localStorage)
  const SETTINGS_KEY = "ss-settings";
  function settings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch { return {}; }
  }
  function saveSettings(s) { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); }
  function lastfmCreds() {
    const s = settings();
    if (!s.lastfm_user || !s.lastfm_api_key) fail("Fill in your Last.fm username and API key in Settings first.");
    return s;
  }

  // ------------------------------------------------------------------ IndexedDB (big data)
  const DB_NAME = "scrobble-studio", STORE = "kv";
  let dbPromise;
  function db() {
    dbPromise ||= new Promise((res, rej) => {
      const r = indexedDB.open(DB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    return dbPromise;
  }
  async function dbGet(key) {
    const d = await db();
    return new Promise((res, rej) => {
      const q = d.transaction(STORE).objectStore(STORE).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror = () => rej(q.error);
    });
  }
  async function dbSet(key, value) {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(value, key);
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function dbClear() {
    const d = await db();
    return new Promise((res, rej) => {
      const tx = d.transaction(STORE, "readwrite");
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }

  // ------------------------------------------------------------------ scrobbles in memory
  // Stored as compact rows: [uts, artist, album, track, artist_mbid, album_mbid, track_mbid]
  const E = { raw: null, rows: null, locations: null, weather: null, wIndex: null, daily: null, joined: false, tagCache: null };

  function toRow(r) {
    const d = new Date(r[0] * 1000);
    const y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return {
      uts: r[0], artist: r[1], album: r[2], track: r[3],
      key: r[1].trim().toLowerCase() + "\x1f" + r[3].trim().toLowerCase(),
      y, m, ym: `${y}-${pad(m)}`, ymd: `${y}-${pad(m)}-${pad(day)}`,
      hh: d.getHours(), mi: d.getMinutes(), dow: (d.getDay() + 6) % 7,
      doy: Math.round((Date.UTC(y, m - 1, day) - Date.UTC(y, 0, 0)) / 86400000),
    };
  }
  function buildRows() {
    E.rows = E.raw.filter((r) => r[0] > 1e9).sort((a, b) => a[0] - b[0]).map(toRow);
    // First day you ever played each song / artist (for "new discoveries" on the Trends page).
    E.firstSong = new Map();
    E.firstArtist = new Map();
    for (const r of E.rows) {
      if (!E.firstSong.has(r.key)) E.firstSong.set(r.key, r.ymd);
      if (!E.firstArtist.has(r.artist)) E.firstArtist.set(r.artist, r.ymd);
    }
    E.joined = false;
  }
  async function ensureData() {
    if (E.rows) return;
    E.raw = (await dbGet("scrobbles")) || [];
    E.locations = (await dbGet("locations")) || [];
    E.weather = (await dbGet("weather")) || {};
    E.tagCache = (await dbGet("tagCache")) || {};
    buildRows();
    buildWeatherIndex();
  }
  async function saveScrobbles(raw, keepBackup) {
    if (keepBackup && E.raw && E.raw.length) await dbSet("scrobbles_backup", E.raw);
    E.raw = raw;
    await dbSet("scrobbles", raw);
    buildRows();
  }
  const dedupeKey = (r) => r[0] + "|" + r[1] + "|" + r[3];
  function mergeRaw(existing, incoming) {
    const seen = new Set(existing.map(dedupeKey));
    const out = existing.slice();
    let added = 0;
    for (const r of incoming) {
      const k = dedupeKey(r);
      if (!seen.has(k)) { seen.add(k); out.push(r); added++; }
    }
    return { out, added };
  }

  // ------------------------------------------------------------------ CSV in / out
  function parseCSV(text) {
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const rows = [];
    let row = [], i = 0;
    const n = text.length;
    while (i < n) {
      let field;
      if (text[i] === '"') {
        let j = i + 1, s = "";
        for (;;) {
          const q = text.indexOf('"', j);
          if (q < 0) { s += text.slice(j); i = n; break; }
          s += text.slice(j, q);
          if (text[q + 1] === '"') { s += '"'; j = q + 2; } else { i = q + 1; break; }
        }
        field = s;
      } else {
        let j = i;
        while (j < n && text[j] !== "," && text[j] !== "\n" && text[j] !== "\r") j++;
        field = text.slice(i, j);
        i = j;
      }
      row.push(field);
      if (text[i] === ",") { i++; continue; }
      if (text[i] === "\r") i++;
      if (text[i] === "\n") i++;
      rows.push(row);
      row = [];
    }
    if (row.length) rows.push(row);
    return rows;
  }
  const csvCell = (v) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const toCSV = (header, rows) => [header.join(","), ...rows.map((r) => r.map(csvCell).join(","))].join("\n") + "\n";
  function lastfmTimeText(uts) {   // "08 May 2026, 18:07" (UTC), same as Last.fm / the old CSV
    const d = new Date(uts * 1000);
    return `${pad(d.getUTCDate())} ${MON[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }

  async function importCSV(text) {
    await ensureData();
    const rows = parseCSV(text);
    const head = (rows.shift() || []).map((h) => h.trim().toLowerCase());
    const col = (name) => head.indexOf(name);
    const iU = col("uts"), iA = col("artist"), iAl = col("album"), iT = col("track");
    if (iU < 0 || iA < 0 || iT < 0) fail("This doesn't look like Scrobbles.csv (needs uts, artist, album and track columns).");
    const iAm = col("artist_mbid"), iAlm = col("album_mbid"), iTm = col("track_mbid");
    const incoming = [];
    for (const r of rows) {
      const uts = parseInt(r[iU], 10);
      if (!(uts > 1e9)) continue;
      incoming.push([uts, r[iA] || "", iAl >= 0 ? r[iAl] || "" : "", r[iT] || "",
        iAm >= 0 ? r[iAm] || "" : "", iAlm >= 0 ? r[iAlm] || "" : "", iTm >= 0 ? r[iTm] || "" : ""]);
    }
    if (!incoming.length) fail("No scrobbles found in this file.");
    const { out, added } = mergeRaw(E.raw, incoming);
    await saveScrobbles(out, false);
    try { await navigator.storage?.persist?.(); } catch {}   // ask the browser not to clear our data
    return { read: incoming.length, added, total: E.rows.length };
  }

  function exportScrobblesCSV() {
    const sorted = E.raw.slice().sort((a, b) => b[0] - a[0]);
    return toCSV(["uts", "utc_time", "artist", "artist_mbid", "album", "album_mbid", "track", "track_mbid"],
      sorted.map((r) => [r[0], lastfmTimeText(r[0]), r[1], r[4], r[2], r[5], r[3], r[6]]));
  }

  // ------------------------------------------------------------------ filters
  function filtered(q, rows = E.rows) {
    const start = q.get("start"), end = q.get("end");
    const A = q.getAll("sel_artist"), T = q.getAll("sel_track"), AL = q.getAll("sel_album");
    if (!start && !end && !A.length && !T.length && !AL.length) return rows;
    const a = A.length ? new Set(A) : null, t = T.length ? new Set(T) : null, al = AL.length ? new Set(AL) : null;
    return rows.filter((r) =>
      (!start || r.ymd >= start) && (!end || r.ymd <= end) &&
      (!a || a.has(r.artist)) && (!t || t.has(r.key)) && (!al || al.has(r.artist + "\x1f" + r.album)));
  }

  // ------------------------------------------------------------------ counting + h-index
  function countBy(rows, f) {
    const m = new Map();
    for (const r of rows) {
      const k = f(r);
      if (k === null || k === undefined) continue;
      m.set(k, (m.get(k) || 0) + 1);
    }
    return m;
  }
  // h-index: the largest h such that h items have at least h plays each.
  function hIndex(counts) {
    const c = Array.from(counts).sort((a, b) => b - a);
    let h = 0;
    while (h < c.length && c[h] >= h + 1) h++;
    return h;
  }
  // h-index per group, e.g. per artist over its songs.
  function hBy(rows, groupOf, itemOf) {
    const groups = new Map();
    for (const r of rows) {
      const g = groupOf(r);
      if (g === null || g === undefined) continue;
      let inner = groups.get(g);
      if (!inner) groups.set(g, (inner = new Map()));
      const k = itemOf(r);
      inner.set(k, (inner.get(k) || 0) + 1);
    }
    const out = new Map();
    for (const [g, inner] of groups) out.set(g, hIndex(inner.values()));
    return out;
  }
  const albumOf = (r) => (r.album ? r.artist + "\x1f" + r.album : null);
  const hOverall = (rows) => ({
    h_artist: hIndex(countBy(rows, (r) => r.artist).values()),
    h_song: hIndex(countBy(rows, (r) => r.key).values()),
    h_album: hIndex(countBy(rows, albumOf).values()),
  });

  // ------------------------------------------------------------------ time periods
  const PERIOD_OF = { year: (r) => String(r.y), month: (r) => r.ym, day: (r) => r.ymd };
  const periodBy = (q) => (["year", "day"].includes(q.get("by")) ? q.get("by") : "month");
  function periodRange(by, first, last) {
    const out = [];
    if (by === "year") {
      for (let y = +first; y <= +last; y++) out.push(String(y));
    } else if (by === "month") {
      let [y, m] = first.split("-").map(Number);
      const [ly, lm] = last.split("-").map(Number);
      while (y < ly || (y === ly && m <= lm)) { out.push(`${y}-${pad(m)}`); if (++m > 12) { m = 1; y++; } }
    } else {
      const d = new Date(first + "T12:00"), L = new Date(last + "T12:00");
      while (d <= L) { out.push(ymdLocal(d)); d.setDate(d.getDate() + 1); }
    }
    return out;
  }

  // ------------------------------------------------------------------ dashboard answers
  function summary(q) {
    const rows = filtered(q);
    if (!rows.length) return { scrobbles: 0, artists: 0, tracks: 0, albums: 0, first: null, last: null, per_day: 0, ...hOverall(rows) };
    const first = rows[0].ymd, last = rows[rows.length - 1].ymd;
    const days = Math.max(1, Math.round((Date.parse(last) - Date.parse(first)) / 86400000) + 1);
    return {
      ...hOverall(rows),
      scrobbles: rows.length,
      artists: new Set(rows.map((r) => r.artist)).size,
      tracks: new Set(rows.map((r) => r.key)).size,
      albums: new Set(rows.map(albumOf).filter(Boolean)).size,
      first, last, per_day: Math.round((rows.length / days) * 10) / 10,
    };
  }

  function timeline(q) {
    const rows = filtered(q);
    if (!rows.length) return { labels: [], values: [], h_artist: [], h_song: [], h_album: [] };
    const by = periodBy(q), P = PERIOD_OF[by];
    const labels = periodRange(by, P(rows[0]), P(rows[rows.length - 1]));
    const counts = countBy(rows, P);
    const ha = hBy(rows, P, (r) => r.artist), hs = hBy(rows, P, (r) => r.key);
    const hal = hBy(rows.filter((r) => r.album), P, albumOf);
    return {
      labels, values: labels.map((l) => counts.get(l) || 0),
      h_artist: labels.map((l) => ha.get(l) || 0), h_song: labels.map((l) => hs.get(l) || 0),
      h_album: labels.map((l) => hal.get(l) || 0),
    };
  }

  // Top artists / songs / albums, ranked by plays or by h-index.
  // h: artists and albums = h songs with >= h plays; songs = h months with >= h plays.
  function top(q) {
    const rows = filtered(q);
    const kind = q.get("kind") || "artist";
    const limit = intArg(q.get("limit"), 15, 1, 100);
    const byH = q.get("rank") === "h";
    const order = (a, b) => (byH ? b.h - a.h || b.plays - a.plays : b.plays - a.plays || b.h - a.h);
    if (!rows.length) return { items: [] };

    if (kind === "track") {
      const g = new Map();
      for (const r of rows) {
        let e = g.get(r.key);
        if (!e) g.set(r.key, (e = { key: r.key, artist: r.artist, track: r.track, plays: 0 }));
        e.plays++;
      }
      const h = hBy(rows, (r) => r.key, (r) => r.ym);
      const items = [...g.values()];
      items.forEach((e) => (e.h = h.get(e.key) || 0));
      return { items: items.sort(order).slice(0, limit) };
    }
    if (kind === "album") {
      const g = new Map();
      const withAlbum = rows.filter((r) => r.album);
      for (const r of withAlbum) {
        const id = albumOf(r);
        let e = g.get(id);
        if (!e) g.set(id, (e = { id, artist: r.artist, album: r.album, plays: 0, songs: new Set() }));
        e.plays++;
        e.songs.add(r.key);
      }
      const h = hBy(withAlbum, albumOf, (r) => r.key);
      const items = [...g.values()].map((e) => ({ artist: e.artist, album: e.album, plays: e.plays, songs: e.songs.size, h: h.get(e.id) || 0 }));
      return { items: items.sort(order).slice(0, limit) };
    }
    const g = new Map();
    for (const r of rows) {
      let e = g.get(r.artist);
      if (!e) g.set(r.artist, (e = { artist: r.artist, plays: 0, songs: new Set() }));
      e.plays++;
      e.songs.add(r.key);
    }
    const h = hBy(rows, (r) => r.artist, (r) => r.key);
    const items = [...g.values()].map((e) => ({ artist: e.artist, plays: e.plays, songs: e.songs.size, h: h.get(e.artist) || 0 }));
    return { items: items.sort(order).slice(0, limit) };
  }

  function artistsOverTime(q) {
    const rows = filtered(q);
    if (!rows.length) return { labels: [], series: [] };
    const by = periodBy(q), P = PERIOD_OF[by];
    const n = intArg(q.get("n"), 8, 1, 25);
    const topNames = [...countBy(rows, (r) => r.artist)].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);
    const labels = periodRange(by, P(rows[0]), P(rows[rows.length - 1]));
    const want = new Set(topNames);
    const counts = new Map(topNames.map((a) => [a, new Map()]));
    for (const r of rows) {
      if (!want.has(r.artist)) continue;
      const m = counts.get(r.artist), p = P(r);
      m.set(p, (m.get(p) || 0) + 1);
    }
    return { labels, series: topNames.map((a) => ({ artist: a, values: labels.map((l) => counts.get(a).get(l) || 0) })) };
  }

  // ------------------------------------------------------------------ Trends: how period A changed period B's chart
  // Every period ends today, so the shorter one always sits inside the longer one
  // (today ⊂ this week ⊂ this month …). For each song/artist/album we compare its rank in the
  // longer period WITH the shorter period against its rank WITHOUT it.
  const PERIOD_NAMES = {
    today: "today", week: "this week", month: "this month", year: "this year",
    "7d": "the last 7 days", "30d": "the last 30 days", "365d": "the last 365 days", all: "all time",
  };
  function periodStart(key) {
    const now = new Date();
    const t = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const back = (n) => ymdLocal(new Date(t.getFullYear(), t.getMonth(), t.getDate() - n));
    switch (key) {
      case "today": return ymdLocal(t);
      case "week": return back((t.getDay() + 6) % 7);          // since Monday
      case "month": return ymdLocal(new Date(t.getFullYear(), t.getMonth(), 1));
      case "year": return `${t.getFullYear()}-01-01`;
      case "7d": return back(6);
      case "30d": return back(29);
      case "365d": return back(364);
      case "all": return "0000-01-01";                           // before any scrobble
      default: fail(`Unknown period: ${key}`);
    }
  }
  // Competition ranking: equal play counts share a rank (1, 2, 2, 4 …).
  function rankMap(counts) {
    const sorted = [...counts].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])));
    const ranks = new Map();
    let prev = null, rank = 0;
    sorted.forEach(([k, n], i) => { if (n !== prev) { rank = i + 1; prev = n; } ranks.set(k, rank); });
    return { sorted, ranks };
  }

  function trends(q) {
    const aKey = q.get("a") || "today", bKey = q.get("b") || "week";
    const n = intArg(q.get("n"), 25, 5, 100);
    const aStart = periodStart(aKey), bStart = periodStart(bKey);
    const swapped = aStart < bStart;                   // A is the longer one: B becomes the "recent" period
    const recentKey = swapped ? bKey : aKey, chartKey = swapped ? aKey : bKey;
    const recentStart = swapped ? bStart : aStart, chartStart = swapped ? aStart : bStart;
    const chart = E.rows.filter((r) => r.ymd >= chartStart);
    const recent = chart.filter((r) => r.ymd >= recentStart);
    const before = chart.filter((r) => r.ymd < recentStart);

    const KINDS = {
      track: { id: (r) => r.key, info: (r) => ({ track: r.track, artist: r.artist }) },
      artist: { id: (r) => r.artist, info: (r) => ({ artist: r.artist }) },
      album: { id: albumOf, info: (r) => ({ album: r.album, artist: r.artist }) },
    };
    const kinds = {};
    for (const [name, K] of Object.entries(KINDS)) {
      const info = new Map();
      for (const r of chart) { const k = K.id(r); if (k !== null && !info.has(k)) info.set(k, K.info(r)); }
      const cChart = countBy(chart, K.id), cBefore = countBy(before, K.id), cRecent = countBy(recent, K.id);
      const now = rankMap(cChart), was = rankMap(cBefore);
      const row = (k) => ({
        id: k, ...info.get(k), plays: cChart.get(k) || 0, recent_plays: cRecent.get(k) || 0,
        rank: now.ranks.get(k) ?? null, was: was.ranks.get(k) ?? null,
      });
      kinds[name] = {
        items: now.sorted.slice(0, n).map(([k]) => row(k)),
        // Pushed out of the top N by what happened in the recent period.
        dropped: was.sorted.filter(([k]) => was.ranks.get(k) <= n && now.ranks.get(k) > n).slice(0, 5).map(([k]) => row(k)),
      };
    }

    const hNow = hOverall(chart), hWas = hOverall(before);
    const newSongs = new Set(recent.filter((r) => E.firstSong.get(r.key) >= recentStart).map((r) => r.key));
    const newArtists = new Set(recent.filter((r) => E.firstArtist.get(r.artist) >= recentStart).map((r) => r.artist));

    return {
      a: { key: aKey, label: PERIOD_NAMES[aKey], start: aStart },
      b: { key: bKey, label: PERIOD_NAMES[bKey], start: bStart },
      recent: { key: recentKey, label: PERIOD_NAMES[recentKey], start: recentStart },
      chart: { key: chartKey, label: PERIOD_NAMES[chartKey], start: chartStart },
      swapped, same: aStart === bStart, n,
      summary: {
        recent_plays: recent.length, chart_plays: chart.length,
        share: chart.length ? Math.round((1000 * recent.length) / chart.length) / 10 : 0,
        h_now: hNow, h_was: hWas, new_songs: newSongs.size, new_artists: newArtists.size,
      },
      kinds,
    };
  }

  // ------------------------------------------------------------------ Scrobbles page: backdrop (b) + insight (a)
  // The backdrop is the big picture (default: this year); the insight is a shorter period inside it
  // (default: today). Everything shows the backdrop's totals plus what the insight added (+N).
  const LEVEL = { today: 0, week: 1, "7d": 1, month: 2, "30d": 2, year: 3, "365d": 3, all: 4 };
  function overviewWindow(q) {
    const bKey = q.get("b") || "year", aKey = q.get("a") || "today";
    if (!(bKey in LEVEL) || !(aKey in LEVEL)) fail("Unknown period.");
    if (LEVEL[aKey] >= LEVEL[bKey]) fail("The insight period must be at least one level shorter than the backdrop.");
    const bStart = periodStart(bKey);
    let aStart = periodStart(aKey);
    if (aStart < bStart) aStart = bStart;          // e.g. a week that began last month: only its part inside the backdrop counts
    return { aKey, bKey, aStart, bStart };
  }
  function splitRows(q) {
    const w = overviewWindow(q);
    const chart = filtered(q).filter((r) => r.ymd >= w.bStart);   // filtered(): the click selection only
    return { w, chart, recent: chart.filter((r) => r.ymd >= w.aStart), before: chart.filter((r) => r.ymd < w.aStart) };
  }

  function overview(q) {
    const { w, chart, recent, before } = splitRows(q);
    const uniq = (rs, f) => { const s = new Set(); for (const r of rs) { const k = f(r); if (k !== null) s.add(k); } return s.size; };
    const count = (f) => { const total = uniq(chart, f); return { total, added: total - uniq(before, f) }; };
    const today = ymdLocal(new Date());
    const firstDay = chart.length ? (chart[0].ymd > w.bStart ? chart[0].ymd : w.bStart) : today;
    const daysB = Math.max(1, Math.round((Date.parse(today) - Date.parse(firstDay)) / 86400000) + 1);
    const daysA = Math.max(1, Math.round((Date.parse(today) - Date.parse(w.aStart)) / 86400000) + 1);
    // Average per day before the insight period started (null if the backdrop has no days before it).
    const daysBefore = Math.round((Date.parse(w.aStart) - Date.parse(firstDay)) / 86400000);
    const perDay = Math.round((chart.length / daysB) * 10) / 10;
    const perDayWas = daysBefore > 0 ? Math.round((before.length / daysBefore) * 10) / 10 : null;
    return {
      backdrop: { key: w.bKey, label: PERIOD_NAMES[w.bKey], start: w.bStart },
      insight: { key: w.aKey, label: PERIOD_NAMES[w.aKey], start: w.aStart },
      first: chart[0]?.ymd || null, last: chart[chart.length - 1]?.ymd || null,
      scrobbles: { total: chart.length, added: recent.length },
      artists: count((r) => r.artist), songs: count((r) => r.key), albums: count(albumOf),
      per_day: perDay,
      per_day_change: perDayWas === null ? null : Math.round((perDay - perDayWas) * 10) / 10,
      insight_per_day: Math.round((recent.length / daysA) * 10) / 10,
      // h-index of the backdrop with the insight (now) and without it (was)
      h_now: hOverall(chart), h_was: hOverall(before),
      // Played for the very first time ever during the insight period
      new_songs: new Set(recent.filter((r) => E.firstSong.get(r.key) >= w.aStart).map((r) => r.key)).size,
      new_artists: new Set(recent.filter((r) => E.firstArtist.get(r.artist) >= w.aStart).map((r) => r.artist)).size,
    };
  }

  // Top list of the backdrop, with what the insight added and how it moved each entry.
  function movers(q) {
    const { w, chart, recent, before } = splitRows(q);
    const kind = ["track", "album"].includes(q.get("kind")) ? q.get("kind") : "artist";
    const n = intArg(q.get("n"), 25, 5, 100);
    const id = kind === "track" ? (r) => r.key : kind === "album" ? albumOf : (r) => r.artist;
    const info = new Map(), songs = new Map();
    for (const r of chart) {
      const k = id(r);
      if (k === null) continue;
      if (!info.has(k)) info.set(k, kind === "track" ? { track: r.track, artist: r.artist } : kind === "album" ? { album: r.album, artist: r.artist } : { artist: r.artist });
      if (kind !== "track") { let s = songs.get(k); if (!s) songs.set(k, (s = new Set())); s.add(r.key); }
    }
    const cChart = countBy(chart, id), cBefore = countBy(before, id), cRecent = countBy(recent, id);
    const now = rankMap(cChart), was = rankMap(cBefore);
    const row = (k) => ({
      id: k, ...info.get(k), plays: cChart.get(k) || 0, added: cRecent.get(k) || 0,
      songs: songs.get(k)?.size || 0, rank: now.ranks.get(k) ?? null, was: was.ranks.get(k) ?? null,
    });
    return {
      insight: PERIOD_NAMES[w.aKey], n,
      items: now.sorted.slice(0, n).map(([k]) => row(k)),
      dropped: was.sorted.filter(([k]) => was.ranks.get(k) <= n && now.ranks.get(k) > n).slice(0, 5).map(([k]) => row(k)),
    };
  }

  // ------------------------------------------------------------------ Song deep dive
  let songIndex = null;                                   // key -> { key, track, artist, plays }, rebuilt when data changes
  function songs() {
    if (songIndex && songIndex.rows === E.rows) return songIndex.list;
    const m = new Map();
    for (const r of E.rows) {
      let s = m.get(r.key);
      if (!s) m.set(r.key, (s = { key: r.key, track: r.track, artist: r.artist, plays: 0 }));
      s.plays++;
    }
    const list = [...m.values()].sort((a, b) => b.plays - a.plays);
    songIndex = { rows: E.rows, list, byKey: m };
    return list;
  }
  const songOf = (key) => { songs(); return songIndex.byKey.get(key) || fail("That song isn't in your scrobbles."); };

  // Search: every word must appear in the name or the artist; most played first.
  // ?kind=artist|song|album (default song) searches artists, songs or albums.
  function songSearch(q) {
    const words = (q.get("q") || "").toLowerCase().split(/\s+/).filter(Boolean);
    const limit = intArg(q.get("limit"), 12, 1, 50);
    const kind = kindArg(q), list = kind === "song" ? songs() : dive(kind).list;
    if (!words.length) return { kind, items: list.slice(0, limit) };
    const items = [];
    for (const s of list) {
      const hay = (kind === "artist" ? s.artist : (kind === "song" ? s.track : s.name) + " " + s.artist).toLowerCase();
      if (words.every((w) => hay.includes(w))) { items.push(s); if (items.length >= limit) break; }
    }
    return { items };
  }

  const dayNum = (ymd) => Math.round(Date.parse(ymd + "T00:00:00Z") / 86400000);

  // ------------------------------------------------------------------ Deep Dive: one artist, song or album
  // ?kind=artist|song|album (default song). Keys are the same ids the Scrobbles page lists use:
  // song = "artist\x1ftrack" lowercased, artist = the artist name, album = "artist\x1falbum".
  const DIVE_KINDS = ["artist", "song", "album"];
  const DIVE_KEY = { song: (r) => r.key, artist: (r) => r.artist, album: albumOf };
  let diveCache = { rows: null };
  function dive(kind) {                                     // { keys (one per scrobble, in E.rows order), list, byKey }
    if (diveCache.rows !== E.rows) diveCache = { rows: E.rows };
    if (diveCache[kind]) return diveCache[kind];
    const keys = E.rows.map(DIVE_KEY[kind]), byKey = new Map();
    E.rows.forEach((r, i) => {
      const k = keys[i];
      if (k === null) return;
      let s = byKey.get(k);
      if (!s) byKey.set(k, (s = { key: k, kind, name: kind === "song" ? r.track : kind === "album" ? r.album : r.artist, artist: r.artist, track: r.track, album: r.album, plays: 0 }));
      s.plays++;
    });
    const list = [...byKey.values()].sort((a, b) => b.plays - a.plays);
    return (diveCache[kind] = { keys, list, byKey });
  }
  const kindArg = (q) => (DIVE_KINDS.includes(q.get("kind")) ? q.get("kind") : "song");
  const itemOf = (kind, key) => dive(kind).byKey.get(key) || fail(`That ${kind} isn't in your scrobbles.`);
  const firstIndexFrom = (ymd) => { let lo = 0, hi = E.rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (E.rows[m].ymd < ymd) lo = m + 1; else hi = m; } return lo; };
  const mostCommon = (vals) => { const c = new Map(); let best = null, n = 0; for (const v of vals) { if (v === null) continue; const k = (c.get(v) || 0) + 1; c.set(v, k); if (k > n) { n = k; best = v; } } return best; };

  function songInfo(q) {
    const kind = kindArg(q);
    const { keys, list } = dive(kind);
    const s = itemOf(kind, q.get("key"));
    const idx = [];                                        // positions of its scrobbles in E.rows
    keys.forEach((k, i) => { if (k === s.key) idx.push(i); });
    const plays = idx.map((i) => E.rows[i]);
    const days = [...new Set(plays.map((r) => r.ymd))];   // already in time order
    const today = ymdLocal(new Date());
    // Longest stretch of days without a play: between listening days, and from the last one until today.
    let gap = { days: 0, from: null, to: null, ongoing: false };
    for (let i = 1; i <= days.length; i++) {
      const a = days[i - 1], b = i < days.length ? days[i] : today;
      const d = dayNum(b) - dayNum(a) - (i < days.length ? 1 : 0);
      if (d > gap.days) gap = { days: d, from: addDaysUTC(a, 1), to: i < days.length ? addDaysUTC(b, -1) : today, ongoing: i === days.length };
    }
    const first = plays[0], last = plays[plays.length - 1];

    // Played together: for each scrobble, the top 3 other items (same kind) within ±2 days; then the ones
    // that most often make that top 3. Two pointers keep a running count of the ±2-day window.
    const W = 2 * 86400, win = new Map(), tally = new Map();
    let lo = 0, hi = 0;
    for (const i of idx) {
      const t = E.rows[i].uts;
      while (hi < E.rows.length && E.rows[hi].uts <= t + W) { const k = keys[hi++]; if (k !== null) win.set(k, (win.get(k) || 0) + 1); }
      while (E.rows[lo].uts < t - W) { const k = keys[lo++]; if (k === null) continue; const n = win.get(k) - 1; if (n) win.set(k, n); else win.delete(k); }
      const top3 = [...win].filter(([k]) => k !== s.key).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 3);
      for (const [k, n] of top3) {
        const e = tally.get(k) || { times: 0, plays: 0 };
        e.times++; e.plays += n;
        tally.set(k, e);
      }
    }
    const together = [...tally].sort((a, b) => b[1].times - a[1].times || b[1].plays - a[1].plays).slice(0, 5)
      .map(([k, e]) => ({ ...itemOf(kind, k), times: e.times, of: idx.length }));

    // The three linked items you can swipe between. A song: its artist and its album. An artist: its most
    // played song and its most played album. An album: its most played song and its artist.
    const songK = kind === "song" ? s.key : mostCommon(plays.map((r) => r.key));
    const songRows = kind === "song" ? plays : E.rows.filter((r) => r.key === songK);
    const links = {
      song: songK,
      artist: kind === "artist" ? s.key : songRows[0].artist,
      album: kind === "album" ? s.key : mostCommon((kind === "artist" ? plays : songRows).map(albumOf)),
    };
    const fmtTime = (r) => `${r.ymd} ${pad(r.hh)}:${pad(r.mi)}`;
    return {
      kind, key: s.key, name: s.name, track: s.track, artist: s.artist,
      album: kind === "album" ? s.album : kind === "song" ? (mostCommon(plays.map((r) => r.album || null)) || "") : "",
      scrobbles: plays.length, first: fmtTime(first), last: fmtTime(last),
      days: days.length, gap, together, links,
      songs: kind === "song" ? 1 : new Set(plays.map((r) => r.key)).size,
      rank_all: rankMap(new Map(list.map((x) => [x.key, x.plays]))).ranks.get(s.key), songs_total: list.length,
    };
  }

  // Its position among all items of that kind over time (cumulative plays since the period started),
  // one value per day. Keeps a "how many are ahead" counter so it stays fast over 16 years.
  function songRank(q) {
    const kind = kindArg(q);
    const { keys } = dive(kind);
    const key = itemOf(kind, q.get("key")).key;
    const range = ["year", "month"].includes(q.get("range")) ? q.get("range") : "all";
    const start = range === "all" ? "0000-01-01" : periodStart(range);
    const i0 = firstIndexFrom(start);
    if (i0 >= E.rows.length) fail("No scrobbles in this period.");
    const today = ymdLocal(new Date());
    // The timeline covers the whole period: from your very first scrobble (All time) or the 1st of the
    // year/month, up to today. firstIdx = the day of the first play in it (-1 if not played).
    let fp = i0;
    while (fp < E.rows.length && keys[fp] !== key) fp++;
    const labels = periodRange("day", range === "all" ? E.rows[i0].ymd : start, today);
    const firstIdx = fp < E.rows.length ? labels.indexOf(E.rows[fp].ymd) : -1;
    const counts = new Map(), freq = new Map();   // freq: how many have exactly n plays
    let c = 0, ahead = 0, j = i0;
    const rank = [], plays = [], total = [];
    const add = (k) => {
      if (k === null) return;
      const old = counts.get(k) || 0, now = old + 1;
      if (k === key) { ahead -= freq.get(now) || 0; c = now; }        // ones it catches up with are no longer ahead
      else if (old === c) ahead++;                                     // one passes it
      if (old) freq.set(old, freq.get(old) - 1);
      freq.set(now, (freq.get(now) || 0) + 1);
      counts.set(k, now);
    };
    for (const day of labels) {
      while (j < E.rows.length && E.rows[j].ymd === day) add(keys[j++]);
      rank.push(c ? ahead + 1 : null);
      plays.push(c);
      total.push(counts.size);
    }
    // Rolling window (default 12 months = 365 days): its plays in the window up to each day
    // (also counting plays before the period). ?months=1..60 changes the window.
    const months = intArg(q.get("months"), 12, 1, 60);
    const windowDays = Math.round((months * 365) / 12);
    const perDay = new Map();
    E.rows.forEach((r, i) => { if (keys[i] === key) perDay.set(r.ymd, (perDay.get(r.ymd) || 0) + 1); });
    const days = [...perDay.keys()].sort();
    const rolling = [];
    let sum = 0, inW = 0, outW = 0;                       // window = days (in, out] index pointers over `days`
    for (const day of labels) {
      const dn = dayNum(day);
      while (inW < days.length && dayNum(days[inW]) <= dn) sum += perDay.get(days[inW++]);
      while (outW < inW && dayNum(days[outW]) <= dn - windowDays) sum -= perDay.get(days[outW++]);
      rolling.push(sum);
    }
    return { kind, range, labels, rank, plays, total, rolling, months, firstIdx };
  }

  // Year rings: for each day since the first play, its plays in a window around that day:
  // ?half=N months before and after (including the day's own month), so N=1 → about 3 months.
  function songRings(q) {
    const kind = kindArg(q);
    const { keys } = dive(kind);
    const key = itemOf(kind, q.get("key")).key;
    const half = intArg(q.get("half"), 1, 0, 12);
    const halfDays = Math.round((half * 365) / 12) + 15;          // ± N months, plus half of the day's own month
    const mine = E.rows.filter((r, i) => keys[i] === key);
    const labels = periodRange("day", mine[0].ymd, ymdLocal(new Date()));
    const at = new Map(labels.map((l, i) => [l, i]));
    const prefix = new Array(labels.length + 1).fill(0);
    for (const r of mine) prefix[at.get(r.ymd) + 1]++;
    for (let i = 1; i < prefix.length; i++) prefix[i] += prefix[i - 1];
    const values = labels.map((_, i) => prefix[Math.min(labels.length, i + halfDays + 1)] - prefix[Math.max(0, i - halfDays)]);
    return { labels, values, half, months: 2 * half + 1 };
  }

  // Skyline + neighbours ladder: at ~200 moments, everyone's plays so far, read at fixed positions, plus
  // the item and its neighbours (5 above, 4 below).
  function songLadder(q) {
    const kind = kindArg(q);
    const { keys } = dive(kind);
    const key = itemOf(kind, q.get("key")).key;
    const range = ["year", "month"].includes(q.get("range")) ? q.get("range") : "all";
    const start = range === "all" ? "0000-01-01" : periodStart(range);
    const i0 = firstIndexFrom(start);
    if (i0 >= E.rows.length) fail("No scrobbles in this period.");
    const labels = periodRange("day", range === "all" ? E.rows[i0].ymd : start, ymdLocal(new Date()));
    const F = Math.min(200, labels.length);
    const sampleDays = Array.from({ length: F }, (_, i) => labels[Math.round((i * (labels.length - 1)) / Math.max(1, F - 1))]);
    const counts = new Map();
    const frames = [];
    // Fixed positions (#1…#100 each, then spread out on a log scale up to the number at the end),
    // so the x-axis never changes during the animation.
    const endKeys = new Set();
    for (let i = i0; i < E.rows.length; i++) if (keys[i] !== null) endKeys.add(keys[i]);
    const songsEnd = endKeys.size;
    const at = new Set();
    for (let r = 1; r <= Math.min(100, songsEnd); r++) at.add(r);
    for (let s = 0; s <= 200; s++) at.add(Math.max(1, Math.round(10 ** ((s / 200) * Math.log10(Math.max(1, songsEnd))))));
    const distRanks = [...at].sort((a, b) => a - b);
    let j = i0;
    for (const day of sampleDays) {
      while (j < E.rows.length && E.rows[j].ymd <= day) { const k = keys[j++]; if (k !== null) counts.set(k, (counts.get(k) || 0) + 1); }
      const sorted = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
      const dist = distRanks.map((r) => (r <= sorted.length ? sorted[r - 1][1] : 0));
      const me = sorted.findIndex(([k]) => k === key);
      const rankOf = (idx) => { const n = sorted[idx][1]; let p = idx; while (p > 0 && sorted[p - 1][1] === n) p--; return p + 1; };
      const from = me < 0 ? 0 : Math.max(0, Math.min(me - 5, sorted.length - 10));   // not played yet: the top 10
      const pick = sorted.slice(from, from + 10).map(([k, n], o) => {
        const s = itemOf(kind, k);
        return { key: k, track: s.name, artist: s.artist, plays: n, rank: rankOf(from + o), me: k === key };
      });
      frames.push({ day, rank: me < 0 ? null : rankOf(me), plays: me < 0 ? 0 : sorted[me][1], songs: sorted.length, rows: pick, dist });
    }
    return { kind, range, frames, distRanks, songsEnd };
  }
  // ------------------------------------------------------------------ Bar race: values per step for an animated ranking
  const weekCache = new Map();
  function weekOf(ymd) {                                       // Monday of that week, as YYYY-MM-DD
    let k = weekCache.get(ymd);
    if (!k) {
      const d = new Date(ymd + "T12:00");
      d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      k = ymdLocal(d);
      weekCache.set(ymd, k);
    }
    return k;
  }
  function raceSteps(step, first, last) {
    if (step === "week") {
      const out = [], d = new Date(weekOf(first) + "T12:00"), L = new Date(last + "T12:00");
      while (d <= L) { out.push(ymdLocal(d)); d.setDate(d.getDate() + 7); }
      return out;
    }
    if (step === "year") return periodRange("year", first.slice(0, 4), last.slice(0, 4));
    if (step === "month") return periodRange("month", first.slice(0, 7), last.slice(0, 7));
    return periodRange("day", first, last);
  }
  const RACE_KEY = { day: (r) => r.ymd, week: (r) => weekOf(r.ymd), month: (r) => r.ym, year: (r) => String(r.y) };

  function barRace(q) {
    const kind = ["track", "album"].includes(q.get("kind")) ? q.get("kind") : "artist";
    const n = intArg(q.get("n"), 10, 3, 30);
    const rolling = q.get("mode") === "rolling";
    const win = intArg(q.get("window"), 12, 1, 1000);
    const rows = filtered(q);
    if (!rows.length) fail("No scrobbles in this timeframe.");
    const first = rows[0].ymd, last = rows[rows.length - 1].ymd;
    let step = q.get("step");
    if (!RACE_KEY[step]) {                                     // auto: pick a step that gives a smooth but not endless race
      const days = (Date.parse(last) - Date.parse(first)) / 86400000;
      step = days > 1100 ? "month" : days > 150 ? "week" : "day";
    }
    const labels = raceSteps(step, first, last);
    if (labels.length > 2500) fail(`That's ${labels.length.toLocaleString()} steps. Pick a coarser step (week, month or year).`);
    const at = new Map(labels.map((l, i) => [l, i]));
    const K = RACE_KEY[step];
    const id = kind === "track" ? (r) => r.key : kind === "album" ? albumOf : (r) => r.artist;

    const info = new Map();
    const perStep = labels.map(() => new Map());
    for (const r of rows) {
      const k = id(r);
      if (k === null) continue;
      if (!info.has(k)) info.set(k, kind === "artist" ? { name: r.artist, artist: r.artist } : { name: kind === "track" ? r.track : r.album, sub: r.artist, artist: r.artist });
      const m = perStep[at.get(K(r))];
      m.set(k, (m.get(k) || 0) + 1);
    }

    // Walk through the steps: running total, or the sum of the last `win` steps.
    function walk(onStep) {
      const cur = new Map();
      perStep.forEach((m, i) => {
        for (const [k, v] of m) cur.set(k, (cur.get(k) || 0) + v);
        if (rolling && i >= win) {
          for (const [k, v] of perStep[i - win]) { const left = cur.get(k) - v; if (left > 0) cur.set(k, left); else cur.delete(k); }
        }
        onStep(cur, i);
      });
    }
    // Pass 1: everyone who is ever in the top n (plus a few just below, so newcomers slide in smoothly).
    const keep = new Set();
    walk((cur) => {
      [...cur].sort((a, b) => b[1] - a[1]).slice(0, n + 3).forEach(([k]) => keep.add(k));
    });
    // Pass 2: their values at every step.
    const values = new Map([...keep].map((k) => [k, new Array(labels.length).fill(0)]));
    const totals = [];
    let running = 0;
    walk((cur, i) => {
      for (const k of keep) { const v = cur.get(k); if (v) values.get(k)[i] = v; }
      running += [...perStep[i].values()].reduce((a, b) => a + b, 0);
      totals.push(running);
    });
    return {
      kind, step, n, mode: rolling ? "rolling" : "cumulative", window: win, labels, totals,
      entities: [...keep].map((k) => ({ id: k, ...info.get(k), values: values.get(k) })),
    };
  }

  function clock(q) {
    const grid = Array.from({ length: 7 }, () => new Array(24).fill(0));
    for (const r of filtered(q)) grid[r.dow][r.hh]++;
    return { grid };
  }

  function recent(q) {
    const limit = intArg(q.get("limit"), 25, 1, 200);
    return {
      items: E.rows.slice(-limit).reverse().map((r) => ({
        artist: r.artist, track: r.track, album: r.album, time: `${r.ymd}T${pad(r.hh)}:${pad(r.mi)}`,
      })),
    };
  }

  // ------------------------------------------------------------------ playlists
  function topTracks(rows, limit) {
    const g = new Map();
    for (const r of rows) {
      let e = g.get(r.key);
      if (!e) g.set(r.key, (e = { artist: r.artist, track: r.track, plays: 0, last: 0, ly: 0, lm: 0 }));
      e.plays++;
      if (r.uts > e.last) { e.last = r.uts; e.ly = r.y; e.lm = r.m; }
    }
    return [...g.values()].sort((a, b) => b.plays - a.plays || b.last - a.last).slice(0, limit)
      .map((e) => ({ artist: e.artist, track: e.track, plays: e.plays, note: `last played ${MON[e.lm - 1]} ${e.ly}` }));
  }
  const topArtistNames = (n = 200) => [...countBy(E.rows, (r) => r.artist)].sort((a, b) => b[1] - a[1]).slice(0, n).map((e) => e[0]);

  async function artistTags(artists) {
    const { lastfm_api_key } = lastfmCreds();
    let changed = false;
    for (const name of artists) {
      if (E.tagCache[name]) continue;
      try {
        const p = new URLSearchParams({ method: "artist.gettoptags", artist: name, autocorrect: 1, api_key: lastfm_api_key, format: "json" });
        const body = await (await fetch("https://ws.audioscrobbler.com/2.0/?" + p)).json();
        let tags = body?.toptags?.tag || [];
        if (!Array.isArray(tags)) tags = [tags];
        E.tagCache[name] = tags.slice(0, 6).filter((t) => Number(t.count || 0) >= 10).map((t) => t.name.trim().toLowerCase());
        changed = true;
      } catch (e) { console.warn("No tags for", name, e); }
      await sleep(100);
    }
    if (changed) await dbSet("tagCache", E.tagCache);
    return Object.fromEntries(artists.map((a) => [a, E.tagCache[a] || []]));
  }

  async function tags() {
    const plays = countBy(E.rows, (r) => r.artist);
    const weights = new Map();
    for (const [artist, list] of Object.entries(await artistTags(topArtistNames()))) {
      for (const t of list) weights.set(t, (weights.get(t) || 0) + (plays.get(artist) || 0));
    }
    return { tags: [...weights].sort((a, b) => b[1] - a[1]).slice(0, 60).map((e) => e[0]) };
  }

  async function playlist(q) {
    const kind = q.get("kind") || "top";
    const limit = intArg(q.get("limit"), 50, 1, 200);
    const rows = E.rows;
    const now = new Date();

    if (kind === "top") {
      const start = q.get("start"), end = q.get("end");
      const span = `${start || "the beginning"} to ${end || "today"}`;
      return {
        name: start || end ? `Top ${limit} · ${span}` : `All-time top ${limit}`,
        description: `My most played tracks from ${span}, via Last.fm.`,
        tracks: topTracks(filtered(q), limit),
      };
    }
    if (kind === "forgotten") {
      const minPlays = intArg(q.get("min_plays"), 10, 1, 1000);
      const months = intArg(q.get("months"), 12, 1, 240);
      const cut = new Date(now); cut.setMonth(cut.getMonth() - months);
      const cutUts = cut.getTime() / 1000;
      const recentKeys = new Set(rows.filter((r) => r.uts >= cutUts).map((r) => r.key));
      const old = rows.filter((r) => r.uts < cutUts && !recentKeys.has(r.key));
      return {
        name: "Forgotten favourites",
        description: `Songs I played ${minPlays}+ times but not in the last ${months} months.`,
        tracks: topTracks(old, limit * 3).filter((t) => t.plays >= minPlays).slice(0, limit),
      };
    }
    if (kind === "artists") {
      const names = new Set((q.get("artists") || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean));
      if (!names.size) fail("Type at least one artist name.");
      const sub = rows.filter((r) => names.has(r.artist.toLowerCase()));
      if (!sub.length) fail("None of those artists are in your scrobbles (check the spelling).");
      const pretty = [...countBy(sub, (r) => r.artist)].sort((a, b) => b[1] - a[1]).slice(0, 3).map((e) => e[0]).join(", ");
      return { name: `Deep dive: ${pretty}`, description: `My most played songs by ${pretty}.`, tracks: topTracks(sub, limit) };
    }
    if (kind === "genre") {
      const tag = (q.get("tag") || "").trim().toLowerCase();
      if (!tag) fail("Pick or type a genre first.");
      const map = await artistTags(topArtistNames());
      const match = new Set(Object.keys(map).filter((a) => map[a].includes(tag)));
      if (!match.size) fail(`None of your top 200 artists are tagged '${tag}' on Last.fm.`);
      const title = tag.replace(/\b\w/g, (c) => c.toUpperCase());
      return { name: `My ${title}`, description: `My most played ${tag} tracks, via Last.fm tags.`, tracks: topTracks(rows.filter((r) => match.has(r.artist)), limit) };
    }
    if (kind === "onthisday") {
      const win = intArg(q.get("window"), 3, 0, 30);
      const t = { y: now.getFullYear(), doy: Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(now.getFullYear(), 0, 0)) / 86400000) };
      const sub = rows.filter((r) => {
        const d = Math.abs(r.doy - t.doy);
        return Math.min(d, 365 - d) <= win && r.y < t.y;
      });
      const years = new Map();
      for (const r of sub) { let s = years.get(r.key); if (!s) years.set(r.key, (s = new Set())); s.add(r.y); }
      const tracks = topTracks(sub, limit);
      tracks.forEach((tr) => {
        const k = tr.artist.trim().toLowerCase() + "\x1f" + tr.track.trim().toLowerCase();
        tr.note = "played in " + [...(years.get(k) || [])].sort().join(", ");
      });
      const label = `${pad(now.getDate())} ${MONTHS[now.getMonth()]}`;
      return { name: `On this day · ${label}`, description: `What I listened to around ${label} in earlier years.`, tracks };
    }
    if (kind === "weather") return weatherPlaylist(q, limit);
    if (kind === "obsession") return obsessions(q, limit);
    fail(`Unknown playlist type: ${kind}`);
  }

  // Obsession finder: songs that, in some stretch of `days` days inside the period, made up at least `pct`%
  // of everything you scrobbled in those days. Each song counts once, with its strongest stretch; highest
  // share first. A song needs at least OBSESSION_MIN plays in that stretch, so one lone play on a quiet
  // week doesn't count as an obsession.
  const OBSESSION_MIN = 3;
  function obsessions(q, limit) {
    const N = intArg(q.get("days"), 7, 1, 3650);
    const pct = Math.max(0, Math.min(100, Number(q.get("pct")) || 5));
    const rows = filtered(new URLSearchParams({ start: q.get("start") || "", end: q.get("end") || "" }));
    if (!rows.length) fail("No scrobbles in that period.");
    const d0 = dayNum(rows[0].ymd), D = dayNum(rows[rows.length - 1].ymd) - d0 + 1;
    const W = Math.min(N, D);                               // a period shorter than the stretch: use all of it
    const total = new Int32Array(D + 1);                    // total[i] = scrobbles on days before day i
    const perSong = new Map();                              // song -> [[day, plays], …] in time order
    for (const r of rows) {
      const d = dayNum(r.ymd) - d0;
      total[d + 1]++;
      let a = perSong.get(r.key);
      if (!a) perSong.set(r.key, (a = []));
      if (a.length && a[a.length - 1][0] === d) a[a.length - 1][1]++; else a.push([d, 1]);
    }
    for (let i = 1; i <= D; i++) total[i] += total[i - 1];
    const found = [];
    for (const [key, days] of perSong) {
      let plays = 0; for (const [, n] of days) plays += n;
      if (plays < OBSESSION_MIN) continue;
      // Try every stretch [s, s+W-1] that holds at least one play; two pointers count this song's plays in it.
      let best = null, lo = 0, hi = 0, inWin = 0, lastS = -1;
      for (const [d] of days) {
        for (let s = Math.max(lastS + 1, d - W + 1, 0); s <= Math.min(d, D - W); s++) {
          while (hi < days.length && days[hi][0] <= s + W - 1) inWin += days[hi++][1];
          while (days[lo][0] < s) inWin -= days[lo++][1];
          lastS = s;
          if (inWin < OBSESSION_MIN) continue;
          const all = total[s + W] - total[s], share = inWin / all;
          if (!best || share > best.share) best = { share, plays: inWin, all, s };
        }
      }
      if (best && best.share * 100 >= pct) found.push({ key, ...best });
    }
    found.sort((a, b) => b.share - a.share || b.plays - a.plays);
    songs();
    const ymdOf = (i) => ymdUTC((d0 + i) * 86400000);
    const tracks = found.slice(0, limit).map((f) => {
      const s = songIndex.byKey.get(f.key);
      const from = ymdOf(f.s), to = ymdOf(f.s + W - 1);
      return {
        artist: s.artist, track: s.track, plays: f.plays, pct: Math.round(f.share * 1000) / 10,
        note: `${f.plays} of ${f.all} plays · ${from === to ? from : from + " to " + to}`,
      };
    });
    const per = W === 1 ? "a single day" : `${W} days`;
    return {
      name: `Obsessions · ${pct}%+ of ${per}`,
      description: `Songs that made up at least ${pct}% of my listening over ${per}, via Last.fm.`,
      tracks, found: found.length,
    };
  }

  // ------------------------------------------------------------------ Last.fm updates
  const LASTFM = "https://ws.audioscrobbler.com/2.0/";
  async function lastfmPage(page, { from = null, to = null, limit = 200, tries = 5 } = {}) {
    const s = lastfmCreds();
    const p = new URLSearchParams({ method: "user.getrecenttracks", user: s.lastfm_user, api_key: s.lastfm_api_key, format: "json", limit, page });
    if (from !== null) p.set("from", from);
    if (to !== null) p.set("to", to);
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(LASTFM + "?" + p);
        const body = await r.json();
        if (body.error) throw new Error(`Last.fm error ${body.error}: ${body.message || ""}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return body.recenttracks;
      } catch (e) {
        if (attempt >= tries) throw new Error(`Last.fm didn't answer for page ${page} after ${tries} tries (${e.message})`);
        await sleep(2000 * attempt);
      }
    }
  }

  const refresh = { running: false, mode: null, page: 0, pages: 0, added: null, total: null, error: null };
  const remote = { checked: 0, latest: null };

  async function lastfmNewest() {
    if (Date.now() - remote.checked > 60000) {
      remote.checked = Date.now();
      try {
        let t = (await lastfmPage(1, { limit: 1, tries: 1 })).track || [];
        if (!Array.isArray(t)) t = [t];
        const dated = t.filter((x) => x.date).map((x) => parseInt(x.date.uts, 10));
        remote.latest = dated.length ? Math.max(...dated) : null;
      } catch { remote.latest = null; }
    }
    return remote.latest;
  }

  function lastLoad() {
    try { return JSON.parse(localStorage.getItem("ss-lastload")) || null; } catch { return null; }
  }
  const fmtLocal = (uts) => {
    if (!uts) return null;
    const d = new Date(uts * 1000);
    return `${ymdLocal(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  async function refreshStatus() {
    const ll = lastLoad();
    const localNewest = E.rows.length ? E.rows[E.rows.length - 1].uts : 0;
    let fresh, checked, remoteNewest = null;
    try { remoteNewest = settings().lastfm_api_key ? await lastfmNewest() : null; } catch {}
    if (remoteNewest !== null) { fresh = localNewest >= remoteNewest; checked = "lastfm"; }
    else { fresh = !!ll && ll.when.slice(0, 10) === ymdLocal(new Date()); checked = "date"; }
    return {
      ...refresh, fresh, checked_with: checked,
      last_load: ll ? ll.when.replace("T", " ").slice(0, 16) : null, last_mode: ll?.mode || null,
      local_newest: fmtLocal(localNewest), lastfm_newest: fmtLocal(remoteNewest),
    };
  }

  async function runRefresh(full) {
    try {
      const before = E.raw.length;
      const from = full ? null : (E.rows.length ? E.rows[E.rows.length - 1].uts : 0);
      const to = full ? Math.floor(Date.now() / 1000) : null;
      const incoming = [];
      for (let page = 1, pages = 1; page <= pages; page++) {
        const d = await lastfmPage(page, { from, to });
        pages = parseInt(d["@attr"]?.totalPages || "1", 10) || 1;
        Object.assign(refresh, { page, pages });
        let tracks = d.track || [];
        if (!Array.isArray(tracks)) tracks = [tracks];
        for (const t of tracks) {
          if (!t.date) continue;                        // the song playing right now has no date yet
          incoming.push([parseInt(t.date.uts, 10), t.artist?.["#text"] || "", t.album?.["#text"] || "", t.name || "",
            t.artist?.mbid || "", t.album?.mbid || "", t.mbid || ""]);
        }
        await sleep(200);
      }
      let raw;
      if (full) {
        if (incoming.length < 0.5 * before) fail(`Last.fm only returned ${incoming.length.toLocaleString()} scrobbles (you have ${before.toLocaleString()}). Kept your current data to be safe; try again later.`);
        raw = mergeRaw([], incoming).out;
      } else {
        raw = mergeRaw(E.raw, incoming).out;
      }
      const added = raw.length - before;
      if (full || added) await saveScrobbles(raw, true);
      Object.assign(refresh, { added, total: raw.length });
      localStorage.setItem("ss-lastload", JSON.stringify({ when: new Date().toISOString(), mode: full ? "full" : "new" }));
      remote.checked = 0;
    } catch (e) {
      refresh.error = e.message;
    } finally {
      refresh.running = false;
    }
  }

  // ------------------------------------------------------------------ Spotify (PKCE login: no secret needed)
  const SP_SCOPES = "playlist-modify-private playlist-modify-public";
  const TOKEN_KEY = "ss-spotify-token";
  const redirectUri = () => location.origin + location.pathname.replace(/[^/]*$/, "");
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

  async function spotifyLogin() {
    const id = settings().spotify_client_id;
    if (!id) fail("Add your Spotify Client ID in Settings first.");
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
    localStorage.setItem("ss-sp-verifier", verifier);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const p = new URLSearchParams({
      client_id: id, response_type: "code", redirect_uri: redirectUri(),
      code_challenge_method: "S256", code_challenge: challenge, scope: SP_SCOPES,
    });
    location.href = "https://accounts.spotify.com/authorize?" + p;
  }

  async function tokenRequest(params) {
    const r = await fetch("https://accounts.spotify.com/api/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params),
    });
    const t = await r.json();
    if (!r.ok) fail(`Spotify login failed: ${t.error_description || t.error || r.status}`);
    const old = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    const token = {
      access_token: t.access_token,
      refresh_token: t.refresh_token || old?.refresh_token,
      expires_at: Date.now() + (t.expires_in - 60) * 1000,
    };
    localStorage.setItem(TOKEN_KEY, JSON.stringify(token));
    return token;
  }

  // Called on every page load: finishes the login after Spotify sends you back with ?code=…
  async function spotifyCallback() {
    const u = new URL(location.href);
    const code = u.searchParams.get("code"), err = u.searchParams.get("error");
    if (!code && !err) return;
    history.replaceState(null, "", u.pathname);
    if (err) fail(`Spotify login was cancelled (${err}).`);
    await tokenRequest({
      grant_type: "authorization_code", code, redirect_uri: redirectUri(),
      client_id: settings().spotify_client_id, code_verifier: localStorage.getItem("ss-sp-verifier") || "",
    });
  }

  async function spotifyToken() {
    let t = JSON.parse(localStorage.getItem(TOKEN_KEY) || "null");
    if (!t) return null;
    if (Date.now() > t.expires_at) {
      if (!t.refresh_token) return null;
      try {
        t = await tokenRequest({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: settings().spotify_client_id });
      } catch { localStorage.removeItem(TOKEN_KEY); return null; }
    }
    return t.access_token;
  }

  async function sp(path, { method = "GET", body } = {}) {
    const token = await spotifyToken();
    if (!token) fail("Connect Spotify first (button at the top right).");
    for (let attempt = 1; ; attempt++) {
      const r = await fetch("https://api.spotify.com/v1/" + path, {
        method, headers: { Authorization: "Bearer " + token, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 429 && attempt < 4) { await sleep(1000 * (parseInt(r.headers.get("Retry-After") || "2", 10) + 1)); continue; }
      const data = r.status === 204 ? {} : await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(data?.error?.message || `Spotify error ${r.status}`); e.status = r.status; throw e; }
      return data;
    }
  }

  async function spotifyStatus() {
    const configured = !!settings().spotify_client_id;
    let connected = false, user = null;
    if (configured && (await spotifyToken())) {
      try { const me = await sp("me"); connected = true; user = me.display_name || me.id; } catch {}
    }
    return { configured, connected, user, redirect_uri: redirectUri() };
  }

  const CLEAN = [
    /\s+[-–]\s+(\d{4}\s+)?(remaster|explicit|radio edit|single|album version|live|mono|stereo|bonus|deluxe).*$/i,
    /\s*[([][^)\]]*(remaster|explicit|feat\.|ft\.|version|edit|live|bonus)[^)\]]*[)\]]/gi,
  ];
  const cleanTitle = (t) => CLEAN.reduce((s, re) => s.replace(re, ""), t).trim();

  async function findOnSpotify(artist, track) {
    const title = cleanTitle(track);
    for (const [q, mustMatch] of [[`track:${title} artist:${artist}`, false], [`${artist} ${title}`, true]]) {
      let items = [];
      try { items = (await sp("search?" + new URLSearchParams({ q, type: "track", limit: 5 }))).tracks.items; } catch { continue; }
      for (const it of items) {
        const names = it.artists.map((a) => a.name.toLowerCase()).join(" ");
        if (!mustMatch || names.includes(artist.toLowerCase()) || artist.toLowerCase().includes(names)) return it.uri;
      }
    }
    return null;
  }

  async function spotifyCreate(body) {
    const tracks = (body.tracks || []).slice(0, 200);
    if (!tracks.length) fail("The playlist is empty.");
    const uris = [], missing = [];
    for (const t of tracks) {
      const uri = await findOnSpotify(t.artist, t.track);
      if (uri && !uris.includes(uri)) uris.push(uri);
      else if (!uri) missing.push(`${t.artist} – ${t.track}`);
    }
    if (!uris.length) fail("None of the songs could be found on Spotify.");
    const meta = { name: (body.name || "Scrobble Studio playlist").slice(0, 100), public: false, description: (body.description || "").slice(0, 300) };
    let pl;
    try { pl = await sp("me/playlists", { method: "POST", body: meta }); }
    catch { const me = await sp("me"); pl = await sp(`users/${encodeURIComponent(me.id)}/playlists`, { method: "POST", body: meta }); }
    for (let i = 0; i < uris.length; i += 100) {
      const batch = uris.slice(i, i + 100);
      try { await sp(`playlists/${pl.id}/items`, { method: "POST", body: { uris: batch } }); }
      catch { await sp(`playlists/${pl.id}/tracks`, { method: "POST", body: { uris: batch } }); }
    }
    return { url: pl.external_urls.spotify, added: uris.length, missing };
  }

  // ------------------------------------------------------------------ weather (Open-Meteo, free, no key)
  const VARS = ["temperature_2m", "precipitation", "rain", "snowfall", "cloud_cover", "wind_speed_10m", "relative_humidity_2m", "sunshine_duration", "weather_code"];
  const COLS = ["temperature_c", "precipitation_mm", "rain_mm", "snowfall_cm", "cloud_cover_pct", "wind_kmh", "humidity_pct", "sunshine_min", "weather_code"];
  const WEATHER_CODES = [
    [0, "Clear sky", "Clear"], [1, "Mainly clear", "Clear"], [2, "Partly cloudy", "Cloudy"], [3, "Overcast", "Cloudy"],
    [45, "Fog", "Fog"], [48, "Depositing rime fog", "Fog"],
    [51, "Light drizzle", "Drizzle"], [53, "Moderate drizzle", "Drizzle"], [55, "Dense drizzle", "Drizzle"],
    [56, "Light freezing drizzle", "Drizzle"], [57, "Dense freezing drizzle", "Drizzle"],
    [61, "Slight rain", "Rain"], [63, "Moderate rain", "Rain"], [65, "Heavy rain", "Rain"],
    [66, "Light freezing rain", "Rain"], [67, "Heavy freezing rain", "Rain"],
    [71, "Slight snowfall", "Snow"], [73, "Moderate snowfall", "Snow"], [75, "Heavy snowfall", "Snow"], [77, "Snow grains", "Snow"],
    [80, "Slight rain showers", "Rain"], [81, "Moderate rain showers", "Rain"], [82, "Violent rain showers", "Rain"],
    [85, "Slight snow showers", "Snow"], [86, "Heavy snow showers", "Snow"],
    [95, "Thunderstorm", "Storm"], [96, "Thunderstorm with slight hail", "Storm"], [99, "Thunderstorm with heavy hail", "Storm"],
  ];
  const CODE_GROUP = new Map(WEATHER_CODES.map(([c, , g]) => [c, g]));
  const ARCHIVE_DELAY_DAYS = 7;

  // E.weather = { location_key: { h: [hour_utc…], temperature_c: […], …, src: ["archive"|"recent"…] } }
  function buildWeatherIndex() {
    E.wIndex = {};
    E.daily = new Map();
    for (const [loc, w] of Object.entries(E.weather)) {
      const idx = new Map();
      w.h.forEach((h, i) => {
        idx.set(h, i);
        const day = ymdLocal(new Date(h * 1000));
        const k = loc + "|" + day;
        let d = E.daily.get(k);
        if (!d) E.daily.set(k, (d = { precip: 0, snow: 0, cloud: 0, n: 0, sun: 0, temp: 0, fog: 0, storm: 0 }));
        d.precip += w.precipitation_mm[i] || 0;
        d.snow += w.snowfall_cm[i] || 0;
        d.cloud += w.cloud_cover_pct[i] || 0;
        d.sun += w.sunshine_min[i] || 0;
        d.temp += w.temperature_c[i] || 0;
        d.n++;
        const c = w.weather_code[i];
        if (c === 45 || c === 48) d.fog++;
        if (c >= 95) d.storm++;
      });
      E.wIndex[loc] = idx;
    }
    E.joined = false;
  }

  // Give every scrobble its location (where you lived that day) and weather row.
  function joinWeather() {
    if (E.joined) return;
    const periods = E.locations.slice().sort((a, b) => a.start_date.localeCompare(b.start_date));
    for (const r of E.rows) {
      r.loc = null; r.wi = -1;
      for (const p of periods) {
        if (r.ymd >= p.start_date && (!p.end_date || r.ymd <= p.end_date)) { r.loc = p.location_key; break; }
      }
      if (r.loc && E.wIndex[r.loc]) {
        const i = E.wIndex[r.loc].get(Math.floor(r.uts / 3600) * 3600);
        if (i !== undefined) r.wi = i;
      }
    }
    E.joined = true;
  }

  function needDays(firstDay, today) {
    const need = {};
    for (const p of E.locations) {
      let start = p.start_date > firstDay ? p.start_date : firstDay;
      start = addDaysUTC(start, -1);
      let end = p.end_date && p.end_date < today ? p.end_date : today;
      end = addDaysUTC(end, 1);
      if (end > today) end = today;
      if (end < start) continue;
      const slot = (need[p.location_key] ||= { lat: p.latitude, lon: p.longitude, days: new Set() });
      for (let d = start; d <= end; d = addDaysUTC(d, 1)) slot.days.add(d);
    }
    return need;
  }
  function haveDays(loc, today) {
    const w = E.weather[loc];
    if (!w) return new Set();
    const cutoff = addDaysUTC(today, -ARCHIVE_DELAY_DAYS), yesterday = addDaysUTC(today, -1);
    const counts = new Map();
    w.h.forEach((h, i) => {
      const day = ymdUTC(h * 1000);
      const keep = w.src[i] === "archive" || (day > cutoff && day < yesterday);
      if (keep) counts.set(day, (counts.get(day) || 0) + 1);
    });
    return new Set([...counts].filter(([, n]) => n >= 24).map(([d]) => d));
  }
  function toRanges(days, maxLen) {
    const out = [];
    for (const d of [...days].sort()) {
      const last = out[out.length - 1];
      if (last && d === addDaysUTC(last[1], 1) && (Date.parse(d) - Date.parse(last[0])) / 86400000 < maxLen) last[1] = d;
      else out.push([d, d]);
    }
    return out;
  }
  function planWeather(today) {
    const firstDay = E.rows.length ? E.rows[0].ymd : today;
    const cutoff = addDaysUTC(today, -ARCHIVE_DELAY_DAYS);
    const jobs = [];
    for (const [loc, slot] of Object.entries(needDays(firstDay, today))) {
      const have = haveDays(loc, today);
      const missing = [...slot.days].filter((d) => !have.has(d));
      const old = missing.filter((d) => d <= cutoff), recentDays = missing.filter((d) => d > cutoff);
      for (const [a, b] of toRanges(old, 366)) jobs.push({ loc, lat: slot.lat, lon: slot.lon, start: a, end: b, src: "archive" });
      for (const [a, b] of toRanges(recentDays, 14)) jobs.push({ loc, lat: slot.lat, lon: slot.lon, start: a, end: b, src: "recent" });
    }
    return jobs;
  }
  async function fetchWeather(job) {
    const url = job.src === "archive" ? "https://archive-api.open-meteo.com/v1/archive" : "https://api.open-meteo.com/v1/forecast";
    const p = new URLSearchParams({
      latitude: job.lat, longitude: job.lon, start_date: job.start, end_date: job.end,
      hourly: VARS.join(","), timezone: "GMT", timeformat: "unixtime",
    });
    for (let attempt = 1; ; attempt++) {
      try {
        const r = await fetch(url + "?" + p);
        const body = await r.json();
        if (body.error) throw new Error(body.reason || "Open-Meteo error");
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return body.hourly;
      } catch (e) {
        if (attempt >= 5) throw new Error(`Weather download failed for ${job.start}–${job.end}: ${e.message}`);
        await sleep(5000 * attempt);
      }
    }
  }

  const weatherState = { running: false, done: 0, jobs: 0, added: null, error: null };
  async function runWeather() {
    try {
      if (!E.locations.length) fail("Add and save at least one location first.");
      const today = ymdLocal(new Date());
      const jobs = planWeather(today);
      Object.assign(weatherState, { jobs: jobs.length, done: 0 });
      const before = Object.values(E.weather).reduce((n, w) => n + w.h.length, 0);
      const nowH = Date.now() / 1000;
      for (const job of jobs) {
        const h = await fetchWeather(job);
        const w = (E.weather[job.loc] ||= { h: [], src: [], ...Object.fromEntries(COLS.map((c) => [c, []])) });
        const at = new Map(w.h.map((x, i) => [x, i]));
        h.time.forEach((t, i) => {
          if (t > nowH) return;
          const vals = VARS.map((v) => h[v]?.[i] ?? null);
          if (vals[0] === null && vals[8] === null) return;     // empty future hours
          vals[7] = vals[7] === null ? null : Math.round((vals[7] / 60) * 10) / 10;   // sunshine: seconds -> minutes
          let j = at.get(t);
          if (j === undefined) { j = w.h.length; w.h.push(t); at.set(t, j); }
          COLS.forEach((c, k) => (w[c][j] = vals[k]));
          w.src[j] = job.src;
        });
        weatherState.done++;
        await sleep(500);                                       // be polite to the free service
      }
      for (const w of Object.values(E.weather)) {               // keep each location sorted by hour
        const order = w.h.map((_, i) => i).sort((a, b) => w.h[a] - w.h[b]);
        for (const c of ["h", "src", ...COLS]) w[c] = order.map((i) => w[c][i]);
      }
      await dbSet("weather", E.weather);
      buildWeatherIndex();
      const after = Object.values(E.weather).reduce((n, w) => n + w.h.length, 0);
      weatherState.added = after - before;
    } catch (e) {
      weatherState.error = e.message;
    } finally {
      weatherState.running = false;
    }
  }
  function weatherCoverage() {
    joinWeather();
    let rowsTotal = 0, from = null, to = null;
    for (const w of Object.values(E.weather)) {
      rowsTotal += w.h.length;
      if (w.h.length) {
        if (from === null || w.h[0] < from) from = w.h[0];
        if (to === null || w.h[w.h.length - 1] > to) to = w.h[w.h.length - 1];
      }
    }
    return {
      scrobbles: E.rows.length,
      with_location: E.rows.filter((r) => r.loc).length,
      with_weather: E.rows.filter((r) => r.wi >= 0).length,
      weather_rows: rowsTotal, weather_from: fmtLocal(from), weather_to: fmtLocal(to),
    };
  }

  const WEATHER_LABELS = {
    rain: ["Rainy", "during rain"], heavy: ["Pouring", "during heavy rain"], snow: ["Snowy", "while it snowed"],
    clear: ["Sunny", "under clear skies"], cloudy: ["Grey", "under grey skies"], fog: ["Foggy", "in the fog"],
    storm: ["Stormy", "during thunderstorms"], any: ["All-weather", "in any weather"],
  };
  function weatherOf(r) {
    const w = E.weather[r.loc], i = r.wi;
    const d = E.daily.get(r.loc + "|" + r.ymd) || { precip: 0, snow: 0, cloud: 0, n: 1, sun: 0, temp: 0, fog: 0, storm: 0 };
    return {
      group: CODE_GROUP.get(w.weather_code[i]), temp: w.temperature_c[i], precip: w.precipitation_mm[i] || 0,
      rain: w.rain_mm[i] || 0, snow: w.snowfall_cm[i] || 0,
      // Daily totals rounded to 0.1 (the data's own precision), so 24 hours adding up to 0.9999… still counts as 1.0 mm.
      dPrecip: Math.round(d.precip * 10) / 10, dSnow: Math.round(d.snow * 10) / 10,
      dCloud: d.cloud / d.n, dTemp: d.temp / d.n, dFog: d.fog, dStorm: d.storm,
    };
  }
  function weatherMatch(x, cond, scope) {
    if (scope === "day") {
      return {
        rain: x.dPrecip >= 1, heavy: x.dPrecip >= 10, snow: x.dSnow >= 1,
        clear: x.dPrecip < 0.2 && x.dCloud < 35, cloudy: x.dCloud >= 75 && x.dPrecip < 1,
        fog: x.dFog >= 3, storm: x.dStorm >= 1,
      }[cond] ?? true;
    }
    return {
      rain: ["Drizzle", "Rain", "Storm"].includes(x.group) || x.rain >= 0.1, heavy: x.precip >= 2.5,
      snow: x.group === "Snow" || x.snow > 0, clear: x.group === "Clear" && x.precip === 0,
      cloudy: x.group === "Cloudy", fog: x.group === "Fog", storm: x.group === "Storm",
    }[cond] ?? true;
  }

  function weatherPlaylist(q, limit) {
    joinWeather();
    if (!Object.keys(E.weather).length) fail("No weather data yet. Open 'Weather locations' and click 'Download weather'.");
    const cond = q.get("cond") || "rain";
    const scope = q.get("scope") === "day" ? "day" : "hour";
    const months = [...new Set((q.get("months") || "").split(",").map(Number).filter((m) => m >= 1 && m <= 12))].sort((a, b) => a - b);
    const tmin = q.get("tmin")?.trim(), tmax = q.get("tmax")?.trim();
    let base = filtered(q).filter((r) => r.wi >= 0);
    if (months.length) base = base.filter((r) => months.includes(r.m));
    base = base.map((r) => ({ r, x: weatherOf(r) }));
    if (tmin) base = base.filter(({ x }) => (scope === "day" ? x.dTemp : x.temp) >= Number(tmin));
    if (tmax) base = base.filter(({ x }) => (scope === "day" ? x.dTemp : x.temp) <= Number(tmax));
    if (!base.length) fail("No scrobbles with weather data for those months / temperatures.");
    const sub = base.filter(({ x }) => weatherMatch(x, cond, scope));
    if (!sub.length) fail("No scrobbles match that weather. Try 'whole day' or fewer filters.");

    const totals = countBy(base.map((e) => e.r), (r) => r.key);
    const g = new Map();
    for (const { r } of sub) {
      let e = g.get(r.key);
      if (!e) g.set(r.key, (e = { artist: r.artist, track: r.track, plays: 0, key: r.key }));
      e.plays++;
    }
    let list = [...g.values()].map((e) => ({ ...e, total: totals.get(e.key) }));
    if (q.get("sort") === "typical") {
      const share = sub.length / base.length;
      list = list.filter((e) => e.plays >= 3).map((e) => ({ ...e, lift: e.plays / e.total / share }))
        .sort((a, b) => b.lift - a.lift || b.plays - a.plays);
    } else {
      list.sort((a, b) => b.plays - a.plays);
    }
    const [adj, words] = WEATHER_LABELS[cond] || WEATHER_LABELS.any;
    const names = months.length <= 3 ? months.map((m) => MONTHS[m - 1]) : [];
    const monthTxt = names.length > 1 ? names.slice(0, -1).join(", ") + " & " + names[names.length - 1] : names.join("");
    return {
      name: [adj, monthTxt, scope === "day" ? "days" : "hours"].filter(Boolean).join(" "),
      description: `Tracks I played ${words}${monthTxt ? " in " + monthTxt : ""}. Last.fm + Open-Meteo weather.`,
      tracks: list.slice(0, limit).map((e) => ({ artist: e.artist, track: e.track, plays: e.plays, note: `${e.plays} of its ${e.total} plays were in this weather` })),
    };
  }

  // Locations (where you lived when)
  function saveLocations(periods) {
    const clean = periods.map((p, n) => {
      const row = `Row ${n + 1}`;
      const lat = Number(p.latitude), lon = Number(p.longitude);
      if (p.latitude === null || p.latitude === "" || !Number.isFinite(lat) || !Number.isFinite(lon)) fail(`${row}: pick a place from the search suggestions.`);
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) fail(`${row}: the coordinates look wrong.`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(p.start_date || "")) fail(`${row}: fill in a valid 'From' date.`);
      if (p.end_date && !/^\d{4}-\d{2}-\d{2}$/.test(p.end_date)) fail(`${row}: the 'To' date isn't valid.`);
      if (p.end_date && p.end_date < p.start_date) fail(`${row}: 'To' is before 'From'.`);
      return {
        location_key: `${lat.toFixed(2)}_${lon.toFixed(2)}`,     // same place = same key, even if you moved back
        place: String(p.place || "").trim(), admin: String(p.admin || "").trim(), country: String(p.country || "").trim(),
        latitude: Math.round(lat * 1e4) / 1e4, longitude: Math.round(lon * 1e4) / 1e4,
        start_date: p.start_date, end_date: p.end_date || "",
      };
    }).sort((a, b) => a.start_date.localeCompare(b.start_date));
    clean.forEach((p, i) => {
      const next = clean[i + 1];
      if (!next) return;
      if (!p.end_date) fail(`Only the latest period can run 'until now' (${p.place} is followed by ${next.place}).`);
      if (next.start_date <= p.end_date) fail(`${p.place} and ${next.place} overlap around ${next.start_date}.`);
    });
    return clean;
  }

  async function geocode(q) {
    const name = (q.get("q") || "").trim();
    if (name.length < 2) return { results: [] };
    const r = await fetch("https://geocoding-api.open-meteo.com/v1/search?" + new URLSearchParams({ name, count: 6, language: "en", format: "json" }));
    const body = await r.json();
    return {
      results: (body.results || []).map((x) => ({
        place: x.name || "", admin: x.admin1 || "", country: x.country || "", latitude: x.latitude, longitude: x.longitude,
      })),
    };
  }

  // Power BI files (same layout as the old app's CSVs)
  function exportFiles() {
    joinWeather();
    const files = { "Scrobbles.csv": exportScrobblesCSV() };
    files["locations.csv"] = toCSV(["location_key", "place", "admin", "country", "latitude", "longitude", "start_date", "end_date"],
      E.locations.map((p) => [p.location_key, p.place, p.admin, p.country, p.latitude, p.longitude, p.start_date, p.end_date]));
    files["weather_codes.csv"] = toCSV(["weather_code", "description", "weather_group", "is_wet"],
      WEATHER_CODES.map(([c, d, g]) => [c, d, g, ["Drizzle", "Rain", "Storm", "Snow"].includes(g) ? "True" : "False"]));
    const wRows = [];
    for (const [loc, w] of Object.entries(E.weather)) {
      w.h.forEach((h, i) => {
        const d = new Date(h * 1000);
        wRows.push([loc, h, new Date(h * 1000).toISOString().slice(0, 16).replace("T", " "),
          `${ymdLocal(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`, ...COLS.map((c) => w[c][i] ?? ""), w.src[i]]);
      });
    }
    files["weather_hourly.csv"] = toCSV(["location_key", "hour_utc", "time_utc", "time_local", ...COLS, "source"], wRows);
    files["scrobble_keys.csv"] = toCSV(["uts", "location_key", "hour_utc", "date_local"],
      E.rows.map((r) => [r.uts, r.loc || "", Math.floor(r.uts / 3600) * 3600, r.ymd]));
    return files;
  }

  // ------------------------------------------------------------------ the "server": /api/... routes
  async function api(path, options = {}) {
    const u = new URL(path, location.href);
    const q = u.searchParams;
    const method = (options.method || "GET").toUpperCase();
    const body = options.body ? JSON.parse(options.body) : null;
    const route = u.pathname.replace(/^.*\/api\//, "");
    await ensureData();

    switch (route) {
      case "summary": return summary(q);
      case "timeline": return timeline(q);
      case "top": return top(q);
      case "artists-over-time": return artistsOverTime(q);
      case "clock": return clock(q);
      case "trends": return trends(q);
      case "barrace": return barRace(q);
      case "overview": return overview(q);
      case "movers": return movers(q);
      case "songsearch": return songSearch(q);
      case "song": return songInfo(q);
      case "songrank": return songRank(q);
      case "songladder": return songLadder(q);
      case "songrings": return songRings(q);
      case "recent": return recent(q);
      case "playlist": return playlist(q);
      case "tags": return tags();

      case "refresh":
        if (!refresh.running) {
          lastfmCreds();
          Object.assign(refresh, { running: true, mode: q.get("mode") === "full" ? "full" : "new", page: 0, pages: 0, added: null, total: null, error: null });
          runRefresh(refresh.mode === "full");
        }
        return refreshStatus();
      case "refresh/status": return refreshStatus();

      case "spotify/status": return spotifyStatus();
      case "spotify/create": return spotifyCreate(body);

      case "locations":
        if (method === "POST") {
          E.locations = saveLocations(body.periods || []);
          await dbSet("locations", E.locations);
          E.joined = false;
        }
        return { periods: E.locations, first: E.rows[0]?.ymd || null, last: E.rows[E.rows.length - 1]?.ymd || null };
      case "geocode": return geocode(q);
      case "weather/update":
        if (!weatherState.running) {
          Object.assign(weatherState, { running: true, done: 0, jobs: 0, added: null, error: null });
          runWeather();
        }
        return { ...weatherState, ...weatherCoverage() };
      case "weather/status": return { ...weatherState, ...weatherCoverage() };

      case "data/info":
        return { scrobbles: E.rows.length, first: E.rows[0]?.ymd || null, last: E.rows[E.rows.length - 1]?.ymd || null,
          locations: E.locations.length, weather_rows: Object.values(E.weather).reduce((n, w) => n + w.h.length, 0) };
      default:
        fail(`Unknown request: ${route}`);
    }
  }

  // Things the settings page needs directly.
  window.Studio = {
    api, settings, saveSettings, importCSV, exportFiles, spotifyLogin, spotifyCallback, redirectUri,
    async clearAll() { await dbClear(); Object.assign(E, { raw: null, rows: null }); localStorage.removeItem("ss-lastload"); },
    async storageEstimate() { try { return await navigator.storage.estimate(); } catch { return null; } },
  };
  window.api = api;
})();
