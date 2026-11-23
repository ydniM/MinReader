# Mindy's Reader

A simple RSS reader that runs entirely on GitHub, for free. GitHub checks every feed every 30 minutes, and the reader page is hosted on GitHub Pages. What you've read and bookmarked is saved in this repo, so your PC and phone always match.

## Files

- `Feeds.json`: your list of feeds. You can add and remove feeds from inside the reader, so you don't need to edit this by hand.
- `Fetch Feeds.py`: the script GitHub runs every 30 minutes to check your feeds.
- `.github/workflows/Update Feeds.yml`: tells GitHub when to run the script and how to publish the page.
- `index.html`, `Reader.css`, `Reader.js`: the reader page itself.
- `Manifest.json`, `Icon.svg`, `Icon-192.png`, `Icon-512.png`: the app icon, for adding the reader to your phone's home screen.
- `State.json` and the `Bookmarks` folder: created by the reader the first time you read or bookmark something. Don't edit or delete these, or you'll lose your read marks and bookmarks.

## Opening it

The reader's address is `https://ydnim.github.io/` followed by the repo name and a slash, for example `https://ydnim.github.io/Mindy-s-Reader/`.

The first time you open it on a device, it asks for an access key and shows the steps to make one. Make a separate key for each device (for example `Mindy's Reader PC` and `Mindy's Reader Phone`), so if you ever lose your phone you can delete just that one key at https://github.com/settings/personal-access-tokens.

**Adding it to your Pixel's home screen:** open the reader's address in Chrome, tap the three dots at the top right, then tap **Add to home screen** (or **Install app**).

## Things to know

- Posts older than 30 days are cleared out. Bookmarked posts are kept forever, even after a website removes them from its feed.
- To sort your feeds, use the menu next to **FEEDS**. To put them in your own order, drag a feed by the dots on its left.
- To rename a feed or change its address, click the feed, then click the pencil at the top of the post list.
- If a feed stops working, a yellow **!** shows next to it. Click the feed to see what went wrong.
- GitHub pauses scheduled jobs in a repo that has had no activity for 60 days. Reading posts counts as activity, so this only happens if you stop using the reader for two months. To restart it, go to the **Actions** tab, click **Update Feeds**, and click **Enable workflow**.
- To check for new posts right away, go to the **Actions** tab, click **Update Feeds**, click **Run workflow**, then click the green **Run workflow** button.
