/**
 * app.js - draws the medical digital newspaper in your browser.
 */
import { BookmarkStore } from "./bookmarks.js";

const store = new BookmarkStore();
// Ensure Saurabh Srivastav is auto-selected as default reader profile if none active
if (!store.active) {
  store.createProfile("Saurabh Srivastav");
}

const WPM = 230;

/* ------------------------------------------------------------------ helpers */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

let edition = null;
const articles = new Map();
let keyword = "";

function fmtTime(iso) {
  if (!iso) return "";
  const opts = { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat("en-GB", { ...opts, timeZone: edition?.edition?.timezone }).format(new Date(iso));
  } catch {
    return new Intl.DateTimeFormat("en-GB", opts).format(new Date(iso));
  }
}

function download(filename, text, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = h("a", { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* Daily Rotating Editorial Hero Image Generator */
function getDailyHeroImage() {
  const seed = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Curated medicine, surgery, laboratory and clinical photography collections
  const collections = [
    "https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?auto=format&fit=crop&w=1200&q=80", // Physician with stethoscope
    "https://images.unsplash.com/photo-1579684385127-1ef15d508118?auto=format&fit=crop&w=1200&q=80", // Clinical research
    "https://images.unsplash.com/photo-1530026405186-ed1f139313f8?auto=format&fit=crop&w=1200&q=80", // Laboratory microscopy
    "https://images.unsplash.com/photo-1532938911079-1b06ac7ceec7?auto=format&fit=crop&w=1200&q=80", // Medical science lab
    "https://images.unsplash.com/photo-1551076805-e1869033e561?auto=format&fit=crop&w=1200&q=80"  // Surgical team
  ];
  const index = parseInt(seed, 10) % collections.length;
  return collections[index];
}

/* ------------------------------------------------------- display preferences */
const UI_KEY = "daily-differential:ui";
function loadUi() {
  try { return JSON.parse(localStorage.getItem(UI_KEY)) || {}; } catch { return {}; }
}
function saveUi(patch) {
  try { localStorage.setItem(UI_KEY, JSON.stringify({ ...loadUi(), ...patch })); } catch { /* ignore */ }
}
function applyUi() {
  const ui = loadUi();
  if (ui.theme === "night") document.documentElement.dataset.theme = "night";
  else delete document.documentElement.dataset.theme;
  document.documentElement.style.setProperty("--base", `${ui.size || 17}px`);
}

$("#btn-theme")?.addEventListener("click", () => {
  saveUi({ theme: loadUi().theme === "night" ? "day" : "night" });
  applyUi();
});
for (const [id, delta] of [["#btn-smaller", -1], ["#btn-larger", 1]]) {
  $(id)?.addEventListener("click", () => {
    saveUi({ size: Math.min(22, Math.max(14, (loadUi().size || 17) + delta)) });
    applyUi();
  });
}
applyUi();

/* ----------------------------------------------- sanitising full-text articles */
const ALLOWED = new Set(["P", "H2", "H3", "H4", "UL", "OL", "LI", "BLOCKQUOTE", "EM", "STRONG", "B", "I", "A", "BR", "CODE", "PRE"]);
function rebuild(from, into) {
  for (const node of from.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      into.append(node.textContent);
    } else if (node.nodeType === Node.ELEMENT_NODE && ALLOWED.has(node.tagName)) {
      const el = document.createElement(node.tagName);
      if (node.tagName === "A") {
        const href = node.getAttribute("href") || "";
        if (/^https?:\/\//i.test(href)) {
          el.href = href;
          el.target = "_blank";
          el.rel = "noopener noreferrer nofollow";
        }
      }
      rebuild(node, el);
      into.append(el);
    }
  }
}
function safeFragment(html) {
  const body = new DOMParser().parseFromString(html || "", "text/html").body;
  const frag = document.createDocumentFragment();
  rebuild(body, frag);
  return frag;
}

/* ---------------------------------------------------------------- bookmarks UI */
function ensureProfile() {
  if (store.active) return true;
  openSaved();
  setMsg("Please enter your name below to start saving articles.");
  $("#profile-name")?.focus();
  return false;
}

function toggleSave(a, sectionTitle) {
  if (!ensureProfile()) return;
  if (store.has(a.id)) store.remove(a.id);
  else store.add(a, sectionTitle);
}

function syncSaveButtons() {
  for (const btn of $$(".save-btn[data-id]")) {
    const on = store.has(btn.dataset.id);
    btn.setAttribute("aria-pressed", String(on));
    btn.textContent = on ? "★ Saved" : "☆ Save";
  }
  const savedCount = $("#saved-count");
  if (savedCount) savedCount.textContent = String(store.count());
}

function setMsg(text) { 
  const msg = $("#profile-msg");
  if (msg) msg.textContent = text || ""; 
}

function renderSavedPanel() {
  const sel = $("#profile-select");
  if (!sel) return;
  
  sel.replaceChildren(
    ...(store.profileNames().length
      ? store.profileNames().map((n) => h("option", { value: n, ...(n === store.active ? { selected: true } : {}) }, n))
      : [h("option", { value: "" }, "(no profile yet)")])
  );
  sel.disabled = !store.active;
  const profileDel = $("#profile-delete");
  if (profileDel) profileDel.disabled = !store.active;
  
  for (const id of ["#export-json", "#export-md", "#saved-search"]) {
    const el = $(id);
    if (el) el.disabled = !store.active;
  }

  const list = $("#saved-list");
  if (!list) return;
  
  const searchInput = $("#saved-search");
  const items = store.list(searchInput ? searchInput.value : "");
  
  if (!store.active) {
    list.replaceChildren(h("li", { class: "small" }, "Enter your name above to start your personal reading list."));
  } else if (!items.length) {
    list.replaceChildren(h("li", { class: "small" }, store.count() ? "No saved article matches your search." : "Nothing saved yet — tap ☆ Save on any story."));
  } else {
    list.replaceChildren(...items.map((b) =>
      h("li", {},
        h("a", { href: b.url, target: "_blank", rel: "noopener noreferrer" }, b.title),
        h("div", { class: "meta" },
          h("span", {}, b.source),
          b.section ? h("span", {}, b.section) : null,
          h("span", {}, `saved ${b.savedAt.slice(0, 10)}`),
          h("button", { type: "button", "aria-label": `Remove ${b.title}`, onclick: () => store.remove(b.id) }, "Remove"))
      )));
  }
  if (store.isMemoryOnly) setMsg("Your browser is blocking storage, so saved articles disappear when you close this tab. Use “Download” to keep a copy.");
}

function openSaved() { 
  const panel = $("#saved-panel");
  if (panel) panel.hidden = false; 
  renderSavedPanel(); 
}
function closeSaved() { 
  const panel = $("#saved-panel");
  if (panel) panel.hidden = true; 
}

$("#btn-saved")?.addEventListener("click", () => {
  const panel = $("#saved-panel");
  if (panel) {
    panel.hidden ? openSaved() : closeSaved();
  }
});
$("#saved-close")?.addEventListener("click", closeSaved);
document.addEventListener("keydown", (e) => { 
  const panel = $("#saved-panel");
  if (e.key === "Escape" && panel && !panel.hidden) closeSaved(); 
});
$("#saved-search")?.addEventListener("input", renderSavedPanel);
$("#profile-select")?.addEventListener("change", (e) => store.selectProfile(e.target.value));
$("#profile-delete")?.addEventListener("click", () => {
  if (store.active && confirm(`Delete the profile "${store.active}" and all its saved articles? This cannot be undone.`)) store.deleteProfile(store.active);
});
$("#profile-form")?.addEventListener("submit", (e) => {
  e.preventDefault();
  const nameInput = $("#profile-name");
  const res = store.createProfile(nameInput ? nameInput.value : "Saurabh Srivastav");
  setMsg(res.ok ? (res.switched ? "Welcome back! Switched to your profile." : "Profile created. Happy reading!") : res.error);
});

const stamp = () => `${(store.active || "Saurabh_Srivastav").replace(/[^\w-]+/g, "_")}-${new Date().toISOString().slice(0, 10)}`;
$("#export-json")?.addEventListener("click", () => download(`saved-${stamp()}.json`, store.exportJSON(), "application/json"));
$("#export-md")?.addEventListener("click", () => download(`saved-${stamp()}.md`, store.exportMarkdown(), "text/markdown"));
$("#import-file")?.addEventListener("change", async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const res = store.importJSON(await file.text());
  setMsg(res.ok ? `Imported ${res.added} article(s) into "${res.profile}".` : res.error);
  e.target.value = "";
});
store.addEventListener("change", () => { 
  syncSaveButtons(); 
  const panel = $("#saved-panel");
  if (panel && !panel.hidden) renderSavedPanel(); 
});

/* ------------------------------------------------------------- reader dialog */
function openReader(a, sectionTitle) {
  const rKicker = $("#reader-kicker");
  const rTitle = $("#reader-title");
  const rByline = $("#reader-byline");
  const rText = $("#reader-text");
  const rFooter = $("#reader-footer-text");
  const readerModal = $("#reader");

  if (rKicker) rKicker.textContent = `${a.source} · ${sectionTitle}`;
  if (rTitle) rTitle.textContent = a.title;
  if (rByline) rByline.textContent = [a.author && `By ${a.author}`, fmtTime(a.published)].filter(Boolean).join(" · ");
  if (rText) rText.replaceChildren(safeFragment(a.full_html));

  const lic = a.license_url
    ? h("a", { href: a.license_url, target: "_blank", rel: "noopener noreferrer" }, a.license)
    : a.license || "see original";
  if (rFooter) {
    rFooter.replaceChildren(
      `Source: ${a.source}. Licence: `, lic, ". ",
      h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, "Read the original ↗")
    );
  }
  const save = $("#reader-save");
  if (save) {
    save.dataset.id = a.id;
    save.onclick = () => toggleSave(a, sectionTitle);
  }
  syncSaveButtons();
  if (readerModal && typeof readerModal.showModal === "function") {
    readerModal.showModal();
    const body = $("#reader .reader-body");
    if (body) body.scrollTop = 0;
  }
}

