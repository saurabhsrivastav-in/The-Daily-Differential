#!/usr/bin/env python3
"""
fetch_news.py - builds today's edition of your personal medical newspaper.

WHAT IT DOES (in plain English)
  1. Reads the list of public RSS/Atom feeds in scripts/feeds.json.
  2. Downloads each feed politely (identifies itself, one request per feed,
     short pause between requests, never scrapes web pages).
  3. Keeps the newest stories, removes duplicates, and writes a SHORT excerpt
     (about 45 words) of what the publisher itself put in its feed.
  4. For a few openly-licensed sources (e.g. Creative Commons) it also keeps
     the full article text, together with licence + attribution.
  5. Adds free open data: stock indices, currency rates, crypto prices.
  6. Picks a "Medical Word of the Day" and (optionally) a dictionary word.
  7. Works out dashboard numbers: article count, reading time, keywords.
  8. Saves everything as JSON files in docs/data/ for the web page to display.

COMPLIANCE BY DESIGN
  * Only public RSS/Atom feeds and open APIs are used - no HTML scraping,
    no login/paywall bypass.
  * Closed-licence publishers: only headline + short excerpt + link back.
  * Full text is kept ONLY for feeds you mark "full_text": true in feeds.json
    (and you should only do that for content whose licence allows it).
  * Every article carries its source name, author (if given), original URL
    and licence note so the page can attribute it properly.

USAGE
    python scripts/fetch_news.py            # normal daily run
    python scripts/fetch_news.py --sample   # offline demo data (no internet)

Only needs:  pip install -r scripts/requirements.txt
"""

from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import hashlib
import html
import io
import json
import math
import re
import sys
import time
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

# ---------------------------------------------------------------------------
# Settings you rarely need to change
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = ROOT / "scripts" / "feeds.json"
TERMS_FILE = ROOT / "scripts" / "medical_terms.json"
DEFAULT_OUT = ROOT / "docs" / "data"

# A polite, honest identity. Publishers can see who is knocking.
USER_AGENT = "DailyDifferentialBot/1.0 (personal RSS reader; reads public feeds only)"
TIMEOUT_SECONDS = 20
PAUSE_BETWEEN_REQUESTS = 0.6  # seconds - be kind to servers
WORDS_PER_MINUTE = 230  # average adult reading speed


# ---------------------------------------------------------------------------
# 1. Text helpers: turn messy HTML into clean text / safe HTML
# ---------------------------------------------------------------------------
class _TextExtractor(HTMLParser):
    """Strips HTML tags and returns readable plain text."""

    BLOCK = {"p", "br", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "tr"}
    SKIP = {"script", "style", "noscript", "iframe", "svg", "form", "button"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in self.SKIP:
            self._skip += 1
        elif tag in self.BLOCK:
            self.parts.append(" ")

    def handle_endtag(self, tag):
        if tag in self.SKIP:
            self._skip = max(0, self._skip - 1)
        elif tag in self.BLOCK:
            self.parts.append(" ")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)


def html_to_text(raw: str) -> str:
    """'<p>Hello <b>world</b></p>' -> 'Hello world'"""
    parser = _TextExtractor()
    parser.feed(raw or "")
    parser.close()
    return re.sub(r"\s+", " ", "".join(parser.parts)).strip()


# Only these tags survive in "full text" articles. Everything else (images,
# ads, scripts, tracking pixels, embeds, forms) is dropped. This keeps the
# page distraction-free and safe.
ALLOWED_TAGS = {"p", "h2", "h3", "h4", "ul", "ol", "li", "blockquote",
                "em", "strong", "b", "i", "a", "br", "code", "pre"}
DROP_WITH_CONTENT = {"script", "style", "noscript", "iframe", "svg", "form", "button",
                     "figure", "aside", "table", "video", "audio", "object",
                     "select", "textarea"}
HEADING_MAP = {"h1": "h2", "h5": "h4", "h6": "h4"}  # flatten odd heading levels


