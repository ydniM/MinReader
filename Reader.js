'use strict';

/* Mindy's Reader
   Posts come from data/index.json, which GitHub Actions rebuilds every 30
   minutes. Reading progress and bookmarks are saved to State.json in the
   GitHub repo (and each bookmarked post's text to Bookmarks/<id>.html),
   using the access key saved in this browser, so every device shows the same
   thing. */

// The page holds the access key, so it refuses to run inside another site's frame.
if (window.top !== window.self) throw new Error('Mindy’s Reader can’t run inside a frame.');

// ---------- Settings ----------

const DEV = readJSON('reader-dev', null); // only used for local testing
const OWNER = DEV ? DEV.owner : location.hostname.split('.')[0];
const REPO = DEV ? DEV.repo : decodeURIComponent(location.pathname.split('/')[1] || '');
const API = DEV ? DEV.api : 'https://api.github.com';
const SAVE_DELAY = 4000;          // wait this long after a change before saving, so changes go in together
const CHECK_POSTS_EVERY = 5 * 60e3;
const CHECK_STATE_EVERY = 2 * 60e3;
const PAGE_SIZE = 100;            // posts drawn at a time in the list

// ---------- Small helpers ----------

function readJSON(key, fallback) {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
}
function writeJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked: nothing to do */ }
}
const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nowSec = () => Math.floor(Date.now() / 1000);
const isPhone = () => matchMedia('(max-width: 800px)').matches;