/* ------------------------------------------------------------- article card */
function articleCard(a, sectionTitle, { compact = false, lead = false } = {}) {
  const readable = Boolean(a.full_html);
  const link = readable
    ? h("a", { href: a.url, onclick: (e) => { e.preventDefault(); openReader(a, sectionTitle); } }, a.title)
    : h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, a.title);
  const heading = h(lead ? "h2" : "h3", {}, link);

  return h("article", { class: `card${lead ? " lead" : ""}`, "data-text": `${a.title} ${a.summary}`.toLowerCase() },
    h("p", { class: "kicker" }, a.source),
    heading,
    !compact && a.summary ? h("p", { class: "summary" }, a.summary) : null,
    h("div", { class: "meta" },
      a.author ? h("span", {}, a.author) : null,
      a.published ? h("time", { datetime: a.published }, fmtTime(a.published)) : null,
      readable ? h("span", {}, `${Math.max(1, Math.round(a.words / WPM))} min read`) : null,
      a.license ? h("span", { class: "lic", title: "Content licence" }, a.license) : null,
      h("span", { class: "card-actions" },
        h("button", { type: "button", class: "save-btn", "data-id": a.id, "aria-pressed": "false", onclick: () => toggleSave(a, sectionTitle) }, "☆ Save"),
        h("a", { href: a.url, target: "_blank", rel: "noopener noreferrer" }, readable ? "Original ↗" : "Read at source ↗"))
    ));
}

