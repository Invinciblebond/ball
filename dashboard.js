/* ══════════════════════════════════════════════════════════════
   Urlsify dashboard
   The public shortener at / never touches this file.
   ══════════════════════════════════════════════════════════════ */

const CFG = window.URLSIFY_CONFIG;
const $ = (id) => document.getElementById(id);

let sb = null;             // supabase client
let user = null;           // current user
let links = [];            // library, newest first
let dbReady = false;       // is the `links` table reachable
let queue = [];            // mass-create rows
let running = false, paused = false, aborted = false;

/* ── tiny helpers ─────────────────────────────────────────── */
function isValidUrl(str) {
  if (!str || /\s/.test(str)) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(str) ? str : 'https://' + str);
    return u.hostname.includes('.') && !u.hostname.endsWith('.');
  } catch { return false; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(msg, kind) {
  const t = document.createElement('div');
  t.className = 'toast ' + (kind || '');
  t.textContent = msg;
  $('toasts').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(18px)'; }, 3400);
  setTimeout(() => t.remove(), 3800);
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d)) return '—';
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' });
}

function fmtExpiry(iso) {
  if (!iso) return { text: 'never', cls: 'exp-far' };
  const ms = new Date(iso) - Date.now();
  if (isNaN(ms)) return { text: '—', cls: 'exp-far' };
  if (ms <= 0) return { text: 'expired', cls: 'exp-dead' };
  const days = ms / 86400000;
  if (days < 1) return { text: Math.max(1, Math.round(ms / 3600000)) + 'h left', cls: 'exp-soon' };
  if (days < 30) return { text: Math.round(days) + 'd left', cls: days < 7 ? 'exp-soon' : 'exp-far' };
  if (days < 365) return { text: Math.round(days / 30) + 'mo left', cls: 'exp-far' };
  return { text: (days / 365).toFixed(1) + 'y left', cls: 'exp-far' };
}

function shortUrl(code) { return CFG.SITE_URL.replace(/^https?:\/\//, '') + '/' + code; }

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    toast((label || 'Copied') + ' to clipboard', 'ok');
  } catch {
    toast('Clipboard blocked by the browser', 'err');
  }
}

/* ── auth headers for worker calls ────────────────────────── */
async function authHeaders() {
  const h = { 'Content-Type': 'application/json' };
  if (sb) {
    const { data } = await sb.auth.getSession();
    if (data && data.session) h.Authorization = 'Bearer ' + data.session.access_token;
  }
  return h;
}

/* ══ BOOT ══════════════════════════════════════════════════ */
(async function boot() {
  try {
    sb = await window.getSupabase();
  } catch {
    document.body.innerHTML =
      '<div style="display:grid;place-items:center;min-height:100dvh;padding:2rem;text-align:center;font-family:Sora,sans-serif;color:#f2f1fa">' +
      '<div><h1>Cannot reach the account service</h1>' +
      '<p style="color:#8a88a3;margin-top:.6rem">The free shortener is unaffected — <a style="color:#34d2ff" href="/">go back</a>.</p></div></div>';
    return;
  }

  const { data } = await sb.auth.getSession();
  if (!data || !data.session) {
    location.replace('/auth.html?mode=login&next=' + encodeURIComponent(location.pathname));
    return;
  }
  user = data.session.user;

  sb.auth.onAuthStateChange((event) => {
    if (event === 'SIGNED_OUT') location.replace('/');
  });

  paintUser();
  loadDefaults();
  wireNav();
  wireInputs();
  await loadLinks();
  routeFromHash();
})();

function paintUser() {
  const email = user.email || 'account';
  $('userEmail').textContent = email;
  $('avatar').textContent = email.slice(0, 1).toUpperCase();
  $('setEmail').textContent = email;
  $('setSince').textContent = fmtDate(user.created_at);
}

/* ══ NAVIGATION ════════════════════════════════════════════ */
const VIEW_META = {
  overview:  ['Overview', 'your links at a glance'],
  links:     ['My links', 'library and management'],
  mass:      ['Mass create', 'bulk link generation'],
  analytics: ['Analytics', 'aggregated click data'],
  settings:  ['Settings', 'account and defaults']
};

function wireNav() {
  document.querySelectorAll('.nav-item[data-view]').forEach((btn) => {
    btn.addEventListener('click', () => go(btn.dataset.view));
  });
  window.addEventListener('hashchange', routeFromHash);
}

function routeFromHash() {
  const v = (location.hash || '').replace('#', '');
  go(VIEW_META[v] ? v : 'overview', true);
}

function go(view, skipHash) {
  if (!VIEW_META[view]) view = 'overview';
  document.querySelectorAll('.view').forEach((s) => s.classList.remove('active'));
  const el = $('view-' + view);
  if (el) el.classList.add('active');
  document.querySelectorAll('.nav-item[data-view]').forEach((b) =>
    b.classList.toggle('active', b.dataset.view === view));
  $('crumbTitle').textContent = VIEW_META[view][0];
  $('crumbSub').textContent = VIEW_META[view][1];
  if (!skipHash) location.hash = view;
  toggleSidebar(false);
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (view === 'analytics') renderAnalytics();
}

function toggleSidebar(force) {
  const sb_ = $('sidebar'), scrim = $('scrim');
  const open = force === undefined ? !sb_.classList.contains('open') : force;
  sb_.classList.toggle('open', open);
  scrim.classList.toggle('show', open);
}

async function signOut() {
  if (sb) await sb.auth.signOut();
  location.replace('/');
}