function ago(sec) {
  const d = nowSec() - sec;
  if (d < 60) return 'just now';
  if (d < 3600) return Math.floor(d / 60) + ' min';
  if (d < 86400) { const h = Math.floor(d / 3600); return h + (h === 1 ? ' hr' : ' hrs'); }
  if (d < 7 * 86400) { const n = Math.floor(d / 86400); return n + (n === 1 ? ' day' : ' days'); }
  const date = new Date(sec * 1000);
  const opts = { month: 'short', day: 'numeric' };
  if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
  return date.toLocaleDateString(undefined, opts);
}
function fullDate(sec) {
  return new Date(sec * 1000).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
// "just now", "5 min ago" or "on Nov 3", to follow words like "Updated".
function agoPhrase(sec) {
  const d = nowSec() - sec;
  return d < 60 ? 'just now' : d < 7 * 86400 ? ago(sec) + ' ago' : 'on ' + ago(sec);
}
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
// Only web addresses are used as links or images. Anything else (like a
// javascript: link in someone's feed) could run code next to the access key.
function webUrl(url) {
  try { return /^https?:$/.test(new URL(url).protocol) ? url : ''; } catch { return ''; }
}
function openLink(url) {
  if (webUrl(url)) window.open(url, '_blank', 'noopener,noreferrer');
}

function faviconHTML(feed, cls = 'favicon') {
  const host = hostOf(feed.site) || hostOf(feed.url);
  const letter = esc((feed.title || '?').trim().charAt(0).toUpperCase());
  if (!host) return `<span class="${cls} letter">${letter}</span>`;
  return `<img class="${cls}" src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64" alt="" loading="lazy" data-letter="${letter}">`;
}
// A favicon that fails to load turns into the feed's first letter.
document.addEventListener('error', (e) => {
  const img = e.target;
  if (img.tagName === 'IMG' && img.classList.contains('favicon')) {
    const span = document.createElement('span');
    span.className = img.className + ' letter';
    span.textContent = img.dataset.letter || '?';
    img.replaceWith(span);
  } else if (img.tagName === 'IMG' && img.classList.contains('thumb')) {
    img.remove();
  }
}, true);

// ---------- GitHub storage ----------

let token = localStorage.getItem('reader-token') || '';

class GitHubError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function gh(path, options = {}) {
  const res = await fetch(`${API}/repos/${OWNER}/${REPO}/${path}`, {
    ...options,
    cache: 'no-store',
    headers: {
      Accept: options.raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).message || msg; } catch { /* not JSON */ }
    throw new GitHubError(res.status, msg);
  }
  if (options.raw) return res.text();
  return res.status === 204 ? null : res.json();
}

function toBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
function fromBase64(b64) {
  const bin = atob(b64.replace(/\s/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

// Returns { text, sha }, or null if the file doesn't exist yet.
async function getFile(path) {
  try {
    const data = await gh(`contents/${encodeURI(path)}`);
    // GitHub leaves out the text of files over 1 MB, so those are downloaded on their own.
    if (data.encoding === 'none' && data.size > 0) return { text: await gh(`contents/${encodeURI(path)}`, { raw: true }), sha: data.sha };
    return { text: fromBase64(data.content || ''), sha: data.sha };
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}
async function putFile(path, text, sha, message) {
  const body = { message, content: toBase64(text) };
  if (sha) body.sha = sha;
  const data = await gh(`contents/${encodeURI(path)}`, { method: 'PUT', body: JSON.stringify(body) });
  return data.content.sha;
}
async function deleteFile(path, message) {
  const file = await getFile(path);
  if (!file) return;
  await gh(`contents/${encodeURI(path)}`, { method: 'DELETE', body: JSON.stringify({ message, sha: file.sha }) });
}

// ---------- Reading progress and bookmarks ----------
// "saved" is the last copy loaded from GitHub. Changes not yet saved wait in
// "pending" (also kept in this browser, so closing the tab loses nothing).
// What's shown is saved + pending.

const emptyState = () => ({ read: {}, bookmarks: {}, feedSort: 'az', feedOrder: [] });
let saved = readJSON('reader-saved', emptyState());
let pending = readJSON('reader-pending', []);
let state = applyAll(saved, pending);
let syncStatus = 'ok';
let saveTimer = null;
let saving = false;
let saveCount = 0; // goes up with every save, so an older copy loaded meanwhile is ignored

function applyOp(s, op) {
  if (op.op === 'read') for (const id of op.ids) s.read[id] = op.t;
  else if (op.op === 'unread') for (const id of op.ids) delete s.read[id];
  else if (op.op === 'bookmark') s.bookmarks[op.post.id] = op.post;
  else if (op.op === 'unbookmark') delete s.bookmarks[op.id];
  else if (op.op === 'sort') s.feedSort = op.sort;
  else if (op.op === 'order') s.feedOrder = op.ids.slice();
}
function applyAll(base, ops) {
  const s = {
    read: { ...(base.read || {}) },
    bookmarks: { ...(base.bookmarks || {}) },
    feedSort: base.feedSort || 'az',
    feedOrder: (base.feedOrder || []).slice(),
  };
  for (const op of ops) applyOp(s, op);
  return s;
}

function change(op) {
  op.t = op.t || nowSec();
  pending.push(op);
  writeJSON('reader-pending', pending);
  applyOp(state, op);
  scheduleSave(SAVE_DELAY);
}

function scheduleSave(delay) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, delay);
  showSync();
}

// Forgets read marks for posts that are gone from the reader, so State.json
// doesn't grow forever. Only runs once posts have loaded.
function prune(s) {
  if (!index || !index.posts.length) return;
  const cutoff = nowSec() - 45 * 86400;
  for (const [id, t] of Object.entries(s.read)) if (t < cutoff && !postsById.has(id)) delete s.read[id];
}

async function saveNow() {
  if (saving || !token) return;
  if (!pending.length) { syncStatus = 'ok'; showSync(); return; }
  saving = true;
  syncStatus = 'saving';
  showSync();
  let conflicts = 0;
  try {
    // Keeps going while changes are waiting, including ones made during a save.
    while (pending.length) {
      const batch = pending.slice();
      // Bookmarked posts' text is saved as its own file first.
      for (const op of batch) {
        if (op.done) continue;
        if (op.op === 'bookmark' && op.html != null) {
          try { await putFile(`Bookmarks/${op.post.id}.html`, op.html, null, 'Save bookmarked post'); }
          catch (err) { if (err.status !== 422) throw err; } // 422: the file is already there
        } else if (op.op === 'unbookmark') {
          await deleteFile(`Bookmarks/${op.id}.html`, 'Remove bookmarked post');
        }
        op.done = true;
        delete op.html;
        writeJSON('reader-pending', pending);
      }
      const remote = await getFile('State.json');
      const base = remote ? JSON.parse(remote.text) : emptyState();
      const next = applyAll(base, batch);
      prune(next);
      try {
        await putFile('State.json', JSON.stringify(next), remote && remote.sha, 'Update reading progress');
      } catch (err) {
        if ((err.status === 409 || err.status === 422) && ++conflicts < 5) { // another device saved first: reload and try again
          await new Promise((r) => setTimeout(r, 800 * conflicts));
          continue;
        }
        throw err;
      }
      pending.splice(0, batch.length);
      writeJSON('reader-pending', pending);
      saved = next;
      saveCount++;
      writeJSON('reader-saved', saved);
    }
    syncStatus = 'ok';
    // Shows anything another device saved in the meantime.
    const merged = applyAll(saved, pending);
    if (JSON.stringify(merged) !== JSON.stringify(state)) { state = merged; renderAll(); }
  } catch (err) {
    syncStatus = err.status === 401 || err.status === 403 || err.status === 404 ? 'denied' : 'error';
    console.error('Saving failed', err);
  }
  saving = false;
  showSync();
  if (pending.length && syncStatus === 'error') scheduleSave(30e3);
}

// Loads the latest progress saved by any device.
async function loadState() {
  if (!token) return;
  const countBefore = saveCount;
  try {
    const remote = await getFile('State.json');
    // A save that finished meanwhile already has a newer copy than this one.
    if (saving || saveCount !== countBefore) return;
    const fresh = remote ? JSON.parse(remote.text) : emptyState();
    fresh.read = fresh.read || {};
    fresh.bookmarks = fresh.bookmarks || {};
    for (const b of Object.values(fresh.bookmarks)) { b.link = webUrl(b.link); b.image = webUrl(b.image); }
    const wasDenied = syncStatus === 'denied';
    if (wasDenied) syncStatus = 'ok';
    if (JSON.stringify(fresh) === JSON.stringify(saved) && !wasDenied) return; // nothing new: don't redraw
    saved = fresh;
    writeJSON('reader-saved', saved);
    state = applyAll(saved, pending);
    renderAll();
  } catch (err) {
    if (err.status === 401 || err.status === 403 || err.status === 404) { syncStatus = 'denied'; showSync(); }
    console.error('Loading progress failed', err);
  }
}

function showSync() {
  const el = $('#syncStatus');
  const waiting = pending.length > 0;
  let cls = '', text = 'All changes saved';
  if (syncStatus === 'saving' || (waiting && syncStatus === 'ok')) { cls = 'busy'; text = 'Saving…'; }
  if (syncStatus === 'error') { cls = 'bad'; text = 'Couldn’t save. Trying again soon.'; }
  if (syncStatus === 'denied') { cls = 'bad'; text = 'The access key isn’t working.'; }
  el.className = 'sync ' + cls;
  el.innerHTML = `<span class="dot"></span><span>${text}</span>`;
}

// ---------- Posts ----------

let index = null;              // contents of data/index.json
let feedsById = new Map();
let postsById = new Map();
let postsLoadError = '';
const contentCache = new Map(); // shard prefix -> { id: html }

async function loadPosts() {
  const errorBefore = postsLoadError;
  let changed = !index;
  try {
    const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) throw new Error('first');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (!index || data.updated !== index.updated) {
      changed = true;
      for (const f of data.feeds) f.site = webUrl(f.site);
      for (const p of data.posts) { p.link = webUrl(p.link); p.image = webUrl(p.image); }
      index = data;
      feedsById = new Map(index.feeds.map((f) => [f.id, f]));
      postsById = new Map(index.posts.map((p) => [p.id, p]));
      contentCache.clear();
      for (const id of [...addingFeeds.keys()]) if (index.feeds.some((f) => f.url === addingFeeds.get(id).url)) addingFeeds.delete(id);
      for (const url of [...removingFeeds]) if (!index.feeds.some((f) => f.url === url)) removingFeeds.delete(url);
    }
    if (applyFeedEdits()) changed = true;
    postsLoadError = '';
  } catch (err) {
    postsLoadError = err.message === 'first'
      ? 'No posts yet. The first update runs a few minutes after setup, so check back soon.'
      : 'The posts couldn’t be loaded. Check your internet connection, then press the refresh button at the top.';
  }
  // Only redraws when something changed, so the list doesn't jump while you read.
  if (changed || postsLoadError !== errorBefore) renderAll(); else showUpdated();
}

async function postContent(post) {
  if (postsById.has(post.id)) {
    try {
      const prefix = post.id.slice(0, 2);
      if (!contentCache.has(prefix)) {
        const res = await fetch(`data/content/${prefix}.json?v=${index.updated}`);
        if (!res.ok) throw new Error('content');
        contentCache.set(prefix, await res.json());
      }
      const html = contentCache.get(prefix)[post.id];
      if (html != null) return html;
    } catch (err) {
      if (!state.bookmarks[post.id]) throw err; // a bookmarked post can still use its saved copy below
    }
  }
  // A bookmarked post that has left the reader: use the copy saved on GitHub.
  const pendingOp = pending.find((op) => op.op === 'bookmark' && op.post.id === post.id && op.html != null);
  if (pendingOp) return pendingOp.html;
  const file = await getFile(`Bookmarks/${post.id}.html`);
  if (file) return file.text;
  throw new Error('content');
}

const isRead = (id) => id in state.read;
const feedOf = (post) => feedsById.get(post.feed) || { id: post.feed, title: post.feedTitle || 'Removed feed', site: post.feedSite || '', url: '' };

function visibleFeeds(counts = unreadCounts()) {
  const list = (index ? index.feeds.filter((f) => !removingFeeds.has(f.url)) : []).concat([...addingFeeds.values()]);
  const byName = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  const sort = state.feedSort || 'az';
  if (sort === 'za') return list.sort((a, b) => byName(b, a));
  if (sort === 'most' || sort === 'fewest') {
    const n = (f) => counts.get(f.id) || 0;
    return list.sort((a, b) => (sort === 'most' ? n(b) - n(a) : n(a) - n(b)) || byName(a, b));
  }
  if (sort === 'custom') {
    // Feeds you haven't placed yet (like a new one) go at the end.
    const pos = new Map((state.feedOrder || []).map((id, i) => [id, i]));
    return list.sort((a, b) => (pos.has(a.id) ? pos.get(a.id) : 1e9) - (pos.has(b.id) ? pos.get(b.id) : 1e9) || byName(a, b));
  }
  return list.sort(byName);
}
function livePosts() {
  if (!index) return [];
  return index.posts.filter((p) => !removingFeeds.has(feedOf(p).url));
}
// Unread posts per feed id, plus the total under ''.
function unreadCounts() {
  const counts = new Map([['', 0]]);
  for (const p of livePosts()) {
    if (isRead(p.id)) continue;
    counts.set(p.feed, (counts.get(p.feed) || 0) + 1);
    counts.set('', counts.get('') + 1);
  }
  return counts;
}

// ---------- Views ----------

let view = readJSON('reader-view', 'all');  // 'all', 'unread', 'bookmarks' or 'feed:<id>'
let current = null;                       // the open post
let keepVisible = new Set();              // posts read while looking at Unread, kept until you leave it
let shownCount = PAGE_SIZE;

function postsForView() {
  if (view === 'bookmarks') return Object.values(state.bookmarks).sort((a, b) => b.saved - a.saved);
  const posts = livePosts();
  if (view === 'unread') return posts.filter((p) => !isRead(p.id) || keepVisible.has(p.id));
  if (view.startsWith('feed:')) { const id = view.slice(5); return posts.filter((p) => p.feed === id); }
  return posts;
}

function viewTitle() {
  if (view === 'all') return 'All posts';
  if (view === 'unread') return 'Unread';
  if (view === 'bookmarks') return 'Bookmarks';
  const f = feedsById.get(view.slice(5)) || addingFeeds.get(view.slice(5));
  return f ? f.title : 'Feed';
}

function setView(v, { push = true } = {}) {
  if (v.startsWith('feed:') && !feedsById.has(v.slice(5)) && !addingFeeds.has(v.slice(5))) v = 'all';
  view = v;
  writeJSON('reader-view', view);
  keepVisible = new Set();
  shownCount = PAGE_SIZE;
  renderAll();
  $('#postScroll').scrollTop = 0;
  if (push) showPane('posts');
}

// ---------- Drawing ----------

function renderAll() {
  if (view.startsWith('feed:') && index && !feedsById.has(view.slice(5)) && !addingFeeds.has(view.slice(5))) view = 'all';
  renderFeeds();
  renderPosts();
  renderReaderBar();
  showSync();
  showUpdated();
}

function showUpdated() {
  $('#updated').textContent = index ? 'Updated ' + agoPhrase(index.updated) : '';
}

function renderFeeds() {
  if (dragging) { feedsNeedRender = true; return; }
  const counts = unreadCounts();
  const total = counts.get('');
  document.querySelector('[data-count="all"]').textContent = '';
  document.querySelector('[data-count="unread"]').textContent = total || '';
  document.querySelector('[data-count="bookmarks"]').textContent = Object.keys(state.bookmarks).length || '';
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const list = visibleFeeds(counts).map((f) => {
    const n = addingFeeds.has(f.id) ? 0 : counts.get(f.id) || 0;
    const warn = f.error ? `<span class="warn-dot" title="${esc(f.error)}">!</span>` : '';
    const extra = addingFeeds.has(f.id) ? '<span class="count">adding…</span>' : `<span class="count">${n || ''}</span>`;
    return `<li data-feed="${esc(f.id)}"><button class="feed-item${view === 'feed:' + f.id ? ' active' : ''}${n ? ' has-unread' : ''}" data-feed="${esc(f.id)}">
      ${faviconHTML(f)}<span class="nm">${esc(f.title)}</span>${warn}${extra}</button>${addingFeeds.has(f.id) ? '' : `<button class="row-more" title="More options" aria-label="More options for ${esc(f.title)}"><svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6" fill="currentColor"/><circle cx="12" cy="12" r="1.6" fill="currentColor"/><circle cx="19" cy="12" r="1.6" fill="currentColor"/></svg></button>`}</li>`;
  });
  $('#feedList').innerHTML = list.join('') || '<li class="empty">No feeds yet.</li>';
}

function postRowHTML(p) {
  const f = feedOf(p);
  const cls = view === 'bookmarks' ? '' : isRead(p.id) ? ' read' : ' unread';
  const bm = state.bookmarks[p.id] && view !== 'bookmarks'
    ? '<svg class="bm" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>' : '';
  const thumb = webUrl(p.image) ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  const read = isRead(p.id), marked = !!state.bookmarks[p.id];
  const actions = `<span class="post-actions">
    ${postsById.has(p.id) ? `<button data-act="read" title="${read ? 'Mark as unread' : 'Mark as read'}"><svg viewBox="0 0 24 24">${read ? ICONS.circle : ICONS.check}</svg></button>` : ''}
    <button data-act="bookmark" class="${marked ? 'on' : ''}" title="${marked ? 'Remove bookmark' : 'Bookmark'}"><svg viewBox="0 0 24 24">${ICONS.bookmark}</svg></button>
    ${webUrl(p.link) ? `<button data-act="open" title="Open original"><svg viewBox="0 0 24 24">${ICONS.open}</svg></button>` : ''}</span>`;
  return `<li class="post${cls}${current && current.id === p.id ? ' active' : ''}" data-id="${esc(p.id)}">
    <div class="txt"><div class="t">${esc(p.title)}</div>${p.summary ? `<div class="s">${esc(p.summary)}</div>` : ''}
    <div class="m">${faviconHTML(f)}<span class="fname">${esc(f.title)}</span><span class="ago">· ${ago(p.date)}</span>${bm}</div></div>${thumb}${actions}</li>`;
}

function renderPosts() {
  const posts = postsForView();
  const isFeed = view.startsWith('feed:');
  const feed = isFeed ? feedsById.get(view.slice(5)) : null;
  $('#viewTitle').textContent = viewTitle();

  const unread = view === 'bookmarks' ? 0 : posts.filter((p) => !isRead(p.id)).length;
  $('#viewCount').textContent = view === 'bookmarks'
    ? `${posts.length} ${posts.length === 1 ? 'bookmark' : 'bookmarks'}`
    : `${unread} unread`;

  const markBtn = $('#markAllBtn');
  markBtn.hidden = view === 'bookmarks';
  markBtn.disabled = unread === 0;
  setLabel(markBtn, isFeed ? 'Mark feed as read' : 'Mark all as read', 'Mark read');
  $('#moreFeedBtn').hidden = !isFeed || addingFeeds.has(view.slice(5));

  const problem = $('#feedProblem');
  if (feed && feed.error) {
    const last = feed.lastSuccess ? ` It last worked ${agoPhrase(feed.lastSuccess)}.` : ' It hasn’t worked yet.';
    problem.innerHTML = `<b>This feed had a problem on the last check.</b> ${esc(feed.error)}${esc(last)}`;
    problem.hidden = false;
  } else if (isFeed && addingFeeds.has(view.slice(5))) {
    problem.innerHTML = 'This feed was just added. Its posts will show up in a minute or two.';
    problem.hidden = false;
  } else problem.hidden = true;

  const empty = $('#postsEmpty');
  if (postsLoadError && view !== 'bookmarks') {
    empty.textContent = postsLoadError;
  } else if (!posts.length) {
    empty.innerHTML = view === 'unread' ? '<div class="big"><svg viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg></div>You’re all caught up.'
      : view === 'bookmarks' ? '<div class="big"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg></div>No bookmarks yet.'
      : index ? 'No posts from the last 30 days.' : 'Loading…';
  }
  empty.hidden = !(postsLoadError && view !== 'bookmarks') && posts.length > 0;
  const shown = (postsLoadError && view !== 'bookmarks') ? [] : posts.slice(0, shownCount);
  $('#postList').innerHTML = shown.map(postRowHTML).join('');
  $('#moreSentinel').dataset.more = posts.length > shownCount ? '1' : '';
}

// Draws more posts as you scroll near the bottom of the list.
new IntersectionObserver((entries) => {
  if (entries[0].isIntersecting && $('#moreSentinel').dataset.more) {
    shownCount += PAGE_SIZE;
    renderPosts();
  }
}, { root: $('#postScroll'), rootMargin: '600px' }).observe($('#moreSentinel'));

function renderReaderBar() {
  const readBtn = $('#readBtn'), bmBtn = $('#bookmarkBtn'), openBtn = $('#openBtn');
  readBtn.disabled = bmBtn.disabled = !current;
  if (!current) {
    openBtn.setAttribute('aria-disabled', 'true');
    openBtn.removeAttribute('href');
    return;
  }
  const read = isRead(current.id);
  setLabel(readBtn, read ? 'Mark as unread' : 'Mark as read', read ? 'Unread' : 'Read');
  readBtn.querySelector('svg').innerHTML = read ? '<circle cx="12" cy="12" r="8"/>' : '<path d="M5 12l5 5 9-10"/>';
  const marked = !!state.bookmarks[current.id];
  bmBtn.classList.toggle('on', marked);
  setLabel(bmBtn, marked ? 'Bookmarked' : 'Bookmark', marked ? 'Saved' : 'Save');
  bmBtn.title = marked ? 'Remove bookmark' : 'Bookmark';
  if (webUrl(current.link)) { openBtn.href = current.link; openBtn.removeAttribute('aria-disabled'); }
  else { openBtn.setAttribute('aria-disabled', 'true'); openBtn.removeAttribute('href'); }
}

// Buttons have a long label and a shorter one for phones.
function setLabel(button, long, short) {
  button.querySelector('.long').textContent = long;
  button.querySelector('.short').textContent = short;
  button.title = long;
}

// Updates one row in place, so the list doesn't jump while you read.
function refreshRow(id) {
  const row = document.querySelector(`.post[data-id="${CSS.escape(id)}"]`);
  const post = postsById.get(id) || state.bookmarks[id];
  if (row && post) {
    const tmp = document.createElement('template');
    tmp.innerHTML = postRowHTML(post).trim();
    row.replaceWith(tmp.content.firstChild);
  }
}
function refreshCounts() {
  renderFeeds();
  const posts = postsForView();
  const unread = view === 'bookmarks' ? 0 : posts.filter((p) => !isRead(p.id)).length;
  if (view !== 'bookmarks') $('#viewCount').textContent = `${unread} unread`;
  else $('#viewCount').textContent = `${posts.length} ${posts.length === 1 ? 'bookmark' : 'bookmarks'}`;
  $('#markAllBtn').disabled = unread === 0;
}

// ---------- Reading a post ----------

const FRAME_CSS = `
  @import url('https://fonts.googleapis.com/css2?family=Baloo+2:wght@700;800&family=Nunito:ital,wght@0,500;0,700;0,800;1,500&display=swap');
  html{background:#fff}
  body{margin:0;padding:26px 30px 60px;color:#241f19;font-family:'Nunito','Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:18px;line-height:1.7;font-weight:500;overflow-wrap:break-word}
  article{max-width:720px;margin:0 auto}
  .title{display:block;font-family:'Baloo 2','Nunito',sans-serif;font-size:31px;line-height:1.2;font-weight:800;color:#241f19;text-decoration:none;margin-bottom:10px}
  .title:hover{color:#463bcf}
  .meta{display:flex;flex-wrap:wrap;gap:4px 0;align-items:center;font-size:14px;color:#5f5648;font-weight:700;padding-bottom:16px;margin-bottom:22px;border-bottom:2px dashed #e7dcc6}
  .meta span+span::before{content:"\\2022";margin:0 9px;opacity:.5}
  a{color:#463bcf;text-underline-offset:2px}
  img,video{max-width:100%;height:auto;border-radius:10px}
  figure{margin:1.2em 0}
  figcaption{font-size:14px;color:#5f5648;margin-top:6px}
  blockquote{margin:1.2em 0;padding:4px 18px;border-left:4px solid #6c6cf2;background:#f6f4ff;border-radius:0 10px 10px 0}
  pre{overflow-x:auto;background:#f6f4ff;padding:12px;border-radius:10px;font-size:14px}
  code{font-size:.9em}
  table{border-collapse:collapse;max-width:100%;display:block;overflow-x:auto}
  td,th{border:1px solid #e7dcc6;padding:6px 9px}
  h1,h2,h3,h4{font-family:'Baloo 2','Nunito',sans-serif;line-height:1.25}
  hr{border:0;border-top:2px dashed #e7dcc6}
  .note{color:#5f5648;font-style:italic}
  @media (max-width:600px){body{padding:18px 18px 48px;font-size:17px}.title{font-size:26px}}
`;

let openToken = 0;

async function openPost(id) {
  const post = postsById.get(id) || state.bookmarks[id];
  if (!post) return;
  current = post;
  document.querySelectorAll('.post.active').forEach((r) => r.classList.remove('active'));
  const row = document.querySelector(`.post[data-id="${CSS.escape(id)}"]`);
  if (row) row.classList.add('active');

  if (!isRead(id) && postsById.has(id)) {
    if (view === 'unread') keepVisible.add(id);
    change({ op: 'read', ids: [id] });
    refreshRow(id);
    refreshCounts();
  }
  renderReaderBar();
  showPane('post');

  $('#readerEmpty').hidden = true;
  const myOpen = ++openToken;
  showInFrame(frameHTML(post, '<p class="note">Loading…</p>'));
  let body;
  try { body = await postContent(post); }
  catch { body = '<p class="note">This post’s text couldn’t be loaded. Press Open original to read it on the website.</p>'; }
  if (myOpen !== openToken) return;
  if (!body.trim()) body = '<p class="note">This feed doesn’t include the post’s text. Press Open original to read it on the website.</p>';
  showInFrame(frameHTML(post, body));
}

// Swaps in a new frame each time. Changing a frame's text in place adds a
// browser history entry, so the phone's back gesture would step through the
// post's loading screen instead of going back a column.
function showInFrame(html) {
  const old = $('#readerFrame');
  const frame = old.cloneNode(false);
  frame.removeAttribute('srcdoc');
  frame.srcdoc = html;
  frame.hidden = false;
  old.replaceWith(frame);
}

function frameHTML(post, body) {
  const f = feedOf(post);
  const meta = [f.title, post.author, fullDate(post.date)].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('');
  const title = webUrl(post.link) ? `<a class="title" href="${esc(post.link)}">${esc(post.title)}</a>` : `<div class="title">${esc(post.title)}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1"><style>${FRAME_CSS}</style></head>
    <body><article>${title}<div class="meta">${meta}</div>${body}</article></body></html>`;
}

// ---------- Phone panes ----------
// On a phone only one column shows at a time. Each step deeper is added to
// the browser history, so the phone's back gesture goes back a column.

const PANES = ['feeds', 'posts', 'post'];
function showPane(pane) {
  const layout = $('#layout');
  const from = layout.dataset.pane;
  if (from === pane) return;
  layout.dataset.pane = pane;
  if (isPhone() && PANES.indexOf(pane) > PANES.indexOf(from)) history.pushState({ pane }, '');
}
window.addEventListener('popstate', (e) => {
  $('#layout').dataset.pane = (e.state && e.state.pane) || 'feeds';
});
history.replaceState({ pane: 'feeds' }, '');
// On a phone, open straight to the list you were last looking at (like
// Unread). The back gesture still goes to the feed list.
if (isPhone()) showPane('posts');

// ---------- Actions ----------

document.querySelector('.views').addEventListener('click', (e) => {
  const b = e.target.closest('.view-btn');
  if (b) setView(b.dataset.view);
});
$('#feedList').addEventListener('click', (e) => {
  const more = e.target.closest('.row-more');
  if (more) {
    const items = feedMenu(feedsById.get(more.closest('li').dataset.feed));
    const r = more.getBoundingClientRect();
    if (items) openMenu(items, r.right - 230, r.bottom + 4);
    return;
  }
  const b = e.target.closest('.feed-item');
  if (b) setView('feed:' + b.dataset.feed);
});
$('#postList').addEventListener('click', (e) => {
  const act = e.target.closest('.post-actions button');
  if (act) {
    const id = act.closest('.post').dataset.id;
    const post = postsById.get(id) || state.bookmarks[id];
    if (!post) return;
    if (act.dataset.act === 'read') toggleRead(id);
    else if (act.dataset.act === 'bookmark') toggleBookmark(post);
    else if (act.dataset.act === 'open') openLink(post.link);
    return;
  }
  const row = e.target.closest('.post');
  if (row) openPost(row.dataset.id);
});
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => history.back()));