/* ----------------------------------------------------------------- page parts */
function renderMasthead(e) {
  document.title = `${e.edition.name} — ${e.edition.date_long}`;
  const mhTitle = $("#mh-title");
  const mhDate = $("#mh-date");
  const mhTagline = $("#mh-tagline");
  const mhUpdated = $("#mh-updated");
  if (mhTitle) mhTitle.textContent = e.edition.name;
  if (mhDate) mhDate.textContent = e.edition.date_long;
  if (mhTagline) mhTagline.textContent = e.edition.tagline;
  if (mhUpdated) mhUpdated.textContent = `Clinical Edition Compiled ${fmtTime(e.edition.generated_at)}`;
}

function renderNav(e) {
  const nav = $("#section-nav");
  if (nav) {
    nav.replaceChildren(
      h("li", {}, h("a", { href: "#glance" }, "Clinical Glance")),
      ...e.sections.map((s) => h("li", {}, h("a", { href: `#sec-${s.id}` }, s.title)))
    );
  }
}

function renderDashboard(e) {
  const d = e.dashboard;
  const stat = (num, lbl) => h("div", { class: "stat" }, h("div", { class: "num" }, String(num)), h("div", { class: "lbl" }, lbl));

  const chips = d.keywords.length
    ? d.keywords.map((k) =>
        h("button", { type: "button", class: "chip", "aria-pressed": String(keyword === k.term), onclick: () => setKeyword(keyword === k.term ? "" : k.term) },
          k.term, h("small", {}, `×${k.count}`)))
    : [h("span", { class: "empty" }, "Synthesizing clinical trend signals...")];

  const markets = d.markets.length
    ? d.markets.map((m) => {
        const up = m.change_pct > 0, down = m.change_pct < 0;
        const chg = m.change_pct == null ? "" : `${up ? "▲ +" : down ? "▼ " : ""}${m.change_pct.toFixed(2)}%`;
        return h("li", { title: `Source: ${m.source}` },
          h("span", {}, m.label),
          h("span", {}, h("span", { class: "val" }, m.display), " ", h("span", { class: `chg ${up ? "up" : down ? "down" : ""}` }, chg)));
      })
    : [h("li", { class: "empty" }, "Global financial indices updating...")];

  return h("section", { class: "glance", id: "glance", "aria-labelledby": "glance-h" },
    h("h2", { id: "glance-h" }, "Clinical Intelligence at a Glance"),
    h("div", { class: "stats" },
      stat(d.total_articles, "Briefings Curated"),
      stat(`~${d.reading_minutes} min`, "Clinician Reading Time"),
      stat(d.source_count, "Global Sources"),
      stat(d.full_text_count, "Deep-Dive Syntheses")),
    h("div", { class: "glance-row" },
      h("div", {}, h("h3", {}, "Clinical Keywords & Themes"), h("div", { class: "chips" }, chips)),
      h("div", {}, h("h3", {}, "Global Markets & Indices"), h("ul", { class: "markets" }, markets),
        h("p", { class: "fine" }, "Source: Stooq, ECB, CoinGecko. Curated for evidence-based decision-making."))));
}