async function sendPasswordReset() {
  try {
    const { error } = await sb.auth.resetPasswordForEmail(user.email, {
      redirectTo: CFG.SITE_URL + '/auth.html?mode=login'
    });
    if (error) throw error;
    toast('Reset link sent to ' + user.email, 'ok');
  } catch (e) {
    toast(e.message || 'Could not send reset link', 'err');
  }
}

/* ══ LIBRARY STORAGE ═══════════════════════════════════════
   Supabase `links` table is the store. If it is missing (schema
   not applied yet) we fall back to this device's localStorage so
   nothing a user creates is ever lost.
   ═══════════════════════════════════════════════════════════ */
const LS_KEY = () => 'urlsify:links:' + (user ? user.id : 'anon');

function lsRead() {
  try { return JSON.parse(localStorage.getItem(LS_KEY()) || '[]'); } catch { return []; }
}
function lsWrite() {
  try { localStorage.setItem(LS_KEY(), JSON.stringify(links)); } catch {}
}

async function loadLinks() {
  try {
    const { data, error } = await sb
      .from('links')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) throw error;
    dbReady = true;
    links = data || [];
  } catch (e) {
    dbReady = false;
    links = lsRead();
    console.warn('links table unavailable, using local storage:', e.message || e);
  }
  afterLinksChange();
}

async function saveLink(row) {
  links.unshift(row);
  afterLinksChange();
  if (!dbReady) return lsWrite();
  try {
    const { error } = await sb.from('links').insert({
      user_id: user.id,
      code: row.code,
      destination: row.destination,
      tag: row.tag || null,
      clicks: row.clicks || 0,
      expires_at: row.expires_at || null
    });
    if (error) throw error;
  } catch (e) {
    console.warn('insert failed, mirroring locally:', e.message || e);
    dbReady = false;
    lsWrite();
  }
}

async function patchLink(code, patch) {
  const row = links.find((l) => l.code === code);
  if (row) Object.assign(row, patch);
  afterLinksChange();
  if (!dbReady) return lsWrite();
  try {
    await sb.from('links').update(patch).eq('code', code).eq('user_id', user.id);
  } catch (e) { console.warn('update failed:', e.message || e); }
}

async function dropLink(code) {
  links = links.filter((l) => l.code !== code);
  afterLinksChange();
  if (!dbReady) return lsWrite();
  try {
    await sb.from('links').delete().eq('code', code).eq('user_id', user.id);
  } catch (e) { console.warn('delete failed:', e.message || e); }
}

function afterLinksChange() {
  if (!dbReady) lsWrite();
  $('navLinkCount').textContent = links.length;
  syncTagOptions();
  renderLinks();
  renderOverview();
}

function syncTagOptions() {
  const tags = [...new Set(links.map((l) => l.tag).filter(Boolean))].sort();
  ['tagFilter', 'analyticsTag'].forEach((id) => {
    const sel = $(id);
    if (!sel) return;
    const keep = sel.value;
    sel.innerHTML = '<option value="">All campaigns</option>' +
      tags.map((t) => '<option value="' + esc(t) + '">' + esc(t) + '</option>').join('');
    if (tags.includes(keep)) sel.value = keep;
  });
}

/* ══ OVERVIEW ══════════════════════════════════════════════ */
function renderOverview() {
  const total = links.reduce((s, l) => s + (l.clicks || 0), 0);
  $('statLinks').textContent = links.length;
  $('statClicks').textContent = total.toLocaleString();
  $('statBatches').textContent = Number(localStorage.getItem('urlsify:batches') || 0);
  $('statLinksDelta').textContent = links.length
    ? 'newest ' + fmtDate(links[0].created_at)
    : 'nothing yet';

  const best = [...links].sort((a, b) => (b.clicks || 0) - (a.clicks || 0))[0];
  $('statBest').textContent = best && best.clicks ? '/' + best.code : '—';
  $('statBestClicks').textContent = best && best.clicks
    ? best.clicks.toLocaleString() + ' clicks'
    : 'no data yet';

  const recent = links.slice(0, 10);
  $('recentWrap').innerHTML = recent.length
    ? '<div class="table-scroll"><table class="data" style="min-width:520px;"><thead><tr>' +
      '<th>Short link</th><th>Destination</th><th>Clicks</th><th>Created</th></tr></thead><tbody>' +
      recent.map((l) =>
        '<tr><td class="cell-mono"><a href="https://' + esc(shortUrl(l.code)) + '" target="_blank" rel="noopener">' +
        esc(shortUrl(l.code)) + '</a></td>' +
        '<td class="cell-trunc" title="' + esc(l.destination) + '">' + esc(l.destination) + '</td>' +
        '<td class="cell-mono">' + (l.clicks || 0) + '</td>' +
        '<td class="cell-mono" style="color:var(--muted)">' + fmtDate(l.created_at) + '</td></tr>'
      ).join('') + '</tbody></table></div>'
    : '<div class="empty" style="padding:2rem 1rem"><div class="empty-title">Nothing here yet</div>' +
      '<div class="empty-desc">Links you create while signed in show up here.</div></div>';
}