class _Sanitizer(HTMLParser):
    """Rebuilds HTML using only the allow-listed tags above."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.out: list[str] = []
        self._drop = 0           # >0 while inside a dropped element
        self._stack: list[str] = []  # open tags, so we always close properly

    def handle_starttag(self, tag, attrs):
        if tag in DROP_WITH_CONTENT:
            self._drop += 1
            return
        if self._drop:
            return
        tag = HEADING_MAP.get(tag, tag)
        if tag not in ALLOWED_TAGS:
            return
        if tag == "br":
            self.out.append("<br>")
            return
        if tag == "a":
            href = (dict(attrs).get("href") or "").strip()
            if re.match(r"^https?://", href, re.I):
                self.out.append(f'<a href="{html.escape(href, quote=True)}">')
            else:
                self.out.append("<a>")
        else:
            self.out.append(f"<{tag}>")
        self._stack.append(tag)

    def handle_endtag(self, tag):
        if tag in DROP_WITH_CONTENT:
            self._drop = max(0, self._drop - 1)
            return
        if self._drop:
            return
        tag = HEADING_MAP.get(tag, tag)
        if tag in self._stack:  # close only tags we actually opened
            while self._stack:
                top = self._stack.pop()
                self.out.append(f"</{top}>")
                if top == tag:
                    break

    def handle_data(self, data):
        if not self._drop:
            self.out.append(html.escape(data))

    def result(self) -> str:
        while self._stack:
            self.out.append(f"</{self._stack.pop()}>")
        return "".join(self.out)


def sanitize_html(raw: str) -> str:
    parser = _Sanitizer()
    parser.feed(raw or "")
    parser.close()
    cleaned = parser.result()
    return re.sub(r"<p>\s*</p>", "", cleaned).strip()


_SENTENCE_SPLIT = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9“\"'])")


def summarize(text: str, max_words: int) -> str:
    """
    Very small *extractive* summary: keep the opening whole sentences until the
    word budget is used. No AI service, no API key, nothing sent anywhere.
    """
    text = (text or "").strip()
    words = text.split()
    if len(words) <= max_words:
        return text
    kept: list[str] = []
    count = 0
    for sentence in _SENTENCE_SPLIT.split(text):
        n = len(sentence.split())
        if count + n > max_words:
            if not kept:  # first sentence alone is too long -> trim it
                return " ".join(words[:max_words]).rstrip(",;:") + "…"
            break
        kept.append(sentence)
        count += n
    return " ".join(kept)


# ---------------------------------------------------------------------------
# 2. Turning one feed entry into one clean article record
# ---------------------------------------------------------------------------
def entry_datetime(entry) -> dt.datetime | None:
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        stamp = entry.get(key)
        if stamp:
            return dt.datetime(*stamp[:6], tzinfo=dt.timezone.utc)
    return None


def article_id(url: str) -> str:
    """Stable short id so bookmarks keep working across days."""
    return hashlib.sha1(url.encode("utf-8")).hexdigest()[:12]


def normalise_entry(entry, feed: dict, section_id: str, limits: dict) -> dict | None:
    link = (entry.get("link") or "").strip()
    title = html_to_text(entry.get("title", ""))
    if not title or not link.startswith(("http://", "https://")):
        return None

    raw_summary = entry.get("summary") or entry.get("description") or ""
    content_blocks = [c.get("value", "") for c in (entry.get("content") or [])]
    # Longest body the feed supplied (only used if the feed is marked full_text)
    candidates = content_blocks + ([raw_summary] if feed.get("full_text") else [])
    raw_full = max(candidates, key=len) if candidates else ""

    plain = html_to_text(raw_summary or raw_full)
    # Remove WordPress-style footer: "The post X appeared first on Y."
    plain = re.sub(r"\s*The post .{0,200}? appeared first on .{0,120}$", "", plain).strip()
    summary = summarize(plain, limits["summary_words"])
    if summary.lower().rstrip(".") == title.lower().rstrip("."):
        summary = ""

    full_html = None
    if feed.get("full_text") and raw_full:
        cleaned = sanitize_html(raw_full)
        if len(html_to_text(cleaned).split()) >= limits["min_full_words"]:
            full_html = cleaned

    shown_text = html_to_text(full_html) if full_html else summary
    published = entry_datetime(entry)

    return {
        "id": article_id(link),
        "title": title,
        "url": link,
        "source": feed["name"],
        "section": section_id,
        "author": html_to_text(entry.get("author", "")),
        "published": published.isoformat() if published else None,
        "summary": summary,
        "full_html": full_html,
        "license": feed.get("license", ""),
        "license_url": feed.get("license_url", ""),
        "words": len(shown_text.split()),
    }


# ---------------------------------------------------------------------------
# 3. Downloading feeds and assembling sections
# ---------------------------------------------------------------------------
def make_session():
    import requests  # imported here so --sample works even without requests

    session = requests.Session()
    session.headers.update({
        "User-Agent": USER_AGENT,
        "Accept": "application/rss+xml, application/atom+xml, application/xml;q=0.9, */*;q=0.8",
    })
    return session


def fetch_feed(feed: dict, session):
    import feedparser

    response = session.get(feed["url"], timeout=TIMEOUT_SECONDS)
    response.raise_for_status()
    parsed = feedparser.parse(response.content)
    if not parsed.entries:
        raise ValueError("feed contained no entries")
    return parsed


def _matches_keywords(article: dict, keywords: list[str] | None) -> bool:
    """Optional per-feed filter: keep a story only if its title/excerpt mentions a keyword."""
    if not keywords:
        return True
    text = f"{article['title']} {article['summary']}".lower()
    return any(k.lower() in text for k in keywords)


def _title_key(title: str) -> str:
    return re.sub(r"[^a-z0-9]+", " ", title.lower()).strip()


def build_section(section: dict, cfg: dict, now_utc: dt.datetime, session,
                  seen_urls: set, seen_titles: set, errors: list[str]) -> dict:
    limits = cfg["limits"]
    cutoff = now_utc - dt.timedelta(hours=limits["max_age_hours"])
    per_section = section.get("per_section", limits["per_section"])
    per_feed_lists: list[list[dict]] = []

    for feed in section["feeds"]:
        try:
            parsed = fetch_feed(feed, session)
        except Exception as exc:  # one broken feed must never stop the paper
            errors.append(f"{feed['name']}: {exc}")
            print(f"  ! skipped {feed['name']}: {exc}", file=sys.stderr)
            time.sleep(PAUSE_BETWEEN_REQUESTS)
            continue

        items = []
        for entry in parsed.entries[: limits["scan_per_feed"]]:
            article = normalise_entry(entry, feed, section["id"], limits)
            if article and _matches_keywords(article, feed.get("keywords")):
                items.append(article)

        def is_recent(a):
            return a["published"] and dt.datetime.fromisoformat(a["published"]) >= cutoff

        recent = [a for a in items if is_recent(a)]
        chosen = recent if recent else items[:2]  # quiet day? keep the newest two
        chosen.sort(key=lambda a: a["published"] or "", reverse=True)
        per_feed_lists.append(chosen[: limits["per_feed"]])
        print(f"  + {feed['name']}: {len(chosen[: limits['per_feed']])} stories")
        time.sleep(PAUSE_BETWEEN_REQUESTS)

    # Round-robin across feeds so one publisher cannot fill the whole section
    merged: list[dict] = []
    depth = 0
    while len(merged) < per_section and any(depth < len(lst) for lst in per_feed_lists):
        for lst in per_feed_lists:
            if depth < len(lst) and len(merged) < per_section:
                a = lst[depth]
                key = _title_key(a["title"])
                if a["url"] in seen_urls or key in seen_titles:
                    continue
                seen_urls.add(a["url"])
                seen_titles.add(key)
                merged.append(a)
        depth += 1

    merged.sort(key=lambda a: a["published"] or "", reverse=True)
    return {"id": section["id"], "title": section["title"],
            "kicker": section.get("kicker", ""), "articles": merged}


# ---------------------------------------------------------------------------
# 4. Dashboard: keywords, reading time
# ---------------------------------------------------------------------------
STOPWORDS = set("""
a about above after again against all also am an and any are as at be because been before being below between both
but by can could did do does doing down during each few for from further had has have having he her here hers him his
how i if in into is it its just like made make many may more most much new news no nor not now of off on once one only
or other our out over own per said say says same she should so some such than that the their theirs them then there
these they this those through to too under until up us use used using very was we were what when where which while who
whom why will with would year years you your yours today week says report reports first last next back get gets got
set top big says after amid across via vs will new latest update updates read read more according told still
""".split())
_WORD = re.compile(r"[A-Za-z][A-Za-z\-']{2,}")


def top_keywords(articles: list[dict], how_many: int = 12) -> list[dict]:
    """
    Counts in how many DIFFERENT stories a word (or two-word phrase) appears,
    so one long story cannot dominate. Titles count double.
    """
    uni: collections.Counter = collections.Counter()
    bi: collections.Counter = collections.Counter()
    for a in articles:
        weighted = f"{a['title']} {a['title']} {a['summary']}"
        tokens = [t.lower().strip("-'") for t in _WORD.findall(weighted)]
        seen_u, seen_b = set(), set()
        for i, tok in enumerate(tokens):
            if tok in STOPWORDS or len(tok) < 4:
                continue
            seen_u.add(tok)
            if i + 1 < len(tokens):
                nxt = tokens[i + 1]
                if nxt not in STOPWORDS and len(nxt) >= 4:
                    seen_b.add(f"{tok} {nxt}")
        uni.update(seen_u)
        bi.update(seen_b)

    chosen: list[tuple[str, int]] = []
    used_words: set[str] = set()
    for phrase, n in bi.most_common(40):
        if n >= 2 and len(chosen) < how_many // 3:
            chosen.append((phrase, n))
            used_words.update(phrase.split())
    for word, n in uni.most_common(80):
        if len(chosen) >= how_many:
            break
        if n >= 2 and word not in used_words:
            chosen.append((word, n))
    return [{"term": t, "count": n} for t, n in sorted(chosen, key=lambda x: -x[1])]


# ---------------------------------------------------------------------------
# 5. Market indicators (free, key-less, public data)
# ---------------------------------------------------------------------------
def _fmt(value: float) -> str:
    return f"{value:,.4f}" if abs(value) < 10 else f"{value:,.2f}"


def fetch_indices(cfg_indices: list[dict], session, errors: list[str]) -> list[dict]:
    """Stooq quote CSV. Change is measured from today's open (stooq gives no prior close)."""
    if not cfg_indices:
        return []
    symbols = "+".join(i["symbol"] for i in cfg_indices)
    url = f"https://stooq.com/q/l/?s={symbols}&f=sd2t2ohlcv&h&e=csv"
    labels = {i["symbol"].lower(): i["label"] for i in cfg_indices}
    rows = []
    try:
        resp = session.get(url, timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        for rec in csv.DictReader(io.StringIO(resp.text)):
            try:
                close, open_ = float(rec["Close"]), float(rec["Open"])
            except (ValueError, KeyError, TypeError):
                continue  # 'N/D' = no data for that symbol
            sym = rec["Symbol"].lower()
            rows.append({"label": labels.get(sym, rec["Symbol"]), "group": "Indices",
                         "display": _fmt(close),
                         "change_pct": round((close - open_) / open_ * 100, 2) if open_ else None,
                         "source": "Stooq"})
    except Exception as exc:
        errors.append(f"Stooq indices: {exc}")
    return rows


def fetch_fx(cfg_fx: dict | None, session, errors: list[str]) -> list[dict]:
    """Frankfurter = free API serving European Central Bank reference rates."""
    if not cfg_fx:
        return []
    base, syms = cfg_fx["base"], ",".join(cfg_fx["symbols"])
    rows = []
    try:
        latest = session.get(f"https://api.frankfurter.dev/v1/latest?base={base}&symbols={syms}",
                             timeout=TIMEOUT_SECONDS)
        latest.raise_for_status()
        data = latest.json()
        prev_rates = {}
        try:  # previous working day for a daily change figure
            d = dt.date.fromisoformat(data["date"]) - dt.timedelta(days=1)
            prev = session.get(f"https://api.frankfurter.dev/v1/{d.isoformat()}?base={base}&symbols={syms}",
                               timeout=TIMEOUT_SECONDS)
            prev.raise_for_status()
            prev_rates = prev.json().get("rates", {})
        except Exception:
            pass
        for code, rate in data["rates"].items():
            old = prev_rates.get(code)
            rows.append({"label": f"{base}/{code}", "group": "Currencies", "display": _fmt(rate),
                         "change_pct": round((rate - old) / old * 100, 2) if old else None,
                         "source": "ECB via Frankfurter"})
    except Exception as exc:
        errors.append(f"Frankfurter FX: {exc}")
    return rows


def fetch_crypto(cfg_crypto: dict | None, session, errors: list[str]) -> list[dict]:
    if not cfg_crypto:
        return []
    ids, vs = ",".join(cfg_crypto["ids"]), cfg_crypto.get("vs", "usd")
    rows = []
    try:
        resp = session.get("https://api.coingecko.com/api/v3/simple/price",
                           params={"ids": ids, "vs_currencies": vs, "include_24hr_change": "true"},
                           timeout=TIMEOUT_SECONDS)
        resp.raise_for_status()
        for coin, vals in resp.json().items():
            chg = vals.get(f"{vs}_24h_change")
            rows.append({"label": f"{coin.capitalize()} ({vs.upper()})", "group": "Crypto",
                         "display": _fmt(vals[vs]),
                         "change_pct": round(chg, 2) if chg is not None else None,
                         "source": "CoinGecko"})
    except Exception as exc:
        errors.append(f"CoinGecko: {exc}")
    return rows


def fetch_markets(cfg: dict, session, errors: list[str]) -> list[dict]:
    m = cfg.get("markets", {})
    return (fetch_indices(m.get("indices", []), session, errors)
            + fetch_fx(m.get("fx"), session, errors)
            + fetch_crypto(m.get("crypto"), session, errors))


# ---------------------------------------------------------------------------
# 6. Words of the day
# ---------------------------------------------------------------------------
def medical_word_of_the_day(today: dt.date) -> dict:
    """Rotates through our own hand-written list (scripts/medical_terms.json)."""
    terms = json.loads(TERMS_FILE.read_text(encoding="utf-8"))
    entry = dict(terms[today.toordinal() % len(terms)])
    entry["source"] = "The Daily Differential glossary"
    return entry


def dictionary_word(cfg: dict, session, errors: list[str]) -> dict | None:
    """Wiktionary's featured 'Word of the day' feed (CC BY-SA 4.0)."""
    wcfg = cfg.get("dictionary_word", {})
    if not wcfg.get("enabled"):
        return None
    try:
        parsed = fetch_feed({"name": "Wiktionary", "url": wcfg["url"]}, session)
        entry = max(parsed.entries, key=lambda e: e.get("published_parsed") or e.get("updated_parsed") or (0,))
        return {"word": html_to_text(entry.get("title", "")),
                "definition": summarize(html_to_text(entry.get("summary", "")), 40),
                "url": entry.get("link", "https://en.wiktionary.org/"),
                "source": "Wiktionary", "license": "CC BY-SA 4.0",
                "license_url": "https://creativecommons.org/licenses/by-sa/4.0/"}
    except Exception as exc:
        errors.append(f"Wiktionary: {exc}")
        return None


# ---------------------------------------------------------------------------
# 7. Put the whole edition together
# ---------------------------------------------------------------------------
def assemble(cfg: dict, now: dt.datetime, sections: list[dict], markets: list[dict],
             word: dict, dict_word: dict | None, errors: list[str], is_sample: bool) -> dict:
    all_articles = [a for s in sections for a in s["articles"]]
    total_words = sum(a["words"] for a in all_articles)

    feed_meta = {f["name"]: f for s in cfg["sections"] for f in s["feeds"]}
    sources = []
    for name in sorted({a["source"] for a in all_articles}):
        meta = feed_meta.get(name, {})
        site = urlparse(meta["url"]) if meta.get("url") else None
        sources.append({"name": name,
                        "site": f"{site.scheme}://{site.netloc}" if site else "",
                        "license": meta.get("license", ""),
                        "license_url": meta.get("license_url", ""),
                        "full_text": bool(meta.get("full_text"))})

    return {
        "edition": {
            "name": cfg["edition"]["name"],
            "tagline": cfg["edition"].get("tagline", ""),
            "date": now.date().isoformat(),
            "date_long": f"{now:%A}, {now.day} {now:%B %Y}",
            "timezone": cfg["edition"]["timezone"],
            "generated_at": now.isoformat(timespec="minutes"),
            "is_sample": is_sample,
        },
        "dashboard": {
            "total_articles": len(all_articles),
            "reading_minutes": max(1, math.ceil(total_words / WORDS_PER_MINUTE)) if all_articles else 0,
            "source_count": len(sources),
            "full_text_count": sum(1 for a in all_articles if a["full_html"]),
            "per_section": {s["id"]: len(s["articles"]) for s in sections},
            "keywords": top_keywords(all_articles),
            "markets": markets,
        },
        "word_of_the_day": word,
        "dictionary_word": dict_word,
        "sections": sections,
        "sources": sources,
        "errors": errors,
    }


def build_edition(cfg: dict, now: dt.datetime) -> dict:
    session = make_session()
    errors: list[str] = []
    seen_urls: set = set()
    seen_titles: set = set()
    sections = []
    now_utc = now.astimezone(dt.timezone.utc)
    for section in cfg["sections"]:
        print(f"[{section['title']}]")
        sections.append(build_section(section, cfg, now_utc, session, seen_urls, seen_titles, errors))
    print("[Markets]")
    markets = fetch_markets(cfg, session, errors)
    word = medical_word_of_the_day(now.date())
    dict_word = dictionary_word(cfg, session, errors)
    return assemble(cfg, now, sections, markets, word, dict_word, errors, is_sample=False)


def build_sample(cfg: dict, now: dt.datetime) -> dict:
    """Offline demo edition so the web page works before the first real run."""
    stamp = now.replace(microsecond=0).isoformat()
    blurb = "This is placeholder text. Run the workflow (or scripts/fetch_news.py) to replace it with real, attributed stories from your feeds."
    sections = []
    for s in cfg["sections"]:
        arts = []
        for n in (1, 2):
            url = f"https://example.com/sample/{s['id']}-{n}"
            arts.append({"id": article_id(url), "title": f"Sample headline {n}: {s['title']}",
                         "url": url, "source": "Sample Source", "section": s["id"], "author": "",
                         "published": stamp, "summary": blurb, "full_html": None,
                         "license": "", "license_url": "", "words": len(blurb.split())})
        if s["id"] == "national-international":  # one sample full-text piece to show the reader view
            body = "<p>" + " ".join(["This sample article shows the distraction-free reader view."] * 30) + "</p>"
            arts[0].update(full_html=body, license="CC BY 4.0 (sample)",
                           license_url="https://creativecommons.org/licenses/by/4.0/",
                           words=len(html_to_text(body).split()))
        sections.append({"id": s["id"], "title": s["title"], "kicker": s.get("kicker", ""), "articles": arts})
    markets = [{"label": "S&P 500", "group": "Indices", "display": "0.00", "change_pct": None, "source": "sample"},
               {"label": "USD/INR", "group": "Currencies", "display": "0.00", "change_pct": None, "source": "sample"}]
    return assemble(cfg, now, sections, markets, medical_word_of_the_day(now.date()), None, [], is_sample=True)


# ---------------------------------------------------------------------------
# 8. Saving files
# ---------------------------------------------------------------------------
def write_outputs(edition: dict, out_dir: Path, retention_days: int) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    date = edition["edition"]["date"]
    payload = json.dumps(edition, ensure_ascii=False, indent=2)
    (out_dir / f"{date}.json").write_text(payload, encoding="utf-8")
    (out_dir / "latest.json").write_text(payload, encoding="utf-8")

    # A real edition replaces any demo (sample) files shipped with the repo.
    if not edition["edition"].get("is_sample"):
        for p in out_dir.glob("????-??-??.json"):
            try:
                if json.loads(p.read_text(encoding="utf-8")).get("edition", {}).get("is_sample"):
                    p.unlink()
            except (OSError, ValueError):
                pass

    # Prune old editions, then list the survivors for the date picker.
    dates = sorted((p.stem for p in out_dir.glob("????-??-??.json")), reverse=True)
    cutoff = (dt.date.fromisoformat(date) - dt.timedelta(days=retention_days)).isoformat()
    for d in [d for d in dates if d < cutoff]:
        (out_dir / f"{d}.json").unlink(missing_ok=True)
    dates = [d for d in dates if d >= cutoff]
    (out_dir / "index.json").write_text(json.dumps({"latest": date, "dates": dates}, indent=2), encoding="utf-8")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Build today's edition.")
    ap.add_argument("--config", type=Path, default=DEFAULT_CONFIG)
    ap.add_argument("--out", type=Path, default=DEFAULT_OUT)
    ap.add_argument("--sample", action="store_true", help="write offline demo data (no internet)")
    args = ap.parse_args(argv)

    cfg = json.loads(args.config.read_text(encoding="utf-8"))
    now = dt.datetime.now(ZoneInfo(cfg["edition"]["timezone"]))
    edition = build_sample(cfg, now) if args.sample else build_edition(cfg, now)

    total = edition["dashboard"]["total_articles"]
    if total == 0:
        print("ERROR: no articles were fetched; keeping the previous edition.", file=sys.stderr)
        return 1
    write_outputs(edition, args.out, cfg["limits"]["retention_days"])
    print(f"\nDone: {total} articles, ~{edition['dashboard']['reading_minutes']} min read, "
          f"{len(edition['errors'])} warning(s). Saved to {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
