/**
 * bookmarks.js - the bookmarking system.
 *
 * HOW IT WORKS (plain English)
 *   - Saved articles are kept in your browser's own storage (localStorage),
 *     grouped under a profile name you choose (e.g. "Asha").
 *   - Nothing is sent to any server. No account, no database to maintain.
 *   - Each saved article stores a small COPY of its headline, link, source and
 *     excerpt, so it stays in your list even after the daily edition changes.
 *   - You can export a profile as JSON (to restore/move it) or Markdown
 *     (to read in any notes app), and import a JSON backup later.
 *
 * DATA SHAPE (stored under one key, easy to read and fix by hand)
 *   {
 *     schema: 1,
 *     active: "Asha",
 *     profiles: {
 *       "Asha": { created: "2026-11-14T06:00:00Z",
 *                 bookmarks: { "<articleId>": { id, title, url, source, section,
 *                                             summary, published, author, savedAt } } }
 *     }
 *   }
 */

const STORAGE_KEY = "daily-differential:v1";
const SCHEMA = 1;
const APP_ID = "daily-differential";

/** localStorage can be blocked (private mode, strict settings). Fall back to memory. */
function pickStorage() {
  try {
    const probe = "__ml_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
      removeItem: (k) => mem.delete(k),
      isMemory: true,
    };
  }
}

