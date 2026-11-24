# MinReader

My RSS reader. GitHub checks the feeds every 15 minutes and hosts the page. GitHub sometimes skips those checks, so the page also starts one when its posts are 20 minutes old.

**Address:** https://ydnim.github.io/MinReader/

## New device

Open the address and follow the access key steps. Give each device its own key. If a device is lost, delete its key at https://github.com/settings/personal-access-tokens.

On the phone, install it from Chrome's menu: **Install and create shortcut**, then **Install**.

## Good to know

- Don't edit or delete `State.json` or the `Bookmarks` folder. They hold read marks and bookmarks.
- Posts older than 30 days are cleared out. Bookmarks are kept.
- The refresh button checks feeds right away. Each access key needs Contents and Actions set to Read and write.
- GitHub pauses the schedule after 60 days without any activity. To restart it: **Actions** tab, **Update Feeds**, **Enable workflow**.
