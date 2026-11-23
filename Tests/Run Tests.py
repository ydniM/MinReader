"""End-to-end tests for MinReader. Needs Python with feedparser, nh3, requests
and playwright, plus Chrome.

  python "Tests/Run Tests.py"            run everything
  python "Tests/Run Tests.py" phone      run only tests whose name contains "phone"

It builds a test copy of the site in a temporary folder (the same files the
workflow publishes), writes fake feeds (including harmful ones), runs
Fetch Feeds.py on them, starts Test Server.py, and drives Chrome at desktop
size and at 412px phone width. Screenshots go to Tests/Screenshots.
"""

import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
import urllib.request
from email.utils import formatdate

from playwright.sync_api import sync_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.dirname(HERE)
SHOTS = os.path.join(HERE, "Screenshots")
ONLY = sys.argv[1] if len(sys.argv) > 1 else ""
CHROME = shutil.which("google-chrome") or shutil.which("chrome") or None


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


PORT = free_port()
ORIGIN = f"http://127.0.0.1:{PORT}"
SITE_URL = ORIGIN + "/MinReader/"

# ---------- Fake feeds ----------

def rss(title, link, items):
    body = "".join(items)
    return f'<?xml version="1.0"?><rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>{title}</title><link>{link}</link>{body}</channel></rss>'


def item(title, link, hours_ago, html="", guid=None, extra=""):
    date = formatdate(time.time() - hours_ago * 3600)
    return (f"<item><title>{title}</title><link>{link}</link><guid>{guid or link}</guid><pubDate>{date}</pubDate>"
            f"<description><![CDATA[{html}]]></description>{extra}</item>")