// Marks a group of posts read, with an Undo button in case it was a slip.
function markRead(posts) {
  const ids = posts.filter((p) => !isRead(p.id)).map((p) => p.id);
  if (!ids.length) return;
  change({ op: 'read', ids });
  keepVisible = new Set();
  renderAll();
  toast(`Marked ${ids.length} ${ids.length === 1 ? 'post' : 'posts'} as read.`, () => {
    change({ op: 'unread', ids });
    renderAll();
  });
}
$('#markAllBtn').addEventListener('click', () => markRead(postsForView()));

function toggleRead(id) {
  if (isRead(id)) change({ op: 'unread', ids: [id] });
  else change({ op: 'read', ids: [id] });
  if (view === 'unread') keepVisible.add(id);
  refreshRow(id);
  refreshCounts();
  renderReaderBar();
}
$('#readBtn').addEventListener('click', () => { if (current) toggleRead(current.id); });

$('#bookmarkBtn').addEventListener('click', () => { if (current) toggleBookmark(current); });
const bookmarking = new Set(); // posts whose text is still loading, so a double click adds one bookmark
async function toggleBookmark(post) {
  if (bookmarking.has(post.id)) return;
  const old = state.bookmarks[post.id];
  if (old) {
    // Keeps the text before its saved copy is deleted, so Undo can put it back.
    const text = postContent(old).catch(() => '');
    change({ op: 'unbookmark', id: post.id });
    toast('Bookmark removed.', async () => { if (!state.bookmarks[old.id]) addBookmark(old, await text); });
    if (view === 'bookmarks') renderPosts(); else refreshRow(post.id);
    refreshCounts();
    renderReaderBar();
  } else {
    await addBookmark(post);
  }
}

