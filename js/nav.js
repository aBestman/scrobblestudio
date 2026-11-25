// Left sidebar: same menu on every page.
// Desktop: can shrink to icons only (remembered). Phone: hidden, opened with the ☰ button in the header.
(() => {
  const ICON = {
    scrobbles: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
    trends: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
    race: '<path d="M3 5h14M3 10h18M3 15h10M3 20h6"/>',
    song: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/><path d="M10 13.5V8.5l3-.8"/>',
    lab: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3"/><path d="M7.5 15h9"/>',
    playlists: '<path d="M3 6h12M3 12h12M3 18h7"/><path d="M17 18V8l4-1"/><circle cx="15" cy="18" r="2"/>',
    weather: '<path d="M7 18a4 4 0 0 1-.5-8A5.5 5.5 0 0 1 17 9a4 4 0 0 1 0 9z"/><path d="M8 21l1-2M12 21l1-2M16 21l1-2"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    collapse: '<path d="M15 18l-6-6 6-6"/>',
  };
  const svg = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${ICON[name]}</svg>`;
  const onIndex = !/(settings|locations)\.html$/.test(location.pathname);
  // Experimental pages only show when switched on under Settings → Experimental (window.showLab, also used by app.js).
  let lab = false;
  try { lab = localStorage.getItem("ss-show-lab") === "1"; } catch {}
  window.showLab = lab;
  const ITEMS = [
    ["scrobbles", "Scrobbles", onIndex ? "#scrobbles" : "./#scrobbles"],
    ["song", "Deep Dive", onIndex ? "#song" : "./#song"],
    lab ? ["lab", "🧪 Song visual test", onIndex ? "#lab" : "./#lab"] : undefined,
    ["race", "Bar race", onIndex ? "#race" : "./#race"],
    ["playlists", "Playlist Studio", onIndex ? "#playlists" : "./#playlists"],
    null,
    ["weather", "Weather locations", "locations.html"],
    ["settings", "Settings", "settings.html"],
  ].filter((it) => it !== undefined);

  const nav = document.createElement("nav");
  nav.className = "sidebar";
  nav.setAttribute("aria-label", "Pages");
  nav.innerHTML = `
    <div class="side-brand"><span class="side-logo">${svg("scrobbles")}</span><span class="side-text">Scrobble Studio</span></div>
    ${ITEMS.map((it) => it
      ? `<a class="side-link" data-page="${it[0]}" href="${it[2]}" title="${it[1]}">${svg(it[0])}<span class="side-text">${it[1]}</span></a>`
      : '<div class="side-sep"></div>').join("")}
    <span class="side-fill"></span>
    <button class="side-link side-collapse" type="button" title="Collapse menu">${svg("collapse")}<span class="side-text">Collapse</span></button>`;
  document.body.prepend(nav);

  const scrim = document.createElement("div");
  scrim.className = "side-scrim";
  document.body.prepend(scrim);

  // ☰ button in the header (only shown on phones)
  const header = document.querySelector("header.top");
  if (header) {
    const burger = document.createElement("button");
    burger.className = "burger";
    burger.type = "button";
    burger.setAttribute("aria-label", "Open menu");
    burger.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
    burger.addEventListener("click", () => document.body.classList.add("side-open"));
    header.prepend(burger);
  }
  const close = () => document.body.classList.remove("side-open");
  scrim.addEventListener("click", close);
  nav.querySelectorAll("a").forEach((a) => a.addEventListener("click", close));

  try { if (localStorage.getItem("ss-side-collapsed") === "1") document.body.classList.add("side-collapsed"); } catch {}
  nav.querySelector(".side-collapse").addEventListener("click", () => {
    const c = document.body.classList.toggle("side-collapsed");
    try { localStorage.setItem("ss-side-collapsed", c ? "1" : "0"); } catch {}
  });

  // Highlight the current page.
  function mark() {
    const page = /locations\.html$/.test(location.pathname) ? "weather"
      : /settings\.html$/.test(location.pathname) ? "settings"
      : (location.hash.slice(1).split("=")[0].replace("trends", "scrobbles") || "scrobbles");
    nav.querySelectorAll(".side-link[data-page]").forEach((a) => a.classList.toggle("active", a.dataset.page === page));
  }
  window.addEventListener("hashchange", mark);
  mark();
})();