async function quickShorten() {
  const urlEl = $('quickUrl'), slugEl = $('quickSlug'), btn = $('quickBtn');
  const err = $('quickError'), ok = $('quickOk');
  err.classList.remove('show'); ok.classList.remove('show');

  let val = urlEl.value.trim();
  if (!val) { err.textContent = 'Paste a link first.'; err.classList.add('show'); return; }
  if (!isValidUrl(val)) {
    err.textContent = 'That does not look like a valid URL.'; err.classList.add('show'); return;
  }
  if (!/^https?:\/\//i.test(val)) val = 'https://' + val;

  const ttl = parseInt($('quickExpiry').value, 10);
  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    const row = await createLink(val, slugEl.value.trim().toLowerCase(), ttl, $('defTag').value.trim());
    ok.innerHTML = 'Created <strong>' + esc(shortUrl(row.code)) + '</strong> — saved to your library.';
    ok.classList.add('show');
    urlEl.value = ''; slugEl.value = '';
  } catch (e) {
    err.textContent = e.message || 'Could not create that link.';
    err.classList.add('show');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* ── the single call every creation path goes through ── */
async function createLink(url, slug, ttlSeconds, tag) {
  const body = { url };
  if (slug) body.slug = slug;
  if (ttlSeconds) body.ttl = ttlSeconds;
  if (tag) body.tag = tag;

  const res = await fetch(CFG.DASH_BASE + '/shorten', {
    method: 'POST',
    headers: await authHeaders(),
    body: JSON.stringify(body)
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error);

  const row = {
    code: data.code,
    destination: url,
    tag: tag || null,
    clicks: 0,
    expires_at: data.expiresAt
      || new Date(Date.now() + (ttlSeconds || 31536000) * 1000).toISOString(),
    created_at: new Date().toISOString()
  };
  await saveLink(row);
  return row;
}

/* ══ LINKS LIBRARY ═════════════════════════════════════════ */
function visibleLinks() {
  const q = ($('linksSearch').value || '').trim().toLowerCase();
  const tag = $('tagFilter').value;
  const sort = $('linksSort').value;

  let out = links.filter((l) => {
    if (tag && l.tag !== tag) return false;
    if (!q) return true;
    return (l.code + ' ' + (l.destination || '') + ' ' + (l.tag || '')).toLowerCase().includes(q);
  });

  if (sort === 'old') out = out.slice().reverse();
  else if (sort === 'clicks') out = out.slice().sort((a, b) => (b.clicks || 0) - (a.clicks || 0));
  else if (sort === 'expiry') out = out.slice().sort((a, b) =>
    new Date(a.expires_at || 8e15) - new Date(b.expires_at || 8e15));
  return out;
}

function renderLinks() {
  const body = $('linksBody'), empty = $('linksEmpty'), table = $('linksTable');
  if (!body) return;
  const rows = visibleLinks();

  $('linksCount').textContent = rows.length === links.length
    ? links.length + ' link' + (links.length === 1 ? '' : 's')
    : rows.length + ' of ' + links.length;

  if (!rows.length) {
    body.innerHTML = '';
    table.style.display = 'none';
    empty.style.display = 'block';
    if (links.length) {
      empty.querySelector('.empty-title').textContent = 'No matches';
      empty.querySelector('.empty-desc').textContent = 'Nothing in your library matches that filter.';
    }
    return;
  }

  table.style.display = '';
  empty.style.display = 'none';

  body.innerHTML = rows.map((l) => {
    const exp = fmtExpiry(l.expires_at);
    const su = shortUrl(l.code);
    return '' +
      '<tr data-row="' + esc(l.code) + '">' +
        '<td><button class="expander" onclick="toggleManage(\'' + esc(l.code) + '\')" aria-label="Manage link">' +
          '<svg viewBox="0 0 24 24"><path d="M9 6l6 6-6 6"/></svg></button></td>' +
        '<td class="cell-mono"><a href="https://' + esc(su) + '" target="_blank" rel="noopener">' + esc(su) + '</a></td>' +
        '<td class="cell-trunc" title="' + esc(l.destination) + '">' + esc(l.destination) + '</td>' +
        '<td>' + (l.tag ? '<span class="pill">' + esc(l.tag) + '</span>' : '<span style="color:var(--muted)">—</span>') + '</td>' +
        '<td><span class="click-cell">' +
          '<span class="click-num" id="clicks-' + esc(l.code) + '">' + (l.clicks || 0) + '</span>' +
          '<button class="mini-btn" id="refresh-' + esc(l.code) + '" title="Refresh click count" ' +
            'onclick="refreshOne(\'' + esc(l.code) + '\')">' +
            '<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg></button>' +
        '</span></td>' +
        '<td class="cell-mono ' + exp.cls + '">' + exp.text + '</td>' +
        '<td class="cell-mono" style="color:var(--muted)">' + fmtDate(l.created_at) + '</td>' +
        '<td><div class="row-actions">' +
          '<button class="btn btn-sm btn-ghost" onclick="copy(\'https://' + esc(su) + '\',\'Link\')">Copy</button>' +
        '</div></td>' +
      '</tr>';
  }).join('');
}

function toggleManage(code) {
  const tr = document.querySelector('tr[data-row="' + CSS.escape(code) + '"]');
  if (!tr) return;
  const btn = tr.querySelector('.expander');
  const existing = tr.nextElementSibling;

  if (existing && existing.classList.contains('manage-row')) {
    existing.remove();
    btn.classList.remove('open');
    return;
  }
  document.querySelectorAll('tr.manage-row').forEach((r) => r.remove());
  document.querySelectorAll('.expander.open').forEach((b) => b.classList.remove('open'));
  btn.classList.add('open');

  const l = links.find((x) => x.code === code);
  if (!l) return;
  const su = shortUrl(l.code);

  const row = document.createElement('tr');
  row.className = 'manage-row';
  row.innerHTML =
    '<td colspan="8"><div class="manage-inner">' +

      '<div>' +
        '<div class="manage-section-label">Destination</div>' +
        '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;">' +
          '<input class="input input-mono" id="edit-dest-' + esc(code) + '" value="' + esc(l.destination) + '" style="flex:1;min-width:220px;" spellcheck="false" />' +
          '<button class="btn btn-sm btn-primary" onclick="saveDestination(\'' + esc(code) + '\')">Save</button>' +
        '</div>' +

        '<div class="manage-section-label">Expiry</div>' +
        '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;margin-bottom:1rem;">' +
          '<select class="select" id="edit-ttl-' + esc(code) + '" style="flex:1;min-width:180px;">' +
            '<option value="">Keep current</option>' +
            '<option value="3600">1 hour from now</option>' +
            '<option value="86400">24 hours from now</option>' +
            '<option value="604800">7 days from now</option>' +
            '<option value="2592000">30 days from now</option>' +
            '<option value="7776000">90 days from now</option>' +
            '<option value="31536000">1 year from now</option>' +
            '<option value="63072000">2 years from now</option>' +
          '</select>' +
          '<button class="btn btn-sm" onclick="saveExpiry(\'' + esc(code) + '\')">Update</button>' +
        '</div>' +

        '<div class="manage-section-label">Campaign tag</div>' +
        '<div style="display:flex;gap:0.5rem;flex-wrap:wrap;">' +
          '<input class="input" id="edit-tag-' + esc(code) + '" value="' + esc(l.tag || '') + '" placeholder="none" style="flex:1;min-width:180px;" maxlength="40" />' +
          '<button class="btn btn-sm" onclick="saveTag(\'' + esc(code) + '\')">Save tag</button>' +
        '</div>' +
      '</div>' +

      '<div>' +
        '<div class="manage-section-label">Actions</div>' +
        '<div class="manage-actions">' +
          '<button class="btn btn-sm" onclick="copy(\'https://' + esc(su) + '\',\'Link\')">Copy link</button>' +
          '<button class="btn btn-sm" onclick="window.open(\'https://' + esc(su) + '\',\'_blank\',\'noopener\')">Open ↗</button>' +
          '<button class="btn btn-sm" onclick="showQr(\'' + esc(code) + '\')">QR code</button>' +
          '<button class="btn btn-sm" onclick="openDetail(\'' + esc(code) + '\')">Full stats</button>' +
          '<button class="btn btn-sm btn-danger" onclick="removeLink(\'' + esc(code) + '\')">Delete</button>' +
        '</div>' +
        '<div class="qr-box" id="qr-' + esc(code) + '"></div>' +

        '<div class="manage-section-label" style="margin-top:1.1rem;">Details</div>' +
        '<div class="manage-meta">' +
          '<div><span>Slug</span><span>/' + esc(l.code) + '</span></div>' +
          '<div><span>Clicks</span><span>' + (l.clicks || 0) + '</span></div>' +
          '<div><span>Created</span><span>' + fmtDate(l.created_at) + '</span></div>' +
          '<div><span>Expires</span><span>' + (l.expires_at ? fmtDate(l.expires_at) : 'never') + '</span></div>' +
        '</div>' +
      '</div>' +

    '</div></td>';
  tr.after(row);
}

async function saveDestination(code) {
  const el = $('edit-dest-' + code);
  let val = el.value.trim();
  if (!val) return toast('Destination cannot be empty', 'err');
  if (!isValidUrl(val)) return toast('That is not a valid URL', 'err');
  if (!/^https?:\/\//i.test(val)) val = 'https://' + val;

  try {
    const res = await fetch(CFG.DASH_BASE + '/links/' + encodeURIComponent(code), {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({ url: val })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await patchLink(code, { destination: val });
    toast('Destination updated', 'ok');
    toggleManage(code);
  } catch (e) {
    toast(e.message || 'Could not update the destination', 'err');
  }
}

async function saveExpiry(code) {
  const ttl = parseInt($('edit-ttl-' + code).value, 10);
  if (!ttl) return toast('Pick a new expiry first', 'err');
  try {
    const res = await fetch(CFG.DASH_BASE + '/links/' + encodeURIComponent(code), {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({ ttl })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    await patchLink(code, { expires_at: new Date(Date.now() + ttl * 1000).toISOString() });
    toast('Expiry updated', 'ok');
    toggleManage(code);
  } catch (e) {
    toast(e.message || 'Could not update the expiry', 'err');
  }
}

async function saveTag(code) {
  const tag = $('edit-tag-' + code).value.trim();
  await patchLink(code, { tag: tag || null });

  // Mirror onto the worker's recovery index. Supabase is the library
  // of record, so a failure here is not worth interrupting the user.
  try {
    await fetch(CFG.DASH_BASE + '/links/' + encodeURIComponent(code), {
      method: 'PATCH',
      headers: await authHeaders(),
      body: JSON.stringify({ tag: tag || null })
    });
  } catch (e) { console.warn('tag mirror failed:', e.message || e); }

  toast(tag ? 'Tagged ' + tag : 'Tag removed', 'ok');
  toggleManage(code);
}

async function removeLink(code) {
  if (!confirm('Delete /' + code + '? The short link stops working immediately and this cannot be undone.')) return;
  try {
    const res = await fetch(CFG.DASH_BASE + '/links/' + encodeURIComponent(code), {
      method: 'DELETE',
      headers: await authHeaders()
    });
    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);
    await dropLink(code);
    toast('/' + code + ' deleted', 'ok');
  } catch (e) {
    toast(e.message || 'Could not delete that link', 'err');
  }
}

/* ── click counts: refresh on demand, and on page load ── */
async function fetchStats(code) {
  const res = await fetch(CFG.API_BASE + '/api/stats/' + encodeURIComponent(code));
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  return data;
}

async function refreshOne(code) {
  const btn = $('refresh-' + code);
  if (btn) { btn.classList.add('spinning'); btn.disabled = true; }
  try {
    const s = await fetchStats(code);
    await patchLink(code, { clicks: s.clicks });
    const cell = $('clicks-' + code);
    if (cell) cell.textContent = s.clicks;
    toast('/' + code + ' — ' + s.clicks + ' clicks', 'ok');
  } catch (e) {
    toast(e.message === 'Link not found' ? '/' + code + ' no longer exists' : 'Could not refresh /' + code, 'err');
  } finally {
    if (btn) { btn.classList.remove('spinning'); btn.disabled = false; }
  }
}

async function refreshAllClicks() {
  if (!links.length) return toast('No links to refresh', 'err');
  const btn = $('refreshClicksBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  $('analyticsStatus').textContent = 'refreshing…';

  let done = 0, gone = 0;
  for (const l of links.slice()) {
    try {
      const s = await fetchStats(l.code);
      l.clicks = s.clicks;
      done++;
    } catch (e) {
      if ((e.message || '').includes('not found')) gone++;
    }
    await sleep(120);
  }
  if (dbReady) {
    try {
      await Promise.all(links.map((l) =>
        sb.from('links').update({ clicks: l.clicks }).eq('code', l.code).eq('user_id', user.id)));
    } catch {}
  } else { lsWrite(); }

  afterLinksChange();
  renderAnalytics();
  $('analyticsStatus').textContent = 'updated just now';
  if (btn) { btn.disabled = false; btn.textContent = 'Refresh all counts'; }
  toast('Refreshed ' + done + ' link' + (done === 1 ? '' : 's') + (gone ? ' · ' + gone + ' expired' : ''), 'ok');
}

function exportLinksCsv() {
  const rows = visibleLinks();
  if (!rows.length) return toast('Nothing to export', 'err');
  const csv = ['short_url,slug,destination,campaign,clicks,expires_at,created_at']
    .concat(rows.map((l) => [
      'https://' + shortUrl(l.code), l.code, l.destination, l.tag || '',
      l.clicks || 0, l.expires_at || '', l.created_at || ''
    ].map(csvCell).join(',')))
    .join('\n');
  download('urlsify-links-' + new Date().toISOString().slice(0, 10) + '.csv', csv);
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function download(name, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
  toast('Downloaded ' + name, 'ok');
}

/* ── QR (library loaded only when first asked for) ── */
let qrLib = null;
async function showQr(code) {
  const box = $('qr-' + code);
  if (!box) return;
  if (box.classList.contains('show')) { box.classList.remove('show'); box.innerHTML = ''; return; }
  box.classList.add('show');
  box.innerHTML = '<span class="spinner"></span>';

  try {
    if (!qrLib) {
      await new Promise((res, rej) => {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/qrcode@1.5.3/build/qrcode.min.js';
        s.onload = res; s.onerror = rej;
        document.head.appendChild(s);
      });
      qrLib = window.QRCode;
    }
    box.innerHTML = '';
    const canvas = document.createElement('canvas');
    await qrLib.toCanvas(canvas, 'https://' + shortUrl(code), { width: 168, margin: 1 });
    box.appendChild(canvas);
    const dl = document.createElement('button');
    dl.className = 'btn btn-sm';
    dl.style.marginTop = '0.5rem';
    dl.textContent = 'Download PNG';
    dl.onclick = () => {
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = code + '-qr.png';
      a.click();
    };
    box.appendChild(dl);
  } catch {
    box.innerHTML = '<span class="field-hint">QR generator failed to load.</span>';
  }
}

/* ══ MASS CREATE ═══════════════════════════════════════════ */
let inputMode = 'lines';
let slugMode = 'random';

function wireInputs() {
  $('bulkInput').addEventListener('input', reparse);
  $('globalSearch').addEventListener('input', (e) => {
    $('linksSearch').value = e.target.value;
    go('links');
    renderLinks();
  });
  $('delayMs').addEventListener('change', updateEta);
  $('detailCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') loadDetail(); });
  $('quickUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') quickShorten(); });
  reparse();
}

function setInputMode(mode) {
  inputMode = mode;
  document.querySelectorAll('[data-input]').forEach((b) =>
    b.classList.toggle('active', b.dataset.input === mode));
  $('sourceHint').textContent = mode === 'csv'
    ? 'One row per link: url,slug,campaign — slug and campaign are optional.'
    : 'One URL per line. Blank lines and duplicates are skipped.';
  $('bulkInput').placeholder = mode === 'csv'
    ? 'https://example.com/page-one,spring-1,spring\nhttps://example.com/page-two,,spring'
    : 'https://example.com/page-one\nhttps://example.com/page-two\nhttps://example.com/page-three';
  reparse();
}

function setSlugMode(mode) {
  slugMode = mode;
  document.querySelectorAll('[data-slug]').forEach((b) =>
    b.classList.toggle('active', b.dataset.slug === mode));
  $('patternFields').hidden = mode !== 'pattern';
  $('csvSlugNote').hidden = mode !== 'csv';
  if (mode === 'csv' && inputMode !== 'csv') setInputMode('csv');
  reparse();
}

function toggleUtm() {
  $('utmFields').hidden = !$('optUtm').checked;
  reparse();
}

function onExpiryChange(selectId, customId) {
  $(customId).hidden = $(selectId).value !== 'custom';
}

function currentTtl() {
  const v = $('expiryPreset').value;
  if (v !== 'custom') return parseInt(v, 10);
  const n = Math.max(1, parseInt($('expiryCustomVal').value, 10) || 1);
  return n * parseInt($('expiryCustomUnit').value, 10);
}

function loadSample() {
  $('bulkInput').value = inputMode === 'csv'
    ? 'https://example.com/spring-sale,spring-sale,spring\nhttps://example.com/lookbook,,spring\nhttps://example.com/newsletter,,spring'
    : 'https://example.com/spring-sale\nhttps://example.com/lookbook\nhttps://example.com/newsletter';
  reparse();
}

function clearInput() {
  $('bulkInput').value = '';
  reparse();
}

/* build the queue preview from the textarea + every control */
function reparse() {
  if (running) return;
  const raw = $('bulkInput').value.split('\n').map((s) => s.trim()).filter(Boolean);
  const addHttps = $('optHttps').checked;
  const dedupe = $('optDedupe').checked;
  const seen = new Set();

  const prefix = ($('slugPrefix').value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-');
  const sep = $('slugSep').value;
  const start = parseInt($('slugStart').value, 10) || 0;
  const pad = Math.min(6, Math.max(1, parseInt($('slugPad').value, 10) || 1));

  queue = [];
  raw.forEach((line, i) => {
    let url = line, slug = '', tag = '';
    if (inputMode === 'csv') {
      const parts = splitCsvLine(line);
      url = (parts[0] || '').trim();
      slug = (parts[1] || '').trim().toLowerCase();
      tag = (parts[2] || '').trim();
    }
    if (!url) return;

    const valid = addHttps
      ? isValidUrl(url)
      : /^https?:\/\//i.test(url) && isValidUrl(url);

    if (valid && addHttps && !/^https?:\/\//i.test(url)) url = 'https://' + url;

    url = applyUtm(url);
    if (dedupe && seen.has(url)) return;
    seen.add(url);

    let finalSlug = '';
    if (slugMode === 'pattern' && prefix) {
      finalSlug = prefix + sep + String(start + queue.length).padStart(pad, '0');
    } else if (slugMode === 'csv') {
      finalSlug = slug;
    }

    queue.push({
      i: queue.length + 1,
      url,
      slug: finalSlug,
      tag: tag || null,
      status: valid ? 'queued' : 'invalid',
      short: '',
      error: valid ? '' : 'not a valid URL'
    });
  });

  $('parseCount').textContent = queue.length + ' link' + (queue.length === 1 ? '' : 's') + ' detected' +
    (raw.length !== queue.length ? ' · ' + (raw.length - queue.length) + ' skipped' : '');
  $('slugPreview').textContent = prefix
    ? 'urlsify.com/' + prefix + sep + String(start).padStart(pad, '0')
    : 'urlsify.com/… (enter a prefix)';
  updateEta();
  renderQueue();
}

function splitCsvLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') q = false;
      else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

function applyUtm(url) {
  if (!$('optUtm').checked) return url;
  try {
    const u = new URL(url);
    const map = {
      utm_source: $('utmSource').value.trim(),
      utm_medium: $('utmMedium').value.trim(),
      utm_campaign: $('utmCampaign').value.trim(),
      utm_term: $('utmTerm').value.trim(),
      utm_content: $('utmContent').value.trim()
    };
    Object.entries(map).forEach(([k, v]) => { if (v) u.searchParams.set(k, v); });
    return u.toString();
  } catch { return url; }
}

function updateEta() {
  const delay = parseInt($('delayMs').value, 10);
  const n = queue.filter((r) => r.status !== 'invalid').length;
  const secs = Math.round((n * (delay + 260)) / 1000);
  $('etaHint').textContent = n
    ? 'Estimated run time: ' + (secs < 60 ? secs + 's' : Math.floor(secs / 60) + 'm ' + (secs % 60) + 's')
    : 'Estimated run time: —';
}

function renderQueue() {
  const body = $('queueBody'), empty = $('queueEmpty');
  if (!queue.length) {
    body.innerHTML = '';
    empty.style.display = 'block';
    $('queueStatus').textContent = '0 / 0';
    $('progressFill').style.width = '0%';
    return;
  }
  empty.style.display = 'none';

  body.innerHTML = queue.map((r) => {
    const cls = r.status === 'done' ? 'q-done' : r.status === 'error' || r.status === 'invalid' ? 'q-error'
      : r.status === 'creating' ? 'q-active' : '';
    let pill = '<span class="pill pill-wait">queued</span>';
    if (r.status === 'creating') pill = '<span class="pill pill-run"><span class="spinner" style="width:10px;height:10px"></span> creating</span>';
    if (r.status === 'done') pill = '<span class="pill pill-ok">created</span>';
    if (r.status === 'error') pill = '<span class="pill pill-err">failed</span>';
    if (r.status === 'invalid') pill = '<span class="pill pill-err">invalid</span>';

    const third = r.short
      ? '<span class="q-out">' + esc(r.short) + '</span>'
      : r.error
        ? '<span class="q-err">' + esc(r.error) + '</span>'
        : '<span style="color:var(--muted)">' + (r.slug ? esc(shortUrl(r.slug)) : 'random slug') + '</span>';

    return '<tr class="' + cls + '"><td class="cell-mono" style="color:var(--muted)">' + r.i + '</td>' +
      '<td class="cell-trunc" title="' + esc(r.url) + '">' + esc(r.url) + '</td>' +
      '<td class="cell-mono">' + third + '</td>' +
      '<td>' + pill + '</td></tr>';
  }).join('');

  const done = queue.filter((r) => r.status === 'done').length;
  const total = queue.filter((r) => r.status !== 'invalid').length;
  $('queueStatus').textContent = done + ' / ' + total;
  $('progressFill').style.width = total ? (done / total * 100) + '%' : '0%';
}

async function runBatch() {
  if (running) return;
  const targets = queue.filter((r) => r.status === 'queued');
  if (!targets.length) return toast('Nothing queued to create', 'err');

  running = true; paused = false; aborted = false;
  const delay = parseInt($('delayMs').value, 10);
  const ttl = currentTtl();
  const tag = $('tagInput').value.trim();
  const stopOnError = $('optStopOnError').checked;

  $('runBtn').disabled = true;
  $('pauseBtn').disabled = false;
  $('stopBtn').disabled = false;
  $('retryBtn').disabled = true;
  $('queuePill').textContent = 'running';
  $('queuePill').className = 'pill pill-run';
  $('bulkInput').disabled = true;

  let created = 0, failed = 0;

  for (const row of targets) {
    if (aborted) break;
    while (paused && !aborted) await sleep(200);
    if (aborted) break;

    row.status = 'creating';
    renderQueue();

    try {
      const made = await createLink(row.url, row.slug, ttl, row.tag || tag);
      row.status = 'done';
      row.short = shortUrl(made.code);
      created++;
    } catch (e) {
      row.status = 'error';
      row.error = e.message || 'failed';
      failed++;
      if (stopOnError) { aborted = true; renderQueue(); break; }
    }
    renderQueue();
    if (targets.indexOf(row) < targets.length - 1) await sleep(delay);
  }

  running = false;
  $('runBtn').disabled = false;
  $('pauseBtn').disabled = true;
  $('pauseBtn').textContent = 'Pause';
  $('stopBtn').disabled = true;
  $('retryBtn').disabled = !queue.some((r) => r.status === 'error');
  $('bulkInput').disabled = false;
  $('queuePill').textContent = aborted ? 'stopped' : 'finished';
  $('queuePill').className = 'pill ' + (failed ? 'pill-err' : 'pill-ok');

  localStorage.setItem('urlsify:batches', String(Number(localStorage.getItem('urlsify:batches') || 0) + 1));
  renderOverview();
  toast('Batch done — ' + created + ' created' + (failed ? ', ' + failed + ' failed' : ''), failed ? 'err' : 'ok');
}

function togglePause() {
  paused = !paused;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('queuePill').textContent = paused ? 'paused' : 'running';
}

function stopBatch() {
  aborted = true;
  paused = false;
  toast('Stopping after the current link…');
}

function retryFailed() {
  queue.forEach((r) => { if (r.status === 'error') { r.status = 'queued'; r.error = ''; } });
  renderQueue();
  runBatch();
}

function copyAllResults() {
  const done = queue.filter((r) => r.status === 'done');
  if (!done.length) return toast('No created links to copy', 'err');
  copy(done.map((r) => 'https://' + r.short).join('\n'), done.length + ' links');
}

function exportQueueCsv() {
  if (!queue.length) return toast('Nothing to export', 'err');
  const csv = ['destination,short_url,status,error']
    .concat(queue.map((r) => [r.url, r.short ? 'https://' + r.short : '', r.status, r.error].map(csvCell).join(',')))
    .join('\n');
  download('urlsify-batch-' + Date.now() + '.csv', csv);
}

/* ══ ANALYTICS ═════════════════════════════════════════════ */
function renderAnalytics() {
  const tag = $('analyticsTag').value;
  const set = tag ? links.filter((l) => l.tag === tag) : links;
  const total = set.reduce((s, l) => s + (l.clicks || 0), 0);
  const live = set.filter((l) => (l.clicks || 0) > 0).length;

  $('anClicks').textContent = total.toLocaleString();
  $('anLinks').textContent = set.length + ' link' + (set.length === 1 ? '' : 's');
  $('anAvg').textContent = set.length ? (total / set.length).toFixed(1) : '0';
  $('anLive').textContent = live;
  $('anLivePct').textContent = set.length ? Math.round(live / set.length * 100) + '% of selection' : '0% of library';

  const top = [...set].sort((a, b) => (b.clicks || 0) - (a.clicks || 0)).slice(0, 10);
  const max = top.length ? Math.max(1, top[0].clicks || 0) : 1;

  $('topLinks').innerHTML = top.length && total
    ? top.map((l) =>
      '<div style="margin-bottom:0.75rem">' +
        '<div style="display:flex;justify-content:space-between;gap:1rem;font-size:0.8rem;margin-bottom:0.3rem">' +
          '<span class="cell-mono">' + esc(shortUrl(l.code)) + '</span>' +
          '<span class="cell-mono" style="color:var(--muted)">' + (l.clicks || 0) + '</span>' +
        '</div>' +
        '<div class="progress-track"><div class="progress-fill" style="width:' + ((l.clicks || 0) / max * 100) + '%"></div></div>' +
      '</div>').join('')
    : '<div class="empty" style="padding:2rem 1rem"><div class="empty-title">No clicks recorded yet</div>' +
      '<div class="empty-desc">Hit “Pull latest stats” once your links have been shared.</div></div>';
}

function openDetail(code) {
  go('analytics');
  $('detailCode').value = code;
  loadDetail();
}

async function loadDetail() {
  const raw = $('detailCode').value.trim();
  if (!raw) return;
  const code = raw.replace(/^https?:\/\//, '').replace(/^[^/]*\//, '').replace(/^\//, '');
  const out = $('detailOut');
  out.innerHTML = '<span class="spinner"></span>';

  try {
    const s = await fetchStats(code);
    const block = (label, arr) =>
      '<div class="manage-section-label" style="margin-top:1rem">' + label + '</div>' +
      (arr && arr.length
        ? arr.map((r) =>
            '<div style="display:flex;justify-content:space-between;font-size:0.8rem;padding:0.3rem 0;border-bottom:1px solid rgba(242,241,250,0.05)">' +
            '<span>' + esc(r.name) + '</span><span class="cell-mono" style="color:var(--muted)">' + r.count + '</span></div>').join('')
        : '<div class="field-hint">no data yet</div>');

    out.innerHTML =
      '<div class="manage-meta" style="margin-bottom:0.4rem">' +
        '<div><span>Short link</span><span>' + esc(s.short) + '</span></div>' +
        '<div><span>Destination</span><span>' + esc(s.destination) + '</span></div>' +
        '<div><span>Total clicks</span><span>' + s.clicks + '</span></div>' +
      '</div>' +
      block('Top countries', s.countries) +
      block('Top referrers', s.referrers) +
      block('Browsers', s.browsers) +
      block('Devices', s.devices);

    if (links.some((l) => l.code === code)) await patchLink(code, { clicks: s.clicks });
  } catch (e) {
    out.innerHTML = '<div class="alert alert-error show">' + esc(e.message || 'Could not load that link') + '</div>';
  }
}

/* ══ SETTINGS / DEFAULTS ═══════════════════════════════════ */
function loadDefaults() {
  const delay = localStorage.getItem('urlsify:defDelay') || '1000';
  const tag = localStorage.getItem('urlsify:defTag') || '';
  $('defDelay').value = delay;
  $('defTag').value = tag;
  $('delayMs').value = delay;
  $('tagInput').value = tag;
}

function saveDefaults() {
  localStorage.setItem('urlsify:defDelay', $('defDelay').value);
  localStorage.setItem('urlsify:defTag', $('defTag').value.trim());
  $('delayMs').value = $('defDelay').value;
  $('tagInput').value = $('defTag').value.trim();
  updateEta();
  toast('Defaults saved', 'ok');
}

/* ══ ACCOUNT DELETION ══════════════════════════════════════
   Guarded three ways: a typed confirmation, a native confirm(),
   and the worker re-checking ownership of every link before it
   removes anything. The webhook notification is sent server-side
   from the verified token, never from this page.
   ═══════════════════════════════════════════════════════════ */

function syncDeleteBtn() {
  const typed = ($('deleteConfirm').value || '').trim().toUpperCase();
  $('deleteBtn').disabled = typed !== 'DELETE';
}

async function deleteAccount() {
  const err = $('deleteError');
  const btn = $('deleteBtn');
  const purge = $('purgeAll').checked;

  err.classList.remove('show');

  if (($('deleteConfirm').value || '').trim().toUpperCase() !== 'DELETE') return;

  const warning = purge
    ? 'Delete your account and erase ALL your information from the servers?\n\n' +
      'Your ' + links.length + ' link(s) stop working immediately, and your email and ' +
      'login are destroyed. This cannot be undone.'
    : 'Delete your account?\n\nYour ' + links.length + ' link(s) stop working immediately. ' +
      'This cannot be undone.';

  if (!confirm(warning)) return;

  btn.disabled = true;
  const label = btn.textContent;
  btn.innerHTML = '<span class="spinner"></span>';

  try {
    // 1. worker: wipe the KV links, notify the operator, optionally
    //    delete the auth record (needs a service role key configured)
    const res = await fetch(CFG.DASH_BASE + '/account', {
      method: 'DELETE',
      headers: await authHeaders(),
      body: JSON.stringify({ purge })
    });

    const data = await res.json().catch(() => ({}));
    if (data.error) throw new Error(data.error);

    // 2. the library rows — RLS lets a user delete their own
    if (dbReady) {
      try {
        await sb.from('links').delete().eq('user_id', user.id);
      } catch (e) { console.warn('library cleanup failed:', e.message || e); }
    }

    // 3. this device
    try { localStorage.removeItem(LS_KEY()); } catch {}
    try { localStorage.removeItem('urlsify:batches'); } catch {}

    const note = purge && !data.authDeleted
      ? '\n\nYour links are gone and your erasure request has been logged — the login record ' +
        'is removed manually within 24 hours.'
      : '';

    alert('Account deleted. ' + (data.links || 0) + ' link(s) removed.' + note);

    await sb.auth.signOut();
    location.replace('/');
  } catch (e) {
    err.textContent = e.message || 'Could not delete the account. Try again, or contact support.';
    err.classList.add('show');
    btn.disabled = false;
    btn.textContent = label;
  }
}
