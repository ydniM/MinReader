"""Fetches every feed in Feeds.json and writes the reader's data files.

GitHub Actions runs this every 15 minutes. It reads the posts saved by the
last run from the data folder (GitHub keeps that folder between runs), adds
any new posts, drops posts older than KEEP_DAYS, and writes:

  data/index.json         the feed list plus every post's title, date, snippet
  data/content/xx.json    the full post text, split into 256 small files by
                          the first two letters of each post's id, so opening
                          a post only downloads one small file.
"""

import calendar
import hashlib
import html
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from urllib.parse import urljoin, urlparse

import feedparser
import nh3
import requests

KEEP_DAYS = 30
MAX_POSTS_PER_FEED = 300
DATA = "data"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/131.0 Safari/537.36 MinReader/1.0"
)

# Tags and attributes kept in post text. Anything else (scripts, styles,
# forms, embeds) is removed, because the post is shown inside the reader.
ALLOWED_TAGS = {
    "a", "abbr", "b", "blockquote", "br", "caption", "cite", "code", "dd", "del",
    "details", "div", "dl", "dt", "em", "figcaption", "figure", "h1", "h2", "h3",
    "h4", "h5", "h6", "hr", "i", "img", "ins", "kbd", "li", "mark", "ol", "p",
    "picture", "pre", "q", "s", "small", "source", "span", "strong", "sub",
    "summary", "sup", "table", "tbody", "td", "tfoot", "th", "thead", "time",
    "tr", "u", "ul", "audio", "video",
}
ALLOWED_ATTRS = {
    "a": {"href", "title"},
    "img": {"src", "srcset", "alt", "title", "width", "height"},
    "source": {"src", "srcset", "type", "media"},
    "audio": {"src", "controls"},
    "video": {"src", "controls", "poster", "width", "height"},
    "td": {"colspan", "rowspan"},
    "th": {"colspan", "rowspan"},
    "abbr": {"title"},
    "time": {"datetime"},
}
URL_ATTRS = {"href", "src", "poster"}


def short_hash(text, length):
    return hashlib.sha1(text.encode("utf-8")).hexdigest()[:length]


def web_url(url, base=""):
    """Returns url as a full http(s) address, or "" for anything else
    (like javascript: links), since links and images are used on the page."""
    full = urljoin(base, (url or "").strip())
    return full if urlparse(full).scheme in ("http", "https") else ""


def feed_id(url):
    return short_hash(url.strip(), 8)


def plain_text(fragment):
    """The text of an HTML fragment, without tags."""
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", " ", fragment or "", flags=re.S | re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    return re.sub(r"\s+", " ", html.unescape(text)).strip()


def text_of(value, detail):
    """A title or name as plain text. Feeds mark plain text titles as
    text/plain, and those can hold a real "<" (like "a < b"), so only HTML
    titles have tags taken out."""
    if (detail or {}).get("type") == "text/plain":
        return re.sub(r"\s+", " ", value or "").strip()
    return plain_text(value)


def parse(content, content_type=""):
    # feedparser's own cleaning drops srcset, so some images would go missing.
    # clean_html cleans every post instead.
    return feedparser.parse(content, response_headers={"content-type": content_type}, sanitize_html=False)


def clean_html(fragment, base_url):
    """Sanitizes post HTML and turns relative links and images into full URLs."""

    def fix_attr(tag, attr, value):
        if attr in URL_ATTRS:
            return urljoin(base_url, value.strip()) if value else None  # nh3 then drops unsafe schemes
        if attr == "srcset":
            parts = []
            for item in value.split(","):
                bits = item.strip().split(None, 1)
                if bits:
                    bits[0] = web_url(bits[0], base_url)
                    if bits[0]:
                        parts.append(" ".join(bits))
            return ", ".join(parts)
        return value

    return nh3.clean(
        fragment or "",
        tags=ALLOWED_TAGS,
        attributes=ALLOWED_ATTRS,
        url_schemes={"http", "https", "mailto"},
        attribute_filter=fix_attr,
        link_rel="noopener noreferrer",
        strip_comments=True,
    ).strip()


def entry_time(entry):
    for key in ("published_parsed", "updated_parsed", "created_parsed"):
        value = entry.get(key)
        if value:
            try:
                return int(calendar.timegm(value))
            except (OverflowError, ValueError):
                pass
    return None


