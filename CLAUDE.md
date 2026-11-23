# Mindy's Reader: project context

Mindy's personal RSS reader, replacing feeder.co. She is the only user. It is deliberately
minimal: three columns (feeds, posts, open post), read/unread, mark a feed or everything as
read, bookmarks (never call them "starred"), add/edit/remove feeds, and feed sorting (drag and
drop custom order, name A to Z / Z to A, most / fewest unread). No AI, no extra features unless
she asks.

## How it works

- `Fetch Feeds.py` runs in GitHub Actions every 30 minutes (`Update Feeds.yml`). It reads
  `Feeds.json`, keeps posts for 30 days (max 300 per feed), and writes `data/index.json`
  (feed list plus post metadata) and `data/content/<first 2 chars of id>.json` (sanitized
  post HTML, via nh3). The `data` folder is carried between runs with actions/cache; on a
  cache miss it falls back to downloading the live site's data.
- The page is static on GitHub Pages. Reading progress and bookmarks sync through the GitHub
  contents API with a fine-grained token saved in each browser's localStorage:
  `State.json` holds `{read: {id: unixTime}, bookmarks: {id: postMetadata}}`, and each
  bookmark's text is saved to `Bookmarks/<id>.html` so it outlives the 30-day window.
- Changes are queued (`reader-pending` in localStorage), saved 4 seconds after the last
  change, and replayed on top of a fresh copy of State.json, retrying on 409/422, so two
  devices never overwrite each other.
- `State.json` also holds `feedSort` and `feedOrder` (feed ids), so sorting syncs too.
- Editing a feed's address writes its old id into its `Feeds.json` entry (`"id"`), so its
  post ids, read marks and custom order position stay the same.
- Commits to `State.json` and `Bookmarks/` don't trigger the workflow (`paths-ignore`).
- Post text is shown in a sandboxed iframe (no scripts, no same-origin) on top of the
  server-side sanitizing, because the page holds the access key. Each post gets a new
  iframe (`showInFrame`), because changing `srcdoc` in place adds a history entry and breaks
  the phone's back gesture.
- Only http(s) addresses are used for post links, feed websites and images (`web_url` in
  Python, `webUrl`/`openLink` in Reader.js), since a `javascript:` link opened from the page
  could read the key. index.html has a Content Security Policy (scripts from the site only,
  GitHub API for saving), and the page won't run inside another site's frame.
- Interaction: feeds are dragged directly (mouse: press and move 5px; phone: hold 420ms then
  slide). Right-click (phone: hold and release) opens a menu on feeds, posts, All posts and
  Unread. The feed view's ⋯ button opens the same feed menu. Sorting is a quiet "Sort"
  button next to FEEDS: rows Custom, Name and Unread, with up/down direction arrows.
- Posts have quick actions (read/unread, bookmark, open original). With a mouse they show on
  hover over the post's bottom right corner; on touch screens they always show at the end of
  the meta line. Feeds show a ⋯ button on hover in place of the unread count.
- Column widths: drag the gaps between columns; double-click a gap to reset. Saved per device
  in localStorage (`reader-widths`), not synced.
- Opening a post marks it read. Nothing is auto-selected when a list opens. In the Unread
  view, read posts leave the list right away (like Feeder). On a computer the open post stays
  listed until another one is opened. Marking one read with its check button shows Undo.
- Under 800px wide it shows one column at a time; each step deeper is a history entry so the
  phone's back gesture works.

## Style

- Matches Mindy's Kitchen: Nunito body, Baloo 2 headings, pastel blue/lavender/pink
  gradients, dark 1px outlines with 2px hard shadows, 16px card radius, accent `#6c6cf2`.
- UI text: full, friendly sentences. No dashes as sentence punctuation.
- File names use proper capitalization and spaces where possible.
- Don't over-explain in the UI or README: she knows her own app. The README only covers
  what she needs to know to use and maintain it.

## Testing

Local testing uses `localStorage['reader-dev'] = {owner, repo, api}` to point the page at a
fake GitHub API. Check desktop (3 columns) and phone width (412px) after any layout change.
