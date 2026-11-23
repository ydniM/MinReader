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
  server-side sanitizing, because the page holds the access key.
- Opening a post marks it read. Nothing is auto-selected when a list opens. In the Unread
  view, posts read during the visit stay listed until she leaves the view.
- Under 800px wide it shows one column at a time; each step deeper is a history entry so the
  phone's back gesture works.

## Style

- Matches Mindy's Kitchen: Nunito body, Baloo 2 headings, pastel blue/lavender/pink
  gradients, dark 1px outlines with 2px hard shadows, 16px card radius, accent `#6c6cf2`.
- UI text: full, friendly sentences. No dashes as sentence punctuation.
- File names use proper capitalization and spaces where possible.

## Testing

Local testing uses `localStorage['reader-dev'] = {owner, repo, api}` to point the page at a
fake GitHub API. Check desktop (3 columns) and phone width (412px) after any layout change.