def entry_image(entry, content, base_url):
    for thumb in entry.get("media_thumbnail") or []:
        if web_url(thumb.get("url"), base_url):
            return web_url(thumb["url"], base_url)
    for media in entry.get("media_content") or []:
        kind = media.get("type", "") or media.get("medium", "")
        if web_url(media.get("url"), base_url) and ("image" in kind or re.search(r"\.(jpe?g|png|webp|gif)(\?|$)", media["url"], re.I)):
            return web_url(media["url"], base_url)
    for link in entry.get("links") or []:
        if link.get("rel") == "enclosure" and link.get("type", "").startswith("image") and web_url(link.get("href"), base_url):
            return web_url(link["href"], base_url)
    for match in re.finditer(r"<img\b[^>]*>", content or "", re.I):
        tag = match.group(0)
        if re.search(r"""\b(width|height)=["']?1["'\s/>]""", tag):
            continue  # tracking pixel
        src = re.search(r"""\bsrc=["']([^"']+)["']""", tag)
        if src and web_url(html.unescape(src.group(1)), base_url):
            return web_url(html.unescape(src.group(1)), base_url)
    return ""


def entry_content(entry):
    best = ""
    for item in entry.get("content") or []:
        value = item.get("value") or ""
        if len(value) > len(best):
            best = value
    summary = entry.get("summary") or ""
    return best if len(plain_text(best)) >= len(plain_text(summary)) else summary


def find_feed_link(page_html, page_url):
    """Looks for the feed address a website advertises in its <head>."""
    for tag in re.findall(r"<link\b[^>]*>", page_html, re.I):
        if re.search(r"""rel=["']?alternate""", tag, re.I) and re.search(
            r"""type=["']?application/(rss|atom)\+xml""", tag, re.I
        ):
            href = re.search(r"""href=["']([^"']+)["']""", tag, re.I)
            if href:
                return urljoin(page_url, html.unescape(href.group(1)))
    return None


def download(url):
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, "Accept": "application/rss+xml, application/atom+xml, application/xml, text/xml, */*"},
        timeout=30,
    )
    response.raise_for_status()
    return response


def fetch_feed(feed):
    """Returns (parsed feed, error message). Tries a website's advertised feed
    if the address turns out to be a normal web page, and old.reddit.com if
    Reddit refuses the request."""
    url = feed["url"]
    try:
        try:
            response = download(url)
        except requests.HTTPError as error:
            host = urlparse(url).hostname or ""
            if host.endswith("reddit.com") and error.response is not None and error.response.status_code in (403, 429):
                response = download(re.sub(r"//(www\.)?reddit\.com", "//old.reddit.com", url, count=1))
            else:
                raise
        parsed = parse(response.content, response.headers.get("content-type", ""))
        if not parsed.entries and not parsed.feed.get("title"):
            found = find_feed_link(response.text, response.url)
            if not found:
                # Names the page, since a site that blocks automatic checks sends
                # a bot check page instead of its feed.
                title = re.search(r"<title[^>]*>(.*?)</title>", response.text, re.I | re.S)
                title = plain_text(title.group(1))[:80] if title else ""
                named = f' (“{title}”)' if title else ""
                return None, (f"The website sent a web page{named} instead of a feed. If the address works in your "
                              "browser, the website is probably blocking automatic checks like GitHub’s.")
            found_response = download(found)
            parsed = parse(found_response.content, found_response.headers.get("content-type", ""))
        if parsed.bozo and not parsed.entries:
            return None, "The feed couldn't be read (it isn't valid RSS or Atom)."
        return parsed, None
    except requests.HTTPError as error:
        code = error.response.status_code if error.response is not None else "?"
        return None, f"The website answered with error {code}."
    except requests.Timeout:
        return None, "The website took too long to answer."
    except requests.RequestException as error:
        return None, f"The website couldn't be reached ({type(error).__name__})."


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except (OSError, ValueError):
        return default


def load_previous():
    """Loads last run's posts and text. Falls back to the live site if GitHub
    didn't keep the data folder (that's rare, but it can happen)."""
    index = load_json(os.path.join(DATA, "index.json"), None)
    content = {}
    if index is not None:
        for name in os.listdir(os.path.join(DATA, "content")) if os.path.isdir(os.path.join(DATA, "content")) else []:
            content.update(load_json(os.path.join(DATA, "content", name), {}))
        return index, content

    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if "/" not in repo:
        return {"feeds": [], "posts": []}, {}
    owner, name = repo.split("/", 1)
    base = f"https://{owner.lower()}.github.io/{name}/data/"
    print(f"No saved data from the last run, so loading it from {base}")
    try:
        index = requests.get(base + "index.json", timeout=30).json()
    except (requests.RequestException, ValueError):
        return {"feeds": [], "posts": []}, {}

    def get_shard(prefix):
        try:
            return requests.get(f"{base}content/{prefix}.json", timeout=30).json()
        except (requests.RequestException, ValueError):
            return {}

    prefixes = sorted({post["id"][:2] for post in index.get("posts", [])})
    with ThreadPoolExecutor(16) as pool:
        for shard in pool.map(get_shard, prefixes):
            content.update(shard)
    return index, content