def write_feeds(folder):
    os.makedirs(folder)
    cozy = [item(f"Cozy post {n}", f"https://cozy.example/post-{n}", n,
                 f'<p>Cozy text {n}. <a href="/relative-{n}">relative link</a></p><img src="{ORIGIN}/feeds/Photo.png?{n}">')
            for n in range(1, 6)]
    files = {
        "Cozy.xml": rss("Cozy Blog", "https://cozy.example/", cozy),
        "Garden.xml": rss("Garden Notes", "https://garden.example/", [
            item(f"Garden post {n}", f"https://garden.example/g{n}", 10 + n, f"<p>Garden text {n}</p>") for n in range(1, 4)]),
        "Big.xml": rss("Big Feed", "https://big.example/", [
            item(f"Big post {n}", f"https://big.example/b{n}", 20 + n / 10, f"<p>Big {n}</p>") for n in range(1, 151)]),
        "Evil.xml": rss("Evil Feed", "javascript:alert(1)", [
            item("Evil script post", "javascript:alert(document.cookie)", 2,
                 '<p onclick="alert(1)">Hi<script>alert(1)</script></p><a href="javascript:alert(2)">bad link</a>'
                 '<img src="javascript:alert(3)"><iframe src="https://evil.example"></iframe><style>body{display:none}</style>'
                 '<img srcset="javascript:alert(4) 1x, https://ok.example/a.jpg 2x">',
                 guid="evil-1",
                 extra='<media:thumbnail url="javascript:alert(5)"/><enclosure url="javascript:alert(6)" type="image/jpeg"/>'),
            item("Math: a &lt; b and c &gt; d", "https://evil.example/math", 3, "<p>Less than and more than.</p>", guid="evil-2"),
        ]),
        "Page.html": '<html><head><link rel="alternate" type="application/rss+xml" href="Garden2.xml"></head><body>Hi</body></html>',
        "Garden2.xml": rss("Found Through Page", "https://found.example/", [item("Found post", "https://found.example/1", 5, "<p>Found</p>")]),
    }
    for name, text in files.items():
        with open(os.path.join(folder, name), "w", encoding="utf-8") as handle:
            handle.write(text)
    # A small striped photo for thumbnails, served locally.
    from PIL import Image
    photo = Image.new("RGB", (120, 120))
    for x in range(120):
        for y in range(120):
            photo.putpixel((x, y), (60 + x, 90 + (y // 20) * 25, 200 - x))
    photo.save(os.path.join(folder, "Photo.png"))


def published_files():
    """The files the workflow copies into the site, read from its cp line."""
    with open(os.path.join(REPO, ".github", "workflows", "Update Feeds.yml"), encoding="utf-8") as handle:
        for line in handle:
            line = line.strip()
            if line.startswith("cp ") and "site/" in line and "-r" not in line:
                return [p for p in shlex.split(line)[1:] if p != "site/"]
    raise SystemExit("Couldn't find the workflow's cp line")


def build_site():
    site = tempfile.mkdtemp(prefix="minreader-site-")
    for name in published_files():
        shutil.copy(os.path.join(REPO, name), site)
    write_feeds(os.path.join(site, "_feeds"))
    feeds = [{"title": "", "url": f"{ORIGIN}/feeds/{n}"} for n in ("Cozy.xml", "Garden.xml", "Big.xml", "Evil.xml", "Page.html")]
    feeds.append({"title": "Broken Feed", "url": f"{ORIGIN}/feeds/Missing.xml"})
    with open(os.path.join(site, "Feeds.json"), "w", encoding="utf-8") as handle:
        json.dump({"feeds": feeds}, handle, indent=2)
    return site


# ---------- Test helpers ----------

results = []


def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))
    print(("  PASS  " if ok else "  FAIL  ") + name + ("" if ok else f"  ({detail})"), flush=True)


def api(path, data=None):
    req = urllib.request.Request(ORIGIN + "/_test/" + path, method="POST" if data is not None else "GET",
                                 data=json.dumps(data).encode() if data is not None else None)
    with urllib.request.urlopen(req) as res:
        return json.loads(res.read() or b"{}")


def remote_state():
    text = api("files").get("State.json")
    return json.loads(text) if text else {}


def wait_for(fn, timeout=12, every=0.25):
    end = time.time() + timeout
    while time.time() < end:
        try:
            value = fn()
            if value:
                return value
        except Exception:
            pass
        time.sleep(every)
    return fn()


INIT = """(() => {
  if (window.top !== window.self) return; // post frames are sandboxed and can't use localStorage
  if (!localStorage.getItem('reader-dev')) {
    localStorage.setItem('reader-dev', JSON.stringify({ owner: 'me', repo: 'MinReader', api: location.origin + '/api' }));
    const key = %s;
    if (key) localStorage.setItem('reader-token', key);
  }
})();"""


def new_context(browser, phone=False, key="good-key"):
    opts = dict(viewport={"width": 412, "height": 915}, device_scale_factor=2.625, is_mobile=True, has_touch=True) if phone \
        else dict(viewport={"width": 1400, "height": 900})
    ctx = browser.new_context(**opts)
    ctx.add_init_script(INIT % json.dumps(key))
    # Only the local server is reachable, like the real workspace (fonts and favicons fail quickly).
    ctx.route(re.compile(r"^https?://(?!127\.0\.0\.1)"), lambda route: route.abort())
    return ctx


def open_page(ctx, path=""):
    page = ctx.new_page()
    page.errors = []
    page.on("pageerror", lambda e: page.errors.append(str(e)))
    page.goto(SITE_URL + path)
    page.wait_for_selector(".post")
    return page


def row(page, title):
    return page.locator(".post", has=page.locator(".t", has_text=title)).first


def shot(page, name):
    os.makedirs(SHOTS, exist_ok=True)
    page.screenshot(path=os.path.join(SHOTS, name + ".png"))


def post_id(page, title):
    return row(page, title).get_attribute("data-id")


def touch_hold(page, locator, ms=650):
    box = locator.bounding_box()
    x, y = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    cdp = page.context.new_cdp_session(page)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": [{"x": x, "y": y}]})
    page.wait_for_timeout(ms)
    cdp.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    cdp.detach()


# ---------- Python (Fetch Feeds.py) ----------

def test_python_build(site):
    data = json.load(open(os.path.join(site, "data", "index.json"), encoding="utf-8"))
    content = {}
    for name in os.listdir(os.path.join(site, "data", "content")):
        content.update(json.load(open(os.path.join(site, "data", "content", name), encoding="utf-8")))
    everything = json.dumps(data) + json.dumps(content)
    feeds = {f["title"]: f for f in data["feeds"]}
    check("python: every feed is listed", len(data["feeds"]) == 6, [f["title"] for f in data["feeds"]])
    check("python: no javascript: anywhere in the data", "javascript:" not in everything.lower())
    check("python: scripts, styles, iframes and event handlers are removed",
          not re.search(r"<script|<style|<iframe|onclick", everything, re.I))
    evil = next(p for p in data["posts"] if p["title"] == "Evil script post")
    check("python: harmful post link and image are dropped", evil["link"] == "" and evil["image"] == "", evil)
    check("python: harmful feed website falls back to the feed address", feeds["Evil Feed"]["site"].startswith(ORIGIN), feeds["Evil Feed"]["site"])
    check("python: srcset keeps only the web address", "https://ok.example/a.jpg 2x" in content[evil["id"]], content[evil["id"]])
    cozy = next(p for p in data["posts"] if p["title"] == "Cozy post 1")
    check("python: relative links become full addresses", "https://cozy.example/relative-1" in content[cozy["id"]])
    check("python: the feed image becomes the thumbnail", cozy["image"] == f"{ORIGIN}/feeds/Photo.png?1", cozy["image"])
    check("python: a title with < and > keeps its text", any(p["title"] == "Math: a < b and c > d" for p in data["posts"]),
          [p["title"] for p in data["posts"] if p["title"].startswith("Math")])
    check("python: a web page's advertised feed is found", "Found Through Page" in feeds)
    check("python: a missing feed shows an error", feeds["Broken Feed"]["error"].startswith("The website answered with error 404"), feeds["Broken Feed"]["error"])
    check("python: 150 posts kept from the big feed", sum(1 for p in data["posts"] if p["feed"] == feeds["Big Feed"]["id"]) == 150)


def test_python_rerun(site):
    """A second run keeps posts that dropped off a feed and keeps edited feed ids."""
    feeds_file = os.path.join(site, "Feeds.json")
    before = json.load(open(os.path.join(site, "data", "index.json"), encoding="utf-8"))
    garden = next(f for f in before["feeds"] if f["title"] == "Garden Notes")
    saved = open(feeds_file, encoding="utf-8").read()
    feeds = json.loads(saved)
    for f in feeds["feeds"]:
        if f["url"].endswith("Garden.xml"):
            f["id"], f["url"] = garden["id"], f"{ORIGIN}/feeds/Missing2.xml"
    json.dump(feeds, open(feeds_file, "w", encoding="utf-8"))
    subprocess.run([sys.executable, "-I", os.path.join(REPO, "Fetch Feeds.py")], cwd=site, check=True, capture_output=True)
    after = json.load(open(os.path.join(site, "data", "index.json"), encoding="utf-8"))
    kept = [p for p in after["posts"] if p["feed"] == garden["id"]]
    check("python: an edited feed keeps its id and its saved posts", len(kept) == 3, len(kept))
    open(feeds_file, "w", encoding="utf-8").write(saved)
    subprocess.run([sys.executable, "-I", os.path.join(REPO, "Fetch Feeds.py")], cwd=site, check=True, capture_output=True)


# ---------- Desktop ----------

def test_desktop_basics(browser):
    ctx = new_context(browser)
    page = open_page(ctx)
    check("desktop: tab title shows the unread count", re.fullmatch(r"\(\d+\) MinReader", page.title()), page.title())
    check("desktop: CSP is present", page.locator('meta[http-equiv="Content-Security-Policy"]').count() == 1)
    hrefs = page.evaluate("[...document.querySelectorAll('[href],[src]')].map(e => e.getAttribute('href') || e.getAttribute('src'))")
    check("desktop: no javascript: links on the page", not any(h and h.lower().startswith("javascript") for h in hrefs))
    check("desktop: Broken Feed shows a warning", page.locator('.feed-item:has-text("Broken Feed") .warn-dot').count() == 1)
    row(page, "Evil script post").click()
    check("desktop: Open original is off for a post with a harmful link", page.locator("#openBtn").get_attribute("aria-disabled") == "true")
    frame = page.locator("#readerFrame")
    check("desktop: post frame has no scripts allowed", "allow-scripts" not in (frame.get_attribute("sandbox") or "") and "allow-same-origin" not in (frame.get_attribute("sandbox") or ""))
    body = page.frame_locator("#readerFrame").locator("article").inner_html()
    check("desktop: post frame has no script or javascript:", "<script" not in body and "javascript:" not in body.lower())
    page.frame_locator("#readerFrame").locator("text=Hi").wait_for()
    page.wait_for_timeout(300)
    row(page, "Cozy post 1").hover()
    shot(page, "Desktop")
    check("desktop: no page errors", not page.errors, page.errors)
    ctx.close()


def test_desktop_open_and_save(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    pid = post_id(page, "Cozy post 2")
    row(page, "Cozy post 2").click()
    check("desktop: opening a post marks it read", page.evaluate(f"isRead('{pid}')"))
    check("desktop: post text shows in the frame", wait_for(lambda: page.frame_locator("#readerFrame").locator("text=Cozy text 2").count() == 1, 5))
    check("desktop: shows Saving… right after a change", "Saving" in page.locator("#syncStatus").inner_text())
    ok = wait_for(lambda: pid in remote_state().get("read", {}))
    check("desktop: read mark is saved to State.json", ok)
    wait_for(lambda: "All changes saved" in page.locator("#syncStatus").inner_text(), 5)
    check("desktop: shows All changes saved afterwards", "All changes saved" in page.locator("#syncStatus").inner_text())
    ctx.close()


def test_desktop_conflict_merge(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    a, b = post_id(page, "Garden post 1"), post_id(page, "Garden post 2")
    row(page, "Garden post 1").click()
    # Another device saves its own read mark first.
    api("set", {"path": "State.json", "text": json.dumps({"read": {b: 1}, "bookmarks": {}})})
    api("fail", {"statuses": [409]})
    ok = wait_for(lambda: a in remote_state().get("read", {}) and b in remote_state().get("read", {}))
    check("desktop: a save after a conflict keeps both devices' changes", ok, remote_state())
    check("desktop: the other device's read mark shows here too", wait_for(lambda: page.evaluate(f"isRead('{b}')"), 5))
    check("desktop: no false Couldn't save after a conflict", "Couldn" not in page.locator("#syncStatus").inner_text())
    ctx.close()


def test_desktop_save_errors(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    api("fail", {"statuses": [500]})
    row(page, "Cozy post 3").click()
    ok = wait_for(lambda: "Couldn’t save" in page.locator("#syncStatus").inner_text())
    check("desktop: a server error shows Couldn't save", ok, page.locator("#syncStatus").inner_text())
    page.evaluate("saveNow()")
    pid = post_id(page, "Cozy post 3")
    check("desktop: the retry saves it", wait_for(lambda: pid in remote_state().get("read", {})))
    ctx.close()
    ctx = new_context(browser, key="bad-key")
    page = open_page(ctx)
    check("desktop: a bad key shows The access key isn't working",
          wait_for(lambda: "isn’t working" in page.locator("#syncStatus").inner_text(), 5), page.locator("#syncStatus").inner_text())
    ctx.close()


def test_desktop_unread_rules(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    page.click('[data-view="unread"]')
    row(page, "Cozy post 4").click()
    check("desktop: a post opened in Unread stays listed", row(page, "Cozy post 4").count() == 1)
    row(page, "Cozy post 5").click()
    check("desktop: it still stays after opening another", row(page, "Cozy post 4").count() == 1)
    page.click('[data-view="all"]')
    page.click('[data-view="unread"]')
    check("desktop: opened posts leave Unread after going to another list", row(page, "Cozy post 4").count() == 0 and row(page, "Cozy post 5").count() == 0)
    thumb_row = row(page, "Cozy post 1")
    height = thumb_row.bounding_box()["height"]
    thumb_row.hover()
    acts, thumb = thumb_row.locator(".post-actions").bounding_box(), thumb_row.locator(".thumb").bounding_box()
    check("desktop: hover buttons don't change the post's height", abs(thumb_row.bounding_box()["height"] - height) < 0.5, (height, thumb_row.bounding_box()["height"]))
    check("desktop: hover buttons sit below the photo", acts["y"] >= thumb["y"] + thumb["height"], (acts, thumb))
    check("desktop: hover buttons have no box around them",
          thumb_row.locator(".post-actions").evaluate("e => getComputedStyle(e).backgroundColor === 'rgba(0, 0, 0, 0)' && getComputedStyle(e).boxShadow === 'none'"))
    r = row(page, "Garden post 3")
    r.hover()
    r.locator('[data-act="read"]').click()
    check("desktop: the check button removes the post right away", row(page, "Garden post 3").count() == 0)
    check("desktop: with an Undo toast", page.locator("#toastUndo").is_visible())
    page.click("#toastUndo")
    check("desktop: Undo puts it back", row(page, "Garden post 3").count() == 1)
    before = page.evaluate("unreadCounts().get('')")
    page.click("#markAllBtn")
    check("desktop: Mark all as read empties Unread", page.locator(".post").count() == 0 and "caught up" in page.locator("#postsEmpty").inner_text())
    check("desktop: tab title drops the count", page.title() == "MinReader", page.title())
    page.click("#toastUndo")
    check("desktop: Undo of Mark all as read brings them back", page.evaluate("unreadCounts().get('')") == before)
    ctx.close()


def test_desktop_bookmarks(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    pid = post_id(page, "Cozy post 1")
    row(page, "Cozy post 1").click()
    page.dblclick("#bookmarkBtn")
    page.wait_for_timeout(300)
    ops = page.evaluate("JSON.parse(localStorage.getItem('reader-pending')).filter(o => o.op === 'bookmark' || o.op === 'unbookmark').map(o => o.op)")
    check("desktop: a double click adds one bookmark and removes it once", ops in (["bookmark"], ["bookmark", "unbookmark"]), ops)
    if ops == ["bookmark", "unbookmark"]:
        page.click("#bookmarkBtn")
    check("desktop: Bookmarked label", "Bookmarked" in page.locator("#bookmarkBtn").inner_text())
    ok = wait_for(lambda: f"Bookmarks/{pid}.html" in api("files") and pid in remote_state().get("bookmarks", {}))
    check("desktop: bookmark text is saved to Bookmarks/", ok)
    check("desktop: saved text is the post", "Cozy text 1" in api("files").get(f"Bookmarks/{pid}.html", ""))
    page.click('[data-view="bookmarks"]')
    check("desktop: Bookmarks lists it", row(page, "Cozy post 1").count() == 1 and page.locator('[data-count="bookmarks"]').inner_text() == "1")
    wait_for(lambda: not page.evaluate("pending.length"), 8)
    page.click("#bookmarkBtn")
    check("desktop: removing it leaves the list", row(page, "Cozy post 1").count() == 0)
    page.click("#toastUndo")
    check("desktop: Undo puts it back", wait_for(lambda: row(page, "Cozy post 1").count() == 1, 4))
    ok = wait_for(lambda: not page.evaluate("pending.length") and f"Bookmarks/{pid}.html" in api("files"))
    check("desktop: after Undo the saved text is still there", ok and "Cozy text 1" in api("files").get(f"Bookmarks/{pid}.html", ""))
    check("desktop: nobody calls them starred", "starred" not in page.content().lower())
    ctx.close()


def test_desktop_sorting(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    names = lambda: page.eval_on_selector_all("#feedList .nm", "els => els.map(e => e.textContent)")
    start = names()
    check("desktop: feeds start A to Z", start == sorted(start, key=str.lower), start)
    first = page.locator("#feedList li").nth(0)
    third = page.locator("#feedList li").nth(2)
    a, c = first.bounding_box(), third.bounding_box()
    page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2)
    page.mouse.down()
    for step in range(1, 16):
        page.mouse.move(a["x"] + 60, a["y"] + a["height"] / 2 + (c["y"] - a["y"] + 10) * step / 15)
        page.wait_for_timeout(16)
    page.mouse.up()
    moved = names()
    check("desktop: dragging a feed moves it", moved[2] == start[0], moved)
    check("desktop: dragging switches to Custom", page.evaluate("state.feedSort") == "custom")
    check("desktop: a drag doesn't open the feed", page.evaluate("view") == "all")
    ok = wait_for(lambda: remote_state().get("feedSort") == "custom" and len(remote_state().get("feedOrder", [])) == 6)
    check("desktop: custom order is saved", ok, remote_state().get("feedOrder"))
    page.click("#sortBtn")
    page.click('.dir[data-sort="za"]')
    check("desktop: sort menu stays open after picking", page.locator("#menu").is_visible())
    check("desktop: Name Z to A sorts the feeds", names() == sorted(start, key=str.lower, reverse=True), names())
    page.keyboard.press("Escape")
    ctx.close()


def test_desktop_feed_editing(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    page.click("#addFeedBtn")
    page.fill("#feedUrl", "example.org/feed")
    page.click("#modalActions .primary")
    page.wait_for_selector("#modal.show", state="detached")
    feeds = json.loads(api("files")["Feeds.json"])["feeds"]
    check("desktop: Add feed writes Feeds.json", any(f["url"] == "https://example.org/feed" for f in feeds))
    check("desktop: the new feed shows as adding…", page.locator('#feedList .count:has-text("adding")').count() == 1)
    page.click("#addFeedBtn")
    page.fill("#feedUrl", "https://example.org/feed")
    page.press("#feedUrl", "Enter")
    check("desktop: adding it again says it's already listed", wait_for(lambda: "already" in page.locator("#feedError").inner_text(), 4))
    page.keyboard.press("Escape")
    page.click('.feed-item:has-text("Garden Notes")')
    page.click("#moreFeedBtn")
    page.click('.menu-item:has-text("Rename")')
    page.fill("#editName", "My Garden")
    page.click("#modalActions .primary")
    page.wait_for_selector("#modal.show", state="detached")
    check("desktop: rename shows right away", page.locator("#viewTitle").inner_text() == "My Garden")
    feeds = json.loads(api("files")["Feeds.json"])["feeds"]
    check("desktop: rename is written to Feeds.json", any(f["title"] == "My Garden" for f in feeds))
    page.click("#moreFeedBtn")
    page.click('.menu-item:has-text("Remove feed")')
    page.click("#modalActions .danger")
    page.wait_for_selector("#modal.show", state="detached")
    feeds = json.loads(api("files")["Feeds.json"])["feeds"]
    check("desktop: Remove feed takes it out of Feeds.json", not any(f["url"].endswith("Garden.xml") for f in feeds))
    check("desktop: and out of the list", page.locator('.feed-item:has-text("My Garden")').count() == 0 and page.evaluate("view") == "all")
    ctx.close()


def test_desktop_keyboard(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    page.click('[data-view="all"]')
    first = page.locator(".post").first
    check("desktop: post rows can take keyboard focus", first.get_attribute("tabindex") == "0")
    first.focus()
    page.keyboard.press("ArrowDown")
    second_id = page.locator(".post").nth(1).get_attribute("data-id")
    check("desktop: Down arrow moves to the next post", page.evaluate("document.activeElement.dataset.id") == second_id)
    page.keyboard.press("Enter")
    check("desktop: Enter opens the focused post", page.evaluate("current && current.id") == second_id)
    check("desktop: quick actions show for the focused post", page.locator(".post").nth(1).locator(".post-actions").is_visible())
    page.keyboard.press("Space")
    check("desktop: Space on a post doesn't scroll away or break", page.evaluate("current && current.id") == second_id)
    page.locator(".post").nth(1).focus()
    page.keyboard.press("Shift+F10")
    check("desktop: the menu key opens the post menu", page.locator("#menu").is_visible())
    check("desktop: and focuses its first item", page.evaluate("document.activeElement.classList.contains('menu-item')"))
    page.keyboard.press("ArrowDown")
    check("desktop: arrows move through the menu", page.evaluate("document.activeElement === document.querySelectorAll('#menu .menu-item')[1]"))
    page.keyboard.press("Escape")
    check("desktop: Escape closes the menu and returns focus", not page.locator("#menu").is_visible() and page.evaluate("document.activeElement.dataset.id") == second_id)
    page.focus('.feed-item:has-text("Cozy Blog")')
    page.keyboard.press("Shift+F10")
    check("desktop: the menu key opens a feed's menu", page.locator('#menu .menu-item:has-text("Rename")').is_visible())
    page.keyboard.press("Escape")
    page.keyboard.press("Tab")
    check("desktop: Tab goes from feed to feed", page.evaluate("document.activeElement.classList.contains('feed-item')"))
    page.click("#addFeedBtn")
    page.wait_for_timeout(120)
    check("desktop: a dialog keeps focus inside it", page.evaluate("document.querySelector('#layout').inert"))
    page.keyboard.press("Escape")
    check("desktop: closing the dialog gives focus back", page.evaluate("document.activeElement.id") == "addFeedBtn" and not page.evaluate("document.querySelector('#layout').inert"))
    ctx.close()


def test_desktop_two_tabs(browser):
    api("reset", {})
    ctx = new_context(browser)
    offline = lambda route: route.abort()
    a = open_page(ctx)
    b = open_page(ctx)
    for p in (a, b):
        p.route("**/api/**", offline)
    id1, id2 = post_id(a, "Cozy post 1"), post_id(b, "Cozy post 2")
    row(a, "Cozy post 1").click()
    row(b, "Cozy post 2").click()
    a.wait_for_timeout(300)
    stored = a.evaluate("JSON.parse(localStorage.getItem('reader-pending')).flatMap(o => o.ids || [])")
    check("desktop: two tabs both keep their queued changes", id1 in stored and id2 in stored, stored)
    check("desktop: each tab shows the other tab's change", wait_for(lambda: a.evaluate(f"isRead('{id2}')") and b.evaluate(f"isRead('{id1}')"), 4))
    a.close()
    b.close()
    c = open_page(ctx)
    ok = wait_for(lambda: id1 in remote_state().get("read", {}) and id2 in remote_state().get("read", {}))
    check("desktop: a later tab saves both", ok, remote_state().get("read"))
    ctx.close()


def test_desktop_misc(browser):
    api("reset", {})
    ctx = new_context(browser)
    page = open_page(ctx)
    page.click('.feed-item:has-text("Big Feed")')
    check("desktop: long lists draw 100 posts at first", page.locator(".post").count() == 100)
    page.locator("#postScroll").evaluate("el => el.scrollTop = el.scrollHeight")
    check("desktop: and more while scrolling", wait_for(lambda: page.locator(".post").count() == 150, 4))
    # Column widths
    g = page.locator('.gutter[data-col="w1"]').bounding_box()
    page.mouse.move(g["x"] + 5, g["y"] + 200)
    page.mouse.down()
    page.mouse.move(g["x"] + 85, g["y"] + 200, steps=5)
    page.mouse.up()
    w = page.evaluate("JSON.parse(localStorage.getItem('reader-widths')).w1")
    check("desktop: dragging the gap saves a wider feed column", w and w > 300, w)
    page.set_viewport_size({"width": 1000, "height": 800})
    page.wait_for_timeout(100)
    read_w = page.locator(".read-col").bounding_box()["width"]
    check("desktop: saved widths shrink to fit a smaller window", read_w >= 378, read_w)
    page.set_viewport_size({"width": 1400, "height": 900})
    page.dblclick('.gutter[data-col="w1"]')
    check("desktop: double-click resets widths", page.evaluate("localStorage.getItem('reader-widths')") == "{}")
    # A big State.json still loads.
    pid = post_id(page, "Big post 1")
    big = {"read": {pid: 1, **{f"x{n:07d}": 1 for n in range(70000)}}, "bookmarks": {}}
    api("set", {"path": "State.json", "text": json.dumps(big)})
    page.evaluate("loadState()")
    check("desktop: State.json over 1 MB still loads", wait_for(lambda: page.evaluate(f"isRead('{pid}')"), 5))
    ctx.close()
    # Refuses to run inside a frame.
    ctx = new_context(browser)
    page = ctx.new_page()
    page.goto(ORIGIN + "/feeds/Page.html")
    page.set_content(f'<iframe src="{SITE_URL}" width="800" height="600"></iframe>')
    page.wait_for_timeout(1500)
    inner = page.frames[1]
    check("desktop: refuses to run inside a frame", inner.evaluate("document.querySelectorAll('.post').length") == 0)
    ctx.close()


def test_desktop_installable(browser):
    # Chrome won't install from an incognito window, so this uses a normal profile.
    profile = tempfile.mkdtemp(prefix="minreader-profile-")
    ctx = browser.browser_type.launch_persistent_context(profile, executable_path=CHROME, viewport={"width": 1400, "height": 900})
    ctx.add_init_script(INIT % json.dumps("good-key"))
    ctx.route(re.compile(r"^https?://(?!127\.0\.0\.1)"), lambda route: route.abort())
    page = open_page(ctx)
    page.wait_for_timeout(1500)  # lets the service worker start
    cdp = ctx.new_cdp_session(page)
    errors = cdp.send("Page.getInstallabilityErrors")["installabilityErrors"]
    check("desktop: Chrome says it can be installed", not errors, errors)
    manifest = cdp.send("Page.getAppManifest")
    check("desktop: the manifest has no errors", not manifest.get("errors"), manifest.get("errors"))
    data = json.loads(manifest["data"])
    maskable = [i for i in data["icons"] if "maskable" in i.get("purpose", "")]
    check("desktop: the maskable icon is its own file", maskable and all(i["src"] not in ("Icon-512.png", "Icon-192.png") for i in maskable), maskable)
    for icon in data["icons"]:
        res = page.request.get(SITE_URL + icon["src"])
        check(f"desktop: icon {icon['src']} is published", res.ok)
    ctx.close()
    shutil.rmtree(profile, ignore_errors=True)


# ---------- Phone ----------

def test_phone_panes_and_back(browser):
    api("reset", {})
    ctx = new_context(browser, phone=True)
    page = open_page(ctx)
    pane = lambda: page.locator("#layout").get_attribute("data-pane")
    check("phone: opens on the post list", pane() == "posts")
    shot(page, "Phone posts")
    row(page, "Cozy post 1").tap()
    check("phone: tapping a post opens it", pane() == "post")
    page.frame_locator("#readerFrame").locator("text=Cozy text 1").wait_for()
    check("phone: bookmark button says Bookmark", page.locator("#bookmarkBtn .short").inner_text() == "Bookmark")
    page.tap("#bookmarkBtn")
    check("phone: and Bookmarked once tapped", page.locator("#bookmarkBtn .short").inner_text() == "Bookmarked")
    shot(page, "Phone post")
    page.go_back()
    check("phone: back goes to the post list", wait_for(lambda: pane() == "posts", 3))
    page.go_back()
    check("phone: back again goes to the feed list", wait_for(lambda: pane() == "feeds", 3))
    shot(page, "Phone feeds")
    page.tap('.feed-item:has-text("Cozy Blog")')
    check("phone: tapping a feed opens its posts", pane() == "posts" and page.locator("#viewTitle").inner_text() == "Cozy Blog")
    page.go_back()
    check("phone: back from a feed goes to the feed list", wait_for(lambda: pane() == "feeds", 3))
    check("phone: no page errors", not page.errors, page.errors)
    ctx.close()


def test_phone_reload(browser):
    for deep in ("post", "posts"):
        ctx = new_context(browser, phone=True)
        page = open_page(ctx)
        pane = lambda: page.locator("#layout").get_attribute("data-pane")
        row(page, "Cozy post 2").tap()  # first tap adds the feed-list step, then opens the post
        if deep == "posts":
            page.go_back()
            wait_for(lambda: pane() == "posts", 3)
        length = page.evaluate("history.length")
        page.reload()
        page.wait_for_selector(".post")
        page.wait_for_timeout(300)
        row(page, "Cozy post 3").tap() if deep == "posts" else page.tap(".topbar .title")
        if deep == "posts":
            page.go_back()
            wait_for(lambda: pane() == "posts", 3)
        page.go_back()
        ok = wait_for(lambda: pane() == "feeds", 3)
        check(f"phone: after reloading on the {'open post' if deep == 'post' else 'post list'}, back still reaches the feed list in the usual steps", ok, pane())
        check(f"phone: reloading on the {'open post' if deep == 'post' else 'post list'} adds no extra history steps",
              page.evaluate("history.length") <= length, (length, page.evaluate("history.length")))
        ctx.close()


def test_phone_touch(browser):
    api("reset", {})
    ctx = new_context(browser, phone=True)
    page = open_page(ctx)
    r = row(page, "Cozy post 3")
    actions = r.locator(".post-actions")
    check("phone: post buttons always show", actions.is_visible())
    row_box, act_box = r.bounding_box(), actions.bounding_box()
    check("phone: post buttons line up with the right edge", abs((row_box["x"] + row_box["width"] - 16) - (act_box["x"] + act_box["width"])) <= 2,
          (row_box, act_box))
    thumb_row = row(page, "Cozy post 1")
    check("phone: post buttons sit under the thumbnail too", thumb_row.locator(".post-actions").bounding_box()["y"] >=
          thumb_row.locator(".thumb").bounding_box()["y"] + thumb_row.locator(".thumb").bounding_box()["height"])
    touch_hold(page, r)
    check("phone: holding a post opens its menu", page.locator("#menu").is_visible())
    check("phone: and doesn't open the post", page.locator("#layout").get_attribute("data-pane") == "posts")
    page.mouse.click(5, 5)
    shot(page, "Phone menu closed")
    page.click('[data-back]:visible')
    page.wait_for_timeout(200)
    check("phone: the feed list fits the screen width", page.evaluate("document.documentElement.scrollWidth") <= 412)
    ctx.close()


# ---------- Run ----------

def main():
    if os.path.isdir(SHOTS):
        shutil.rmtree(SHOTS)
    site = build_site()
    server = subprocess.Popen([sys.executable, "-I", os.path.join(HERE, "Test Server.py"), site, str(PORT)], stdout=subprocess.PIPE)
    try:
        server.stdout.readline()
        subprocess.run([sys.executable, "-I", os.path.join(REPO, "Fetch Feeds.py")], cwd=site, check=True, capture_output=True)
        tests = [(n, f) for n, f in globals().items() if n.startswith("test_") and ONLY in n]
        with sync_playwright() as pw:
            browser = pw.chromium.launch(executable_path=CHROME) if CHROME else pw.chromium.launch(channel="chrome")
            for name, fn in tests:
                print(name.replace("test_", ""), flush=True)
                try:
                    fn(site) if name.startswith("test_python") else fn(browser)
                except Exception:
                    check(name + " finished", False, traceback.format_exc(limit=3))
            browser.close()
    finally:
        server.terminate()
        shutil.rmtree(site, ignore_errors=True)
    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)} of {len(results)} checks passed.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