async function addBookmark(post, html) {
  if (html == null) {
    bookmarking.add(post.id);
    try { html = await postContent(post); } catch { html = ''; /* the bookmark still works with Open original */ }
    bookmarking.delete(post.id);
  }
  const f = feedOf(post);
  const copy = {
    id: post.id, feed: post.feed, feedTitle: f.title, feedSite: f.site || f.url || '',
    title: post.title, link: post.link, author: post.author || '', date: post.date,
    summary: post.summary || '', image: post.image || '', saved: post.saved || nowSec(),
  };
  change({ op: 'bookmark', post: copy, html });
  if (view === 'bookmarks') renderPosts(); else refreshRow(post.id);
  refreshCounts();
  renderReaderBar();
}

// The refresh button asks GitHub to check every feed now (instead of waiting
// for the next 30-minute run), then watches for the new posts. That needs the
// access key to have the Actions permission; without it, the button just
// loads whatever GitHub already has.
let refreshing = false;
$('#refreshBtn').addEventListener('click', async () => {
  if (refreshing) return;
  refreshing = true;
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  const before = index ? index.updated : 0;
  let started = false, noPermission = false;
  if (token) {
    try {
      await gh(`actions/workflows/${encodeURIComponent('Update Feeds.yml')}/dispatches`, { method: 'POST', body: JSON.stringify({ ref: 'main' }) });
      started = true;
    } catch (err) { noPermission = err.status === 403 || err.status === 404; }
  }
  await Promise.all([loadPosts(), loadState(), new Promise((r) => setTimeout(r, 700))]);
  if (!started) {
    btn.classList.remove('spinning');
    refreshing = false;
    const fresh = index && index.updated !== before;
    if (noPermission && !localStorage.getItem('reader-actions-tip')) {
      localStorage.setItem('reader-actions-tip', '1');
      toast('Loaded the latest posts. To make this button check your feeds right away, give your access key the Actions permission (Read and write).');
    } else toast(fresh ? 'New posts loaded.' : 'You’re up to date.');
    return;
  }
  toast('Checking your feeds. New posts will show up in a minute or two.');
  // Watches for the new data for up to 5 minutes, then stops.
  const until = Date.now() + 5 * 60e3;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, 15e3));
    await loadPosts();
    if (index && index.updated !== before) break;
  }
  btn.classList.remove('spinning');
  refreshing = false;
  if (index && index.updated !== before) toast('Your feeds are up to date.');
  else {
    // GitHub is slow today. Keeps looking every 30 seconds for a while.
    fastCheckUntil = Date.now() + 10 * 60e3;
    toast('The check is taking longer than usual. New posts will show up on their own.');
  }
});

