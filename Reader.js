'use strict';

/* Mindy's Reader
   Posts come from data/index.json, which GitHub Actions rebuilds every 30
   minutes. Reading progress and bookmarks are saved to State.json in the
   GitHub repo (and each bookmarked post's text to Bookmarks/<id>.html),
   using the access key saved in this browser, so every device shows the same
   thing. */

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
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }

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
      Accept: 'application/vnd.github+json',
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
  try {
    for (let attempt = 0; attempt < 4 && pending.length; attempt++) {
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
        if (err.status === 409 || err.status === 422) { // another device saved first: reload and try again
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          continue;
        }
        throw err;
      }
      pending.splice(0, batch.length);
      writeJSON('reader-pending', pending);
      saved = next;
      writeJSON('reader-saved', saved);
    }
    syncStatus = pending.length ? 'error' : 'ok';
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
  try {
    const remote = await getFile('State.json');
    saved = remote ? JSON.parse(remote.text) : emptyState();
    saved.read = saved.read || {};
    saved.bookmarks = saved.bookmarks || {};
    writeJSON('reader-saved', saved);
    state = applyAll(saved, pending);
    if (syncStatus === 'denied') syncStatus = 'ok';
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
  const btn = $('#refreshBtn');
  btn.classList.add('spinning');
  try {
    const res = await fetch(`data/index.json?t=${Date.now()}`, { cache: 'no-store' });
    if (res.status === 404) throw new Error('first');
    if (!res.ok) throw new Error(res.statusText);
    const data = await res.json();
    if (!index || data.updated !== index.updated) {
      index = data;
      feedsById = new Map(index.feeds.map((f) => [f.id, f]));
      postsById = new Map(index.posts.map((p) => [p.id, p]));
      contentCache.clear();
      for (const id of [...addingFeeds.keys()]) if (index.feeds.some((f) => f.url === addingFeeds.get(id).url)) addingFeeds.delete(id);
      for (const url of [...removingFeeds]) if (!index.feeds.some((f) => f.url === url)) removingFeeds.delete(url);
    }
    applyFeedEdits();
    postsLoadError = '';
  } catch (err) {
    postsLoadError = err.message === 'first'
      ? 'No posts yet. The first update runs a few minutes after setup, so check back soon.'
      : 'The posts couldn’t be loaded. Check your internet connection, then press the refresh button at the top.';
  }
  btn.classList.remove('spinning');
  renderAll();
}