/** Only allow http(s) links - protects against "javascript:" links in imported files. */
function safeUrl(u) {
  try {
    const url = new URL(String(u));
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

const str = (v, max = 600) => (typeof v === "string" ? v.slice(0, max) : "");

/** Reduce any object to exactly the fields we store (also used for imports). */
function cleanBookmark(b) {
  const url = safeUrl(b?.url);
  if (!url || !str(b?.title)) return null;
  return {
    id: str(b.id, 64) || url,
    title: str(b.title, 300),
    url,
    source: str(b.source, 120),
    section: str(b.section, 120),
    summary: str(b.summary, 800),
    author: str(b.author, 200),
    published: str(b.published, 40),
    savedAt: str(b.savedAt, 40) || new Date().toISOString(),
  };
}

const escapeMd = (s) => s.replace(/([\[\]])/g, "\\$1");

export class BookmarkStore extends EventTarget {
  constructor() {
    super();
    this.storage = pickStorage();
    this.data = this.#load();
    // Keep several open tabs in sync.
    window.addEventListener("storage", (e) => {
      if (e.key === STORAGE_KEY) {
        this.data = this.#load();
        this.#emit();
      }
    });
  }

  /* ---------- internal ---------- */
  #load() {
    try {
      const parsed = JSON.parse(this.storage.getItem(STORAGE_KEY) || "null");
      if (parsed && parsed.schema === SCHEMA && parsed.profiles && typeof parsed.profiles === "object") {
        if (!parsed.profiles[parsed.active]) parsed.active = Object.keys(parsed.profiles)[0] ?? null;
        return parsed;
      }
    } catch {
      /* corrupted data: start fresh rather than crash */
    }
    return { schema: SCHEMA, active: null, profiles: {} };
  }

  #save() {
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      /* storage full or blocked - the in-memory copy still works this session */
    }
    this.#emit();
  }

  #emit() {
    this.dispatchEvent(new Event("change"));
  }

  #profile() {
    return this.data.active ? this.data.profiles[this.data.active] : null;
  }

  /* ---------- profiles ---------- */
  get isMemoryOnly() {
    return Boolean(this.storage.isMemory);
  }
  get active() {
    return this.data.active;
  }
  profileNames() {
    return Object.keys(this.data.profiles).sort((a, b) => a.localeCompare(b));
  }

  /** @returns {{ok:boolean, error?:string}} */
  createProfile(rawName) {
    const name = String(rawName ?? "").trim().replace(/\s+/g, " ");
    if (!name) return { ok: false, error: "Please type a name." };
    if (name.length > 40) return { ok: false, error: "Names can be up to 40 characters." };
    if (name === "__proto__" || name === "constructor") return { ok: false, error: "Please choose another name." };
    const clash = this.profileNames().find((n) => n.toLowerCase() === name.toLowerCase());
    if (clash) {
      this.data.active = clash; // same person typing their name again: just switch
      this.#save();
      return { ok: true, switched: true };
    }
    this.data.profiles[name] = { created: new Date().toISOString(), bookmarks: {} };
    this.data.active = name;
    this.#save();
    return { ok: true };
  }

  selectProfile(name) {
    if (this.data.profiles[name]) {
      this.data.active = name;
      this.#save();
    }
  }

  deleteProfile(name) {
    if (!this.data.profiles[name]) return;
    delete this.data.profiles[name];
    if (this.data.active === name) this.data.active = this.profileNames()[0] ?? null;
    this.#save();
  }

  /* ---------- bookmarks ---------- */
  has(id) {
    return Boolean(this.#profile()?.bookmarks[id]);
  }

  count() {
    const p = this.#profile();
    return p ? Object.keys(p.bookmarks).length : 0;
  }

  /** Add an article (needs an active profile - the UI asks for a name first). */
  add(article, sectionTitle = "") {
    const p = this.#profile();
    if (!p) return false;
    const clean = cleanBookmark({ ...article, section: sectionTitle || article.section, savedAt: new Date().toISOString() });
    if (!clean) return false;
    p.bookmarks[clean.id] = clean;
    this.#save();
    return true;
  }

  remove(id) {
    const p = this.#profile();
    if (p && p.bookmarks[id]) {
      delete p.bookmarks[id];
      this.#save();
    }
  }

  /** Newest first. Optional case-insensitive search over title/source/summary/section. */
  list(query = "") {
    const p = this.#profile();
    if (!p) return [];
    const q = query.trim().toLowerCase();
    return Object.values(p.bookmarks)
      .filter((b) => !q || `${b.title} ${b.source} ${b.summary} ${b.section}`.toLowerCase().includes(q))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  /* ---------- export / import ---------- */
  exportJSON() {
    const p = this.#profile();
    return JSON.stringify(
      { app: APP_ID, schema: SCHEMA, profile: this.data.active, exportedAt: new Date().toISOString(), bookmarks: p ? Object.values(p.bookmarks) : [] },
      null,
      2
    );
  }

  exportMarkdown() {
    const items = this.list();
    const lines = [`# Saved articles — ${this.data.active ?? "Reader"}`, "", `_Exported ${new Date().toISOString().slice(0, 10)} from The Daily Differential._`, ""];
    const bySection = new Map();
    for (const b of items) {
      const key = b.section || "Other";
      if (!bySection.has(key)) bySection.set(key, []);
      bySection.get(key).push(b);
    }
    for (const [section, list] of bySection) {
      lines.push(`## ${section}`, "");
      for (const b of list) {
        const when = b.published ? ` · ${b.published.slice(0, 10)}` : "";
        lines.push(`- [${escapeMd(b.title)}](${b.url}) — ${b.source}${when}`);
        if (b.summary) lines.push(`  > ${b.summary.replace(/\n+/g, " ")}`);
      }
      lines.push("");
    }
    return lines.join("\n");
  }

  /**
   * Import a JSON backup made by exportJSON(). Merges into the profile named in
   * the file (creating it if needed). Never deletes existing bookmarks.
   * @returns {{ok:boolean, added?:number, profile?:string, error?:string}}
   */
  importJSON(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, error: "That file is not valid JSON." };
    }
    if (parsed?.app !== APP_ID || !Array.isArray(parsed.bookmarks)) {
      return { ok: false, error: "That doesn't look like a Daily Differential backup." };
    }
    const name = str(parsed.profile, 40).trim() || "Imported";
    if (name === "__proto__" || name === "constructor") return { ok: false, error: "Invalid profile name in file." };
    if (!this.data.profiles[name]) this.data.profiles[name] = { created: new Date().toISOString(), bookmarks: {} };
    let added = 0;
    for (const raw of parsed.bookmarks.slice(0, 5000)) {
      const clean = cleanBookmark(raw);
      if (clean) {
        this.data.profiles[name].bookmarks[clean.id] = clean;
        added++;
      }
    }
    this.data.active = name;
    this.#save();
    return { ok: true, added, profile: name };
  }
}