// ---------- Toast ----------

let toastTimer = null;
function toast(text, undo) {
  const el = $('#toast');
  $('#toastText').textContent = text;
  const undoBtn = $('#toastUndo');
  undoBtn.hidden = !undo;
  undoBtn.onclick = () => { el.hidden = true; if (undo) undo(); };
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, undo ? 7000 : 4000);
}

// ---------- Dialogs ----------

function openModal({ title, body, actions, onOpen, wide }) {
  $('#modalTitle').textContent = title;
  $('#modalBody').innerHTML = body;
  const box = $('#modalActions');
  box.innerHTML = '';
  for (const a of actions) {
    const b = document.createElement('button');
    b.className = 'btn ' + (a.cls || '');
    b.textContent = a.label;
    b.addEventListener('click', a.onClick);
    box.appendChild(b);
  }
  $('.sheet').classList.toggle('wide', !!wide);
  $('#modal').classList.add('show');
  if (onOpen) onOpen();
}
function closeModal() { $('#modal').classList.remove('show'); }
$('#modal').addEventListener('click', (e) => { if (e.target.id === 'modal' && token) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && token) closeModal(); });

function busy(button, label) {
  button.disabled = true;
  button.dataset.label = button.textContent;
  button.textContent = label;
}
function unbusy(button) {
  button.disabled = false;
  button.textContent = button.dataset.label;
}

// Access key setup

function showKeySetup() {
  const repoUrl = `https://github.com/${OWNER}/${REPO}`;
  openModal({
    title: 'Add your access key',
    body: `<p>The reader saves what you’ve read and bookmarked to your GitHub repo, so it needs a key that can change files in that one repo. You only do this once on each device.</p>
      <ol>
        <li>Open <a class="linkbtn" href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">GitHub’s new token page</a> (sign in if it asks).</li>
        <li>In <b>Token name</b>, type <code>Mindy's Reader</code> plus the device, like <code>Mindy's Reader PC</code>.</li>
        <li>In <b>Expiration</b>, pick <b>No expiration</b>.</li>
        <li>Under <b>Repository access</b>, click <b>Only select repositories</b>, then pick <b>${esc(OWNER)}/${esc(REPO)}</b>.</li>
        <li>Under <b>Permissions</b>, click <b>Add permissions</b> and pick <b>Contents</b> and <b>Actions</b>. Change both from <b>Read-only</b> to <b>Read and write</b>.</li>
        <li>Click <b>Generate token</b> at the bottom, then <b>Copy</b>.</li>
        <li>Paste it below and click <b>Save key</b>.</li>
      </ol>
      <div class="field"><label for="keyInput">Access key</label><input id="keyInput" type="password" autocomplete="off" spellcheck="false" placeholder="github_pat_…"></div>
      <div class="form-error" id="keyError" hidden></div>
      <p class="sub" style="font-size:13.5px;color:var(--muted)">The key is only saved in this browser. Repo: <a class="linkbtn" href="${esc(repoUrl)}" target="_blank" rel="noopener">${esc(OWNER)}/${esc(REPO)}</a></p>`,
    actions: [
      ...(token ? [{ label: 'Cancel', onClick: closeModal }] : []),
      { label: 'Save key', cls: 'primary', onClick: saveKey },
    ],
    onOpen: () => setTimeout(() => $('#keyInput').focus(), 50),
    wide: true,
  });
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
}

async function saveKey() {
  if ($('#modalActions .primary').disabled) return; // already checking
  const input = $('#keyInput');
  const err = $('#keyError');
  const value = input.value.trim();
  if (!value) { err.textContent = 'Paste your access key first.'; err.hidden = false; return; }
  const button = $('#modalActions .primary');
  busy(button, 'Checking…');
  const old = token;
  token = value;
  try {
    await gh('contents/Feeds.json');
    localStorage.setItem('reader-token', token);
    closeModal();
    syncStatus = 'ok';
    await loadState();
    if (pending.length) scheduleSave(500);
  } catch (e) {
    token = old;
    err.textContent = e.status === 401
      ? 'GitHub didn’t accept that key. Check that you copied all of it.'
      : e.status === 403 || e.status === 404
        ? `That key can’t open ${OWNER}/${REPO}. Make sure you picked that repo under Repository access.`
        : 'GitHub couldn’t be reached. Check your internet connection and try again.';
    err.hidden = false;
  }
  unbusy(button);
}
$('#keyBtn').addEventListener('click', showKeySetup);

// Adding and removing feeds (changes Feeds.json in the repo, which starts an update)

const addingFeeds = new Map();   // temporary id -> feed, until the next update includes it
const removingFeeds = new Set(); // feed URLs, until the next update drops them
let fastCheckUntil = 0;