async function postContent(post) {
  if (postsById.has(post.id)) {
    const prefix = post.id.slice(0, 2);
    if (!contentCache.has(prefix)) {
      const res = await fetch(`data/content/${prefix}.json?v=${index.updated}`);
      if (!res.ok) throw new Error('content');
      contentCache.set(prefix, await res.json());
    }
    const html = contentCache.get(prefix)[post.id];
    if (html != null) return html;
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

function visibleFeeds() {
  const list = (index ? index.feeds.filter((f) => !removingFeeds.has(f.url)) : []).concat([...addingFeeds.values()]);
  const byName = (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base' });
  const sort = state.feedSort || 'az';
  if (sort === 'za') return list.sort((a, b) => byName(b, a));
  if (sort === 'most' || sort === 'fewest') {
    const n = new Map(list.map((f) => [f.id, unreadCount(f.id)]));
    return list.sort((a, b) => (sort === 'most' ? n.get(b.id) - n.get(a.id) : n.get(a.id) - n.get(b.id)) || byName(a, b));
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
function unreadCount(feedId) {
  let n = 0;
  for (const p of livePosts()) if ((!feedId || p.feed === feedId) && !isRead(p.id)) n++;
  return n;
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
  $('#updated').textContent = index ? 'Updated ' + ago(index.updated) + (nowSec() - index.updated < 60 ? '' : ' ago') : '';
}

function renderFeeds() {
  if (dragging) { feedsNeedRender = true; return; }
  $('#feedSort').value = state.feedSort || 'az';
  const total = unreadCount();
  document.querySelector('[data-count="all"]').textContent = '';
  document.querySelector('[data-count="unread"]').textContent = total || '';
  document.querySelector('[data-count="bookmarks"]').textContent = Object.keys(state.bookmarks).length || '';
  document.querySelectorAll('.view-btn').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  const list = visibleFeeds().map((f) => {
    const n = addingFeeds.has(f.id) ? 0 : unreadCount(f.id);
    const warn = f.error ? `<span class="warn-dot" title="${esc(f.error)}">!</span>` : '';
    const extra = addingFeeds.has(f.id) ? '<span class="count">adding…</span>' : `<span class="count">${n || ''}</span>`;
    return `<li data-feed="${esc(f.id)}"><span class="grip" title="Drag to move" aria-hidden="true"><svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg></span><button class="feed-item${view === 'feed:' + f.id ? ' active' : ''}${n ? ' has-unread' : ''}" data-feed="${esc(f.id)}">
      ${faviconHTML(f)}<span class="nm">${esc(f.title)}</span>${warn}${extra}</button></li>`;
  });
  $('#feedList').innerHTML = list.join('') || '<li class="empty">No feeds yet.</li>';
}

function postRowHTML(p) {
  const f = feedOf(p);
  const cls = view === 'bookmarks' ? '' : isRead(p.id) ? ' read' : ' unread';
  const bm = state.bookmarks[p.id] && view !== 'bookmarks'
    ? '<svg class="bm" viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg>' : '';
  const thumb = p.image ? `<img class="thumb" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '';
  return `<li class="post${cls}${current && current.id === p.id ? ' active' : ''}" data-id="${esc(p.id)}">
    <div class="txt"><div class="t">${esc(p.title)}</div>${p.summary ? `<div class="s">${esc(p.summary)}</div>` : ''}
    <div class="m">${faviconHTML(f)}<span class="fname">${esc(f.title)}</span><span>· ${ago(p.date)}</span>${bm}</div></div>${thumb}</li>`;
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
  $('#removeFeedBtn').hidden = $('#editFeedBtn').hidden = !isFeed || addingFeeds.has(view.slice(5));

  const problem = $('#feedProblem');
  if (feed && feed.error) {
    const last = feed.lastSuccess ? ` It last worked ${ago(feed.lastSuccess)}${nowSec() - feed.lastSuccess < 7 * 86400 ? ' ago' : ''}.` : ' It hasn’t worked yet.';
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
      : view === 'bookmarks' ? '<div class="big"><svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4.5L6 21z"/></svg></div>No bookmarks yet. Open a post and press Bookmark to save it here.'
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
  if (current.link) { openBtn.href = current.link; openBtn.removeAttribute('aria-disabled'); }
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

  const frame = $('#readerFrame');
  $('#readerEmpty').hidden = true;
  frame.hidden = false;
  const myOpen = ++openToken;
  frame.srcdoc = frameHTML(post, '<p class="note">Loading…</p>');
  let body;
  try { body = await postContent(post); }
  catch { body = '<p class="note">This post’s text couldn’t be loaded. Press Open original to read it on the website.</p>'; }
  if (myOpen !== openToken) return;
  if (!body.trim()) body = '<p class="note">This feed doesn’t include the post’s text. Press Open original to read it on the website.</p>';
  frame.srcdoc = frameHTML(post, body);
}

function frameHTML(post, body) {
  const f = feedOf(post);
  const meta = [f.title, post.author, fullDate(post.date)].filter(Boolean).map((t) => `<span>${esc(t)}</span>`).join('');
  const title = post.link ? `<a class="title" href="${esc(post.link)}">${esc(post.title)}</a>` : `<div class="title">${esc(post.title)}</div>`;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><base target="_blank"><meta name="referrer" content="no-referrer">
    <meta name="viewport" content="width=device-width, initial-scale=1"><style>${FRAME_CSS}</style></head>
    <body><article>${title}<div class="meta">${meta}</div>${body}</article></body></html>`;
}

function closeReader() {
  current = null;
  openToken++;
  $('#readerFrame').hidden = true;
  $('#readerFrame').srcdoc = '';
  $('#readerEmpty').hidden = false;
  document.querySelectorAll('.post.active').forEach((r) => r.classList.remove('active'));
  renderReaderBar();
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

// ---------- Actions ----------

document.querySelector('.views').addEventListener('click', (e) => {
  const b = e.target.closest('.view-btn');
  if (b) setView(b.dataset.view);
});
$('#feedList').addEventListener('click', (e) => {
  const b = e.target.closest('.feed-item');
  if (b) setView('feed:' + b.dataset.feed);
});
$('#postList').addEventListener('click', (e) => {
  const row = e.target.closest('.post');
  if (row) openPost(row.dataset.id);
});
document.querySelectorAll('[data-back]').forEach((b) => b.addEventListener('click', () => history.back()));

$('#markAllBtn').addEventListener('click', () => {
  const ids = postsForView().filter((p) => !isRead(p.id)).map((p) => p.id);
  if (!ids.length) return;
  change({ op: 'read', ids });
  keepVisible = new Set();
  renderAll();
  toast(`Marked ${ids.length} ${ids.length === 1 ? 'post' : 'posts'} as read.`, () => {
    change({ op: 'unread', ids });
    renderAll();
  });
});

$('#readBtn').addEventListener('click', () => {
  if (!current) return;
  const id = current.id;
  if (isRead(id)) change({ op: 'unread', ids: [id] });
  else change({ op: 'read', ids: [id] });
  if (view === 'unread') keepVisible.add(id);
  refreshRow(id);
  refreshCounts();
  renderReaderBar();
});

$('#bookmarkBtn').addEventListener('click', async () => {
  if (!current) return;
  const post = current;
  if (state.bookmarks[post.id]) {
    change({ op: 'unbookmark', id: post.id });
    toast('Bookmark removed.', () => { addBookmark(post); });
  } else {
    await addBookmark(post);
  }
  if (view === 'bookmarks') renderPosts(); else refreshRow(post.id);
  refreshCounts();
  renderReaderBar();
});

async function addBookmark(post) {
  let html = '';
  try { html = await postContent(post); } catch { /* the text couldn't be loaded; the bookmark still works with Open original */ }
  const f = feedOf(post);
  const copy = {
    id: post.id, feed: post.feed, feedTitle: f.title, feedSite: f.site || f.url || '',
    title: post.title, link: post.link, author: post.author || '', date: post.date,
    summary: post.summary || '', image: post.image || '', saved: nowSec(),
  };
  change({ op: 'bookmark', post: copy, html });
  if (view === 'bookmarks') renderPosts(); else refreshRow(post.id);
  refreshCounts();
  renderReaderBar();
}

$('#refreshBtn').addEventListener('click', () => { loadPosts(); loadState(); });

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

function openModal({ title, body, actions, onOpen }) {
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
  $('.sheet').classList.toggle('setup', !!onOpen && title.includes('access key'));
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
        <li>Under <b>Permissions</b>, click <b>Add permissions</b>, pick <b>Contents</b>, then change it from <b>Read-only</b> to <b>Read and write</b>.</li>
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
  });
  $('#keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') saveKey(); });
}

async function saveKey() {
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

$('#removeFeedBtn').addEventListener('click', () => {
  const feed = feedsById.get(view.slice(5));
  if (!feed) return;
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
            setView('all', { push: false });
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
});

// ---------- Sorting feeds ----------

$('#feedSort').addEventListener('change', (e) => {
  const sort = e.target.value;
  // Switching to custom order for the first time starts from the order shown now.
  if (sort === 'custom' && !(state.feedOrder || []).length) change({ op: 'order', ids: visibleFeeds().map((f) => f.id) });
  change({ op: 'sort', sort });
  renderFeeds();
});

// Dragging a feed by its handle. Uses pointer events so it works with a
// mouse and with a finger. Dropping switches the list to custom order.
let dragging = null;
let feedsNeedRender = false;

$('#feedList').addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || e.button > 0) return;
  e.preventDefault();
  const li = grip.closest('li');
  const list = $('#feedList');
  dragging = { li, pointerId: e.pointerId, startOrder: [...list.children].map((x) => x.dataset.feed).join(','), lastY: e.clientY };
  grip.setPointerCapture(e.pointerId);
  li.classList.add('dragging');
  list.classList.add('sorting');
  dragging.scroller = setInterval(autoScroll, 16);
});