function wordBox(e) {
  const w = e.word_of_the_day, dw = e.dictionary_word;
  if (!w) return null;
  return h("aside", { class: "wotd", "aria-label": "Medical Lexicon" },
    h("p", { class: "label" }, "Medical Lexicon · Word of the Day"),
    h("div", { class: "term" }, w.term),
    h("span", { class: "pos" }, [w.pos, w.domain].filter(Boolean).join(" · ")),
    h("p", {}, w.definition),
    w.example ? h("p", { class: "example" }, `“${w.example}”`) : null,
    dw ? h("div", { class: "alt" }, h("strong", {}, "From the Lexicon Vault: "),
      h("a", { href: dw.url, target: "_blank", rel: "noopener noreferrer" }, dw.word),
      ` — ${dw.definition} `, h("small", {}, `(${dw.source})`)) : null);
}

function renderFrontPage(sec) {
  const [lead, ...rest] = sec.articles;
  if (!lead) return null;
  const alsoList = rest.slice(0, 4);
  
  return h("section", { class: "frontpage", id: `sec-${sec.id}`, "aria-label": sec.title },
    h("div", {},
      h("img", { class: "daily-hero-img", src: getDailyHeroImage(), alt: "Medical Editorial Visual", onerror: (e) => e.target.remove() }),
      articleCard(lead, sec.title, { lead: true })
    ),
    h("div", { class: "also" }, h("h3", {}, "Key Findings"),
      alsoList.map((a) => articleCard(a, sec.title, { compact: true })))
  );
}

function renderSection(sec, list, isMore = false) {
  const body = [];
  if (sec.id === "medical-trends") body.push(wordBox(edition));
  body.push(...list.map((a) => articleCard(a, sec.title)));
  return h("section", { class: "section", id: isMore ? `sec-${sec.id}-more` : `sec-${sec.id}` },
    h("div", { class: "section-head" },
      h("h2", {}, isMore ? `${sec.title} — Extended Analysis` : sec.title),
      h("span", { class: "kicker" }, sec.kicker)),
    list.length || sec.id === "medical-trends"
      ? h("div", { class: "columns" }, body)
      : h("p", { class: "empty" }, "No briefings available for this sector today."));
}