async function editFeedsFile(edit, message) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const file = await getFile('Feeds.json');
    const data = file ? JSON.parse(file.text) : { feeds: [] };
    data.feeds = data.feeds || [];
    const result = edit(data);
    if (result === false || typeof result === 'string') return result;
    try {
      await putFile('Feeds.json', JSON.stringify(data, null, 2) + '\n', file && file.sha, message);
      return true;
    } catch (err) {
      if (err.status !== 409 && err.status !== 422) throw err;
    }
  }
  throw new Error('conflict');
}

function showAddFeed() {
  openModal({
    title: 'Add a feed',
    body: `<p>Paste the feed’s address. A website’s normal address usually works too, since most websites list their feed.</p>
      <div class="field"><label for="feedUrl">Address</label><input id="feedUrl" type="url" placeholder="https://example.com/feed" autocomplete="off" spellcheck="false"></div>
      <div class="field"><label for="feedName">Name (optional)</label><input id="feedName" type="text" placeholder="Leave empty to use the feed’s own name" autocomplete="off"></div>
      <div class="form-error" id="feedError" hidden></div>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Add feed', cls: 'primary', onClick: addFeed },
    ],
    onOpen: () => setTimeout(() => $('#feedUrl').focus(), 50),
  });
  ['#feedUrl', '#feedName'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') addFeed(); }));
}

async function addFeed() {
  if ($('#modalActions .primary').disabled) return; // already adding
  const err = $('#feedError');
  let url = $('#feedUrl').value.trim();
  const title = $('#feedName').value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { url = ''; }
  if (!url || url === 'https://') { err.textContent = 'That doesn’t look like a web address.'; err.hidden = false; return; }
  const button = $('#modalActions .primary');
  busy(button, 'Adding…');
  try {
    const added = await editFeedsFile((data) => {
      if (data.feeds.some((f) => f.url === url)) return false;
      data.feeds.push({ title, url });
    }, `Add feed: ${title || url}`);
    if (!added) { err.textContent = 'That feed is already in your list.'; err.hidden = false; unbusy(button); return; }
    const tempId = 'new-' + Date.now();
    addingFeeds.set(tempId, { id: tempId, title: title || hostOf(url) || url, url, site: url, error: '' });
    closeModal();
    toast('Feed added. Its posts will show up in a minute or two.');
    fastCheckUntil = Date.now() + 6 * 60e3;
    renderAll();
  } catch (e) {
    err.textContent = e.status === 401 || e.status === 403 || e.status === 404
      ? 'Your access key can’t change files in the repo. Use Change access key to fix it.'
      : 'The feed couldn’t be added. Check your internet connection and try again.';
    err.hidden = false;
  }
  unbusy(button);
}
$('#addFeedBtn').addEventListener('click', showAddFeed);

function removeFeed(feed) {
  openModal({
    title: 'Remove this feed?',
    body: `<p><b>${esc(feed.title)}</b> and its posts will be removed from the reader. Posts you bookmarked from it stay in Bookmarks.</p><div class="form-error" id="removeError" hidden></div>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      {
        label: 'Remove feed', cls: 'danger', onClick: async (e) => {
          const button = e.currentTarget;
          busy(button, 'Removing…');
          try {
            await editFeedsFile((data) => { data.feeds = data.feeds.filter((f) => f.url !== feed.url && (f.id || '') !== feed.id); }, `Remove feed: ${feed.title}`);
            removingFeeds.add(feed.url);
            closeModal();
            if (view === 'feed:' + feed.id) setView('all', { push: false }); else renderAll();
            toast(`Removed ${feed.title}.`);
          } catch (err) {
            const box = $('#removeError');
            box.textContent = err.status === 401 || err.status === 403 || err.status === 404
              ? 'Your access key can’t change files in the repo. Use Change access key to fix it.'
              : 'The feed couldn’t be removed. Check your internet connection and try again.';
            box.hidden = false;
            unbusy(button);
          }
        },
      },
    ],
  });
}

// ---------- Menus ----------
// One small pop-up menu, used by right-clicking (or long-pressing on a
// phone) a feed, a post, All posts or Unread, and by the sort and ⋯ buttons.

const ICONS = {
  check: '<path d="M5 12l5 5 9-10"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
  open: '<path d="M14 4h6v6M20 4l-9 9M18 14v6H4V6h6"/>',
  bookmark: '<path d="M6 3h12v18l-6-4.5L6 21z"/>',
  readall: '<path d="M3 12l4 4 8-8"/><path d="M11 16l2 0 8-8"/>',
};

function openMenu(items, x, y) {
  const menu = $('#menu');
  menu.onclick = null;
  menu.innerHTML = '';
  for (const item of items) {
    if (item === '-') { menu.insertAdjacentHTML('beforeend', '<div class="menu-sep"></div>'); continue; }
    if (item.heading) { menu.insertAdjacentHTML('beforeend', `<div class="menu-head">${esc(item.heading)}</div>`); continue; }
    const b = document.createElement('button');
    b.className = 'menu-item' + (item.danger ? ' danger' : '') + (item.checked ? ' checked' : '');
    b.disabled = !!item.disabled;
    b.innerHTML = `<svg viewBox="0 0 24 24">${item.checked ? ICONS.check : ICONS[item.icon] || ''}</svg><span>${esc(item.label)}</span>`;
    b.addEventListener('click', () => { closeMenu(); item.onClick(); });
    menu.appendChild(b);
  }
  placeMenu(x, y);
}
function placeMenu(x, y) {
  const menu = $('#menu');
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
function closeMenu() { $('#menu').hidden = true; }
document.addEventListener('pointerdown', (e) => { if (!e.target.closest('#menu')) closeMenu(); }, true);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
window.addEventListener('resize', closeMenu);
document.addEventListener('scroll', closeMenu, true);

function feedMenu(feed) {
  if (!feed || addingFeeds.has(feed.id)) return null;
  const posts = livePosts().filter((p) => p.feed === feed.id);
  const items = [
    { label: 'Mark feed as read', icon: 'readall', disabled: !posts.some((p) => !isRead(p.id)), onClick: () => markRead(posts) },
    { label: 'Rename or change address', icon: 'edit', onClick: () => editFeed(feed) },
  ];
  if (webUrl(feed.site)) items.push({ label: 'Open website', icon: 'open', onClick: () => openLink(feed.site) });
  items.push('-', { label: 'Remove feed', icon: 'trash', danger: true, onClick: () => removeFeed(feed) });
  return items;
}
function postMenu(post) {
  const items = [];
  if (postsById.has(post.id)) items.push({ label: isRead(post.id) ? 'Mark as unread' : 'Mark as read', icon: isRead(post.id) ? 'circle' : 'check', onClick: () => toggleRead(post.id) });
  items.push({ label: state.bookmarks[post.id] ? 'Remove bookmark' : 'Bookmark', icon: 'bookmark', onClick: () => toggleBookmark(post) });
  if (webUrl(post.link)) items.push({ label: 'Open original', icon: 'open', onClick: () => openLink(post.link) });
  return items;
}
function viewMenu(v) {
  if (v === 'bookmarks') return null;
  const posts = v === 'unread' ? livePosts().filter((p) => !isRead(p.id)) : livePosts();
  return [{ label: 'Mark all as read', icon: 'readall', disabled: !posts.some((p) => !isRead(p.id)), onClick: () => markRead(posts) }];
}
function menuFor(el) {
  if (el.matches('.feed-list li')) return feedMenu(feedsById.get(el.dataset.feed));
  if (el.matches('.post')) { const p = postsById.get(el.dataset.id) || state.bookmarks[el.dataset.id]; return p ? postMenu(p) : null; }
  if (el.matches('.view-btn')) return viewMenu(el.dataset.view);
  return null;
}

$('#moreFeedBtn').addEventListener('click', (e) => {
  const items = feedMenu(feedsById.get(view.slice(5)));
  const r = e.currentTarget.getBoundingClientRect();
  if (items) openMenu(items, r.right - 230, r.bottom + 6);
});

// Sorting

function setSort(sort) {
  // Switching to custom order for the first time starts from the order shown now.
  if (sort === 'custom' && !(state.feedOrder || []).length) change({ op: 'order', ids: visibleFeeds().map((f) => f.id).filter((id) => !addingFeeds.has(id)) });
  change({ op: 'sort', sort });
  renderFeeds();
}

// The sort menu: Custom, then Name and Unread, each with an up and down
// arrow for the direction. Clicking a name picks it, or flips it if it's
// already picked.
const SORT_ROWS = [
  { label: 'Custom', up: 'custom' },
  { label: 'Name', up: 'az', down: 'za', upTitle: 'A to Z', downTitle: 'Z to A' },
  { label: 'Unread', up: 'fewest', down: 'most', upTitle: 'Fewest first', downTitle: 'Most first', first: 'most' },
];
const ARROW_UP = '<path d="M12 19V5M6 11l6-6 6 6"/>';
const ARROW_DOWN = '<path d="M12 5v14M6 13l6 6 6-6"/>';

function showSortMenu(x, y) {
  const now = state.feedSort || 'az';
  const menu = $('#menu');
  menu.innerHTML = '<div class="menu-head">Sort feeds</div>' + SORT_ROWS.map((row, i) => {
    const active = now === row.up || now === row.down;
    const arrows = row.down ? `<span class="sort-dirs">
        <button class="dir${now === row.up ? ' on' : ''}" data-sort="${row.up}" title="${row.upTitle}" aria-label="${row.label}, ${row.upTitle}"><svg viewBox="0 0 24 24">${ARROW_UP}</svg></button>
        <button class="dir${now === row.down ? ' on' : ''}" data-sort="${row.down}" title="${row.downTitle}" aria-label="${row.label}, ${row.downTitle}"><svg viewBox="0 0 24 24">${ARROW_DOWN}</svg></button></span>` : '';
    return `<div class="sort-row${active ? ' active' : ''}"><button class="menu-item${active ? ' checked' : ''}" data-row="${i}"><svg viewBox="0 0 24 24">${active ? ICONS.check : ''}</svg><span>${row.label}</span></button>${arrows}</div>`;
  }).join('');
  menu.onclick = (e) => {
    const dir = e.target.closest('[data-sort]');
    const rowBtn = e.target.closest('[data-row]');
    let sort = null;
    if (dir) sort = dir.dataset.sort;
    else if (rowBtn) {
      const row = SORT_ROWS[+rowBtn.dataset.row];
      if (!row.down) sort = row.up;
      else if (now === row.up) sort = row.down;
      else if (now === row.down) sort = row.up;
      else sort = row.first || row.up;
    }
    if (!sort) return;
    menu.onclick = null;
    setSort(sort);
    showSortMenu(x, y); // stays open so the change is visible
  };
  placeMenu(x, y);
}

$('#sortBtn').addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  showSortMenu(r.left, r.bottom + 6);
});