function moveDragged(y) {
  const { li } = dragging;
  const prev = li.previousElementSibling, next = li.nextElementSibling;
  // Moves the neighbor rather than the dragged row, so the browser keeps
  // sending pointer events to the row being dragged.
  if (prev && y < prev.getBoundingClientRect().top + prev.offsetHeight / 2) li.parentNode.insertBefore(prev, li.nextSibling);
  else if (next && y > next.getBoundingClientRect().top + next.offsetHeight / 2) li.parentNode.insertBefore(next, li);
}

// Scrolls the feed list while you hold a feed near its top or bottom edge.
function autoScroll() {
  if (!dragging) return;
  const list = $('#feedList');
  const r = list.getBoundingClientRect();
  const edge = 44, y = dragging.lastY;
  let step = 0;
  if (y < r.top + edge) step = -Math.ceil((r.top + edge - y) / 4);
  else if (y > r.bottom - edge) step = Math.ceil((y - (r.bottom - edge)) / 4);
  if (step) { list.scrollTop += step; moveDragged(y); }
}

window.addEventListener('pointermove', (e) => {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  dragging.lastY = e.clientY;
  moveDragged(e.clientY);
});

function endDrag(e) {
  if (!dragging || e.pointerId !== dragging.pointerId) return;
  const { li, startOrder, scroller } = dragging;
  clearInterval(scroller);
  li.classList.remove('dragging');
  $('#feedList').classList.remove('sorting');
  const ids = [...$('#feedList').children].map((x) => x.dataset.feed).filter(Boolean);
  dragging = null;
  if (ids.join(',') !== startOrder) {
    change({ op: 'order', ids });
    if (state.feedSort !== 'custom') change({ op: 'sort', sort: 'custom' });
  }
  if (feedsNeedRender || ids.join(',') !== startOrder) { feedsNeedRender = false; renderFeeds(); }
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

// ---------- Editing a feed ----------
// Changes are shown right away and kept here until the next update
// (about a minute later) includes them.

const feedEdits = new Map(); // feed id -> { title, url }

function applyFeedEdits() {
  for (const [id, edit] of [...feedEdits]) {
    const f = feedsById.get(id);
    if (!f) continue;
    if (f.url === edit.url && (!edit.title || f.title === edit.title) && f.lastSuccess > edit.at) { feedEdits.delete(id); continue; }
    if (edit.title) f.title = edit.title;
    if (f.url !== edit.url) { f.url = edit.url; f.error = ''; }
  }
}

$('#editFeedBtn').addEventListener('click', () => {
  const feed = feedsById.get(view.slice(5));
  if (!feed) return;
  openModal({
    title: 'Edit feed',
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
});

async function saveFeedEdit(feed) {
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
setInterval(() => { if (index) $('#updated').textContent = 'Updated ' + ago(index.updated) + (nowSec() - index.updated < 60 ? '' : ' ago'); }, 60e3);
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