function renderColophon(e) {
  const sources = e.sources.map((s) =>
    h("li", {},
      s.site ? h("a", { href: s.site, target: "_blank", rel: "noopener noreferrer" }, s.name) : s.name,
      s.license ? ` — ${s.license}` : null,
      s.full_text ? " (full synthesis)" : ""));
  return [
    h("h2", {}, "Sources & Clinical Attribution"),
    h("p", {}, "Curated securely from authoritative global publisher feeds. Designed solely for clinician-level review with zero tracking or commercial telemetry. For information only; it is not medical advice."),
    h("ul", {}, sources),
    e.errors?.length
      ? h("details", {}, h("summary", {}, `${e.errors.length} feed synchronization note(s)`), h("ul", {}, e.errors.map((x) => h("li", {}, x))))
      : null,
  ];
}

/* ----------------------------------------------------------------- filtering */
function setKeyword(term) {
  keyword = term;
  for (const chip of $$(".chip")) chip.setAttribute("aria-pressed", String(chip.firstChild.textContent === term));
  for (const card of $$(".card")) card.hidden = Boolean(term) && !card.dataset.text.includes(term);
  for (const box of $$(".section, .frontpage")) box.hidden = Boolean(term) && !$(".card:not([hidden])", box);
  const notice = $("#notice");
  if (!notice) return;
  notice.hidden = !term && !edition.edition.is_sample;
  if (term) {
    notice.replaceChildren(`Filtering clinical briefings mentioning “${term}”. `, h("button", { type: "button", onclick: () => setKeyword("") }, "Clear filter"));
  } else if (edition.edition.is_sample) {
    showSampleNotice();
  }
}
function showSampleNotice() {
  const notice = $("#notice");
  if (!notice) return;
  notice.hidden = false;
  notice.textContent = "Sample edition active. Trigger the GitHub Actions workflow for real-time medical feeds.";
}

/* ---------------------------------------------------------------- main render */
function render(e) {
  edition = e;
  keyword = "";
  articles.clear();
  for (const s of e.sections) for (const a of s.articles) articles.set(a.id, { a, sectionTitle: s.title });

  renderMasthead(e);
  renderNav(e);
  const main = $("#edition");
  if (!main) return;
  
  const national = e.sections[0];
  const parts = [renderDashboard(e)];

  let nationalRest = [];
  if (national) {
    const front = renderFrontPage(national);
    if (front) parts.push(front);
    nationalRest = national.articles.slice(front ? 5 : 0);
    if (nationalRest.length) parts.push(renderSection(national, nationalRest, true));
  }
  for (const s of e.sections.slice(1)) parts.push(renderSection(s, s.articles));

  main.replaceChildren(...parts);
  const colophon = $("#colophon");
  if (colophon) colophon.replaceChildren(...renderColophon(e).filter(Boolean));
  
  const notice = $("#notice");
  if (notice) notice.hidden = !e.edition.is_sample;
  if (e.edition.is_sample) showSampleNotice();
  syncSaveButtons();
  
  const profileNameInput = $("#profile-name");
  if (profileNameInput && store.active) profileNameInput.value = store.active;
}

async function getJson(path) {
  // Resolve relative to the page itself, so it works on GitHub Pages (/repo-name/), Vercel and localhost.
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  const url = new URL(cleanPath, location.href).href;

  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

async function loadEdition(date) {
  try {
    render(await getJson(date ? `data/${date}.json` : "data/latest.json"));
  } catch (err) {
    const main = $("#edition");
    if (main) {
      main.replaceChildren(h("p", { class: "notice" },
        "Awaiting compilation of today's clinical edition. Details: " + err.message));
    }
  }
}

async function init() {
  let dates = [];
  try { dates = (await getJson("data/index.json")).dates; } catch { /* fine */ }
  const picker = $("#date-picker");
  if (picker) {
    picker.replaceChildren(...dates.map((d, i) => h("option", { value: d }, i === 0 ? `${d} (latest)` : d)));
    picker.hidden = dates.length < 2;
    picker.addEventListener("change", () => loadEdition(picker.value));
  }
  await loadEdition(new URLSearchParams(location.search).get("date") || "");
  renderSavedPanel();
}

init();