// ---------- Pressing, dragging and right-clicking ----------
// With a mouse: drag a feed to move it, right-click for its menu.
// With a finger: press and hold, then slide to move a feed, or let go to
// open its menu. A quick tap still just opens it.

let press = null;          // the press in progress
let dragging = null;       // the feed being dragged
let feedsNeedRender = false;
let swallowUntil = 0;      // stops the click that ends a drag or long-press from opening things
const HOLD_MS = 420;

const pressTarget = (t) => t.closest('.feed-list li[data-feed], .post, .view-btn');

document.addEventListener('pointerdown', (e) => {
  swallowUntil = 0; // a new press means the old drag's click has already passed
  if (e.button !== 0) return;
  const el = pressTarget(e.target);
  if (!el || e.target.closest('#menu')) return;
  press = { el, id: e.pointerId, type: e.pointerType, x: e.clientX, y: e.clientY, armed: false };
  if (e.pointerType !== 'mouse') {
    press.timer = setTimeout(() => {
      if (!press) return;
      press.armed = true;
      el.classList.add('held');
      if (navigator.vibrate) navigator.vibrate(12);
    }, HOLD_MS);
  }
});

window.addEventListener('pointermove', (e) => {
  if (!press || e.pointerId !== press.id) return;
  press.lastY = e.clientY;
  if (dragging) { moveDragged(e.clientY); return; }
  const dist = Math.hypot(e.clientX - press.x, e.clientY - press.y);
  const isFeed = press.el.matches('.feed-list li');
  if (press.type === 'mouse') {
    if (isFeed && dist > 5) startDrag();
  } else if (!press.armed) {
    if (dist > 8) endPress(); // a scroll, not a press
  } else if (isFeed && dist > 6) startDrag();
});

window.addEventListener('pointerup', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (dragging) { finishDrag(); swallowUntil = Date.now() + 350; }
  else if (press.armed) {
    const items = menuFor(press.el);
    if (items) openMenu(items, e.clientX, e.clientY);
    swallowUntil = Date.now() + 350;
  }
  endPress();
});
window.addEventListener('pointercancel', (e) => {
  if (!press || e.pointerId !== press.id) return;
  if (dragging) finishDrag();
  endPress();
});

function endPress() {
  if (!press) return;
  clearTimeout(press.timer);
  press.el.classList.remove('held');
  press = null;
}

// While holding or dragging on a phone, stop the page from scrolling instead.
document.addEventListener('touchmove', (e) => { if (press && (press.armed || dragging)) e.preventDefault(); }, { passive: false });

document.addEventListener('click', (e) => {
  if (Date.now() < swallowUntil) { swallowUntil = 0; e.stopPropagation(); e.preventDefault(); }
}, true);

document.addEventListener('contextmenu', (e) => {
  const el = pressTarget(e.target);
  if (!el) return;
  e.preventDefault();
  if (press && press.type !== 'mouse') return; // a long press is handled above
  const items = menuFor(el);
  if (items) openMenu(items, e.clientX, e.clientY);
});

function startDrag() {
  const li = press.el;
  const list = $('#feedList');
  dragging = { li, startOrder: listedFeedIds().join(',') };
  clearTimeout(press.timer);
  try { li.setPointerCapture(press.id); } catch { /* the pointer already ended */ }
  li.classList.remove('held');
  li.classList.add('dragging');
  list.classList.add('sorting');
  dragging.scroller = setInterval(autoScroll, 16);
}

function moveDragged(y) {
  const { li } = dragging;
  const prev = li.previousElementSibling, next = li.nextElementSibling;
  // Moves the neighbor rather than the dragged row, so the browser keeps
  // sending pointer events to the row being dragged.
  if (prev && y < prev.getBoundingClientRect().top + prev.offsetHeight / 2) li.parentNode.insertBefore(prev, li.nextSibling);
  else if (next && y > next.getBoundingClientRect().top + next.offsetHeight / 2) li.parentNode.insertBefore(next, li);
}

// Scrolls the feed list while a feed is held near its top or bottom edge.
function autoScroll() {
  if (!dragging || !press || press.lastY == null) return;
  const list = $('#feedList');
  const r = list.getBoundingClientRect();
  const edge = 44, y = press.lastY;
  let step = 0;
  if (y < r.top + edge) step = -Math.ceil((r.top + edge - y) / 4);
  else if (y > r.bottom - edge) step = Math.ceil((y - (r.bottom - edge)) / 4);
  if (step) { list.scrollTop += step; moveDragged(y); }
}

// The feed ids in the order shown, leaving out feeds that are still being added.
function listedFeedIds() {
  return [...$('#feedList').children].map((x) => x.dataset.feed).filter((id) => id && !addingFeeds.has(id));
}

function finishDrag() {
  const { li, startOrder, scroller } = dragging;
  clearInterval(scroller);
  li.classList.remove('dragging');
  $('#feedList').classList.remove('sorting');
  const ids = listedFeedIds();
  dragging = null;
  const moved = ids.join(',') !== startOrder;
  if (moved) {
    change({ op: 'order', ids });
    if (state.feedSort !== 'custom') change({ op: 'sort', sort: 'custom' });
  }
  if (feedsNeedRender || moved) { feedsNeedRender = false; renderFeeds(); }
}