def main():
    feeds = load_json("Feeds.json", {}).get("feeds", [])
    previous, content = load_previous()
    previous_feeds = {f["id"]: f for f in previous.get("feeds", [])}
    previous_posts = {}
    for post in previous.get("posts", []):
        previous_posts.setdefault(post["feed"], {})[post["id"]] = post

    now = int(time.time())
    cutoff = now - KEEP_DAYS * 86400

    with ThreadPoolExecutor(8) as pool:
        results = list(pool.map(fetch_feed, feeds))

    out_feeds, out_posts, out_content = [], [], {}
    for feed, (parsed, error) in zip(feeds, results):
        # A feed whose address was edited keeps its old id, so read marks still match.
        fid = feed.get("id") or feed_id(feed["url"])
        old = previous_feeds.get(fid, {})
        posts = dict(previous_posts.get(fid, {}))
        info = {
            "id": fid,
            "title": feed.get("title") or old.get("title") or feed["url"],
            "url": feed["url"],
            "site": web_url(old.get("site")),
            "error": error or "",
            "lastSuccess": old.get("lastSuccess", 0),
        }
        if parsed is not None:
            info["lastSuccess"] = now
            info["site"] = web_url(parsed.feed.get("link"), feed["url"]) or info["site"] or feed["url"]
            if not feed.get("title") and parsed.feed.get("title"):
                info["title"] = text_of(parsed.feed["title"], parsed.feed.get("title_detail"))
            for entry in parsed.entries:
                link = web_url(entry.get("link"), info["site"])
                guid = entry.get("id") or link or (entry.get("title", "") + str(entry_time(entry)))
                pid = short_hash(fid + "|" + guid, 14)
                raw = entry_content(entry)
                base = link or info["site"]
                when = entry_time(entry)
                if when is None or when > now + 3600:
                    when = posts.get(pid, {}).get("date", now)
                body = clean_html(raw, base)
                image = entry_image(entry, raw, base)
                if image and "<img" not in body:
                    body = f'<p><img src="{html.escape(image)}" alt=""></p>' + body
                posts[pid] = {
                    "id": pid,
                    "feed": fid,
                    "title": text_of(entry.get("title", ""), entry.get("title_detail")) or "(No title)",
                    "link": link,
                    "author": plain_text(entry.get("author", "")),
                    "date": when,
                    "summary": plain_text(raw)[:240],
                    "image": image,
                }
                content[pid] = body
        else:
            print(f"Problem with {info['title']}: {error}")

        kept = sorted((p for p in posts.values() if p["date"] >= cutoff), key=lambda p: -p["date"])
        kept = kept[:MAX_POSTS_PER_FEED]
        for post in kept:
            post["link"] = web_url(post.get("link"))  # also cleans posts saved before links were checked
            post["image"] = web_url(post.get("image"))
            out_posts.append(post)
            out_content[post["id"]] = content.get(post["id"], "")
        out_feeds.append(info)

    out_posts.sort(key=lambda p: -p["date"])

    os.makedirs(os.path.join(DATA, "content"), exist_ok=True)
    for name in os.listdir(os.path.join(DATA, "content")):
        os.remove(os.path.join(DATA, "content", name))
    shards = {}
    for pid, body in out_content.items():
        shards.setdefault(pid[:2], {})[pid] = body
    for prefix, shard in shards.items():
        with open(os.path.join(DATA, "content", prefix + ".json"), "w", encoding="utf-8") as handle:
            json.dump(shard, handle, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(DATA, "index.json"), "w", encoding="utf-8") as handle:
        json.dump({"updated": now, "feeds": out_feeds, "posts": out_posts}, handle, ensure_ascii=False, separators=(",", ":"))

    problems = sum(1 for f in out_feeds if f["error"])
    print(f"Saved {len(out_posts)} posts from {len(out_feeds)} feeds ({problems} with problems).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