// ---------- Column widths ----------
// Drag the space between two columns to resize them. Double-click it to go
// back to the normal width. Widths are saved per device.

const WIDTH_LIMITS = { w1: [180, 480], w2: [260, 760] };
const READ_MIN = 380;
let widths = readJSON('reader-widths', {});

// On a smaller window, saved widths shrink (without being saved) so the
// reading column keeps its room.
function applyWidths() {
  const layout = $('#layout');
  const shown = { ...widths };
  if (shown.w1 && shown.w2) {
    const room = layout.clientWidth - 4 * 14 - READ_MIN;
    const over = shown.w1 + shown.w2 - room;
    if (over > 0) {
      const cut2 = Math.min(over, shown.w2 - WIDTH_LIMITS.w2[0]);
      shown.w2 -= Math.max(0, cut2);
      shown.w1 -= Math.max(0, Math.min(over - Math.max(0, cut2), shown.w1 - WIDTH_LIMITS.w1[0]));
    }
  }
  for (const key of ['w1', 'w2']) {
    if (shown[key]) layout.style.setProperty('--' + key, shown[key] + 'px');
    else layout.style.removeProperty('--' + key);
  }
}
window.addEventListener('resize', () => applyWidths());
document.querySelectorAll('.gutter').forEach((g) => {
  const key = g.dataset.col;
  g.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    const col = key === 'w1' ? $('.feeds-col') : $('.posts-col');
    const start = col.getBoundingClientRect().width;
    const otherKey = key === 'w1' ? 'w2' : 'w1';
    const other = (key === 'w1' ? $('.posts-col') : $('.feeds-col')).getBoundingClientRect().width;
    const layoutWidth = $('#layout').clientWidth;
    const x0 = e.clientX;
    g.classList.add('active');
    document.body.classList.add('resizing');
    const move = (ev) => {
      const [min, max] = WIDTH_LIMITS[key];
      const room = layoutWidth - other - 4 * 14 - READ_MIN; // keep the reading column usable
      widths[key] = Math.round(Math.max(min, Math.min(max, room, start + ev.clientX - x0)));
      if (!widths[otherKey]) widths[otherKey] = Math.round(other);
      applyWidths();
    };
    const up = () => {
      g.removeEventListener('pointermove', move);
      g.removeEventListener('pointerup', up);
      g.removeEventListener('pointercancel', up);
      g.classList.remove('active');
      document.body.classList.remove('resizing');
      writeJSON('reader-widths', widths);
    };
    g.addEventListener('pointermove', move);
    g.addEventListener('pointerup', up);
    g.addEventListener('pointercancel', up);
  });
  g.addEventListener('dblclick', () => {
    widths = {};
    writeJSON('reader-widths', widths);
    applyWidths();
    toast('Columns are back to their normal widths.');
  });
});
applyWidths();

// ---------- Editing a feed ----------
// Changes are shown right away and kept here until the next update
// (about a minute later) includes them.

const feedEdits = new Map(); // feed id -> { title, url }

// Returns true if it changed anything shown.
function applyFeedEdits() {
  let changed = false;
  for (const [id, edit] of [...feedEdits]) {
    const f = feedsById.get(id);
    if (!f) continue;
    // Once an update made after the edit includes it, the edit is no longer needed.
    if (index.updated > edit.at && f.url === edit.url && f.title === edit.title) { feedEdits.delete(id); continue; }
    if (edit.title && f.title !== edit.title) { f.title = edit.title; changed = true; }
    if (f.url !== edit.url) { f.url = edit.url; f.error = ''; changed = true; }
  }
  return changed;
}

function editFeed(feed) {
  openModal({
    title: 'Rename or change address',
    body: `<div class="field"><label for="editName">Name</label><input id="editName" type="text" autocomplete="off" value="${esc(feed.title)}"></div>
      <div class="field"><label for="editUrl">Address</label><input id="editUrl" type="url" autocomplete="off" spellcheck="false" value="${esc(feed.url)}"></div>
      <p class="sub" style="font-size:13.5px;color:var(--muted)">Changing the address keeps your read posts and bookmarks. Changes show up fully after the next update, in a minute or two.</p>
      <div class="form-error" id="editError" hidden></div>`,
    actions: [
      { label: 'Cancel', onClick: closeModal },
      { label: 'Save changes', cls: 'primary', onClick: () => saveFeedEdit(feed) },
    ],
    onOpen: () => setTimeout(() => $('#editName').focus(), 50),
  });
  ['#editName', '#editUrl'].forEach((s) => $(s).addEventListener('keydown', (e) => { if (e.key === 'Enter') saveFeedEdit(feed); }));
}

async function saveFeedEdit(feed) {
  if ($('#modalActions .primary').disabled) return; // already saving
  const err = $('#editError');
  const title = $('#editName').value.trim();
  let url = $('#editUrl').value.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try { new URL(url); } catch { url = ''; }
  if (!title) { err.textContent = 'Give the feed a name.'; err.hidden = false; return; }
  if (!url || url === 'https://') { err.textContent = 'That doesn’t look like a web address.'; err.hidden = false; return; }
  if (title === feed.title && url === feed.url) { closeModal(); return; }
  const button = $('#modalActions .primary');
  busy(button, 'Saving…');
  try {
    const result = await editFeedsFile((data) => {
      const entry = data.feeds.find((f) => (f.id || '') === feed.id || f.url === feed.url);
      if (!entry) return 'missing';
      if (url !== entry.url && data.feeds.some((f) => f !== entry && f.url === url)) return 'duplicate';
      entry.title = title;
      if (url !== entry.url) {
        entry.id = feed.id; // keeps the same id, so read marks and bookmarks still match
        entry.url = url;
      }
    }, `Edit feed: ${title}`);
    if (result === 'duplicate') { err.textContent = 'Another feed in your list already uses that address.'; err.hidden = false; unbusy(button); return; }
    if (result === 'missing') { err.textContent = 'This feed couldn’t be found in your list. Press the refresh button at the top and try again.'; err.hidden = false; unbusy(button); return; }
    feedEdits.set(feed.id, { title, url, at: nowSec() });
    applyFeedEdits();
    closeModal();
    toast('Feed saved.');
    fastCheckUntil = Date.now() + 6 * 60e3;
    renderAll();
  } catch (e) {
    err.textContent = e.status === 401 || e.status === 403 || e.status === 404
      ? 'Your access key can’t change files in the repo. Use Change access key to fix it.'
      : 'The feed couldn’t be saved. Check your internet connection and try again.';
    err.hidden = false;
    unbusy(button);
  }
}

// ---------- Keeping up to date ----------

let lastPostsCheck = 0, lastStateCheck = 0;
function checkForUpdates(force) {
  if (document.hidden) return;
  const now = Date.now();
  const postsEvery = now < fastCheckUntil ? 30e3 : CHECK_POSTS_EVERY;
  if (force || now - lastPostsCheck > postsEvery) { lastPostsCheck = now; loadPosts(); }
  if ((force || now - lastStateCheck > CHECK_STATE_EVERY) && !saving && !pending.length) { lastStateCheck = now; loadState(); }
}
setInterval(() => checkForUpdates(false), 15e3);
setInterval(showUpdated, 60e3);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (pending.length) { clearTimeout(saveTimer); saveNow(); } }
  else checkForUpdates(true);
});

// ---------- Start ----------

// The service worker is what lets Chrome install the reader as an app.
if ('serviceWorker' in navigator) navigator.serviceWorker.register('Service%20Worker.js').catch(() => {});

renderAll();
if (!REPO) {
  $('#postsEmpty').hidden = false;
  $('#postsEmpty').textContent = 'Open the reader from its GitHub Pages address to use it.';
} else {
  lastPostsCheck = lastStateCheck = Date.now();
  loadPosts();
  if (token) { loadState(); if (pending.length) scheduleSave(1000); }
  else showKeySetup();
}
