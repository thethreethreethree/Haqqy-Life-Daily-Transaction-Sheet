// main.js — bootstrap, navigation, first-run setup, and Settings. No login.
import { el, $, clear, peso, pesoPlain, num, toast, fmtDateTime, fmtPlainDate } from './util.js';
import { store } from './store.js';
import { pageHead, openModal, confirmDialog } from './components.js';
import * as gh from './github.js';
import * as trips from './views/trips.js';
import * as sheet from './views/sheet.js';
import * as activity from './views/activity.js';
import * as inventory from './views/inventory.js';

const VIEWS = {
  trips:     { label: 'Trips', icon: '🛥️', render: trips.render },
  sheet:     { label: 'Trip sheet', icon: '📄', render: sheet.render, hidden: true },
  inventory: { label: 'Inventory', icon: '📦', render: inventory.render },
  activity:  { label: 'Activity log', icon: '🪵', render: activity.render },
  settings:  { label: 'Settings', icon: '⚙', render: renderSettings },
};

let current = 'trips';
let navArgs = null;
const app = document.getElementById('app');

async function mount() {
  splash('Loading…');
  await store.load();
  await syncFromRemoteIfEmpty();
  if (!store.isSetup()) { renderSetup(); return; }
  app.classList.remove('locked');
  route();
}

// On a fresh device with a configured remote backup, restore it (only when there
// is nothing local to lose — never clobbers local edits).
async function syncFromRemoteIfEmpty() {
  if (store.trips.length || store.routes.length) return;
  try {
    const remote = await gh.fetchRemoteState();
    if (remote && remote.payload && remote.payload.state && Array.isArray(remote.payload.state.trips) && remote.payload.state.trips.length) {
      store.importData(remote.payload);
      toast('Restored from GitHub backup');
    }
  } catch (e) { /* offline / no remote — fine */ }
}

// ---------------------------------------------------------------- first run
function renderSetup() {
  app.classList.remove('locked');
  clear(app);
  const brand = el('input', { class: 'input', type: 'text', placeholder: 'e.g. Haqqy Life · Boracay', value: store.config.brand || 'Haqqy Life · Boracay' });
  const name = el('input', { class: 'input', type: 'text', placeholder: 'optional — stamped on the activity log' });
  const card = el('div', { class: 'setup-card' }, [
    el('img', { class: 'setup-logo', src: 'brand_assets/haqqy-logo-alt.webp', alt: 'Haqqy Life' }),
    el('h1', { text: 'Daily Trip Sheet' }),
    el('p', { class: 'muted', text: 'Record and reconcile each day’s trip. This seeds the BIHOPA and BBA routes; you can edit prices and add routes any time in Settings.' }),
    el('div', { class: 'field' }, [el('label', { text: 'App name' }), brand]),
    el('div', { class: 'field' }, [el('label', { text: 'Your name' }), name]),
    el('button', { class: 'btn primary lg', text: 'Get started →', onClick: () => {
      store.completeSetup({ brand: brand.value.trim() || 'Haqqy Life · Boracay', staffName: name.value.trim() });
      app.classList.remove('locked');
      current = 'trips'; route();
    } }),
  ]);
  app.appendChild(el('div', { class: 'setup-wrap' }, card));
}

// ------------------------------------------------------------------- shell
function renderShell() {
  clear(app);
  const shell = el('div', { class: 'shell' }, [renderSidebar(), el('main', { class: 'main', id: 'main' })]);
  app.appendChild(shell);
}
function renderSidebar() {
  const nav = el('nav', { class: 'side' });
  nav.appendChild(el('div', { class: 'brand' }, [
    el('img', { class: 'brand-logo', src: 'brand_assets/haqqy-logo.webp', alt: store.config.brand || 'Haqqy Life' }),
    el('div', { class: 'brand-sub', text: 'Daily Trip Sheet' }),
  ]));
  const links = el('div', { class: 'nav-links' });
  for (const [id, v] of Object.entries(VIEWS)) {
    if (v.hidden) continue;
    links.appendChild(el('button', {
      class: 'nav-link' + (id === current ? ' active' : ''),
      onClick: () => navigate(id),
    }, [el('span', { class: 'nav-ic', text: v.icon }), el('span', { text: v.label })]));
  }
  nav.appendChild(links);
  nav.appendChild(el('div', { class: 'side-foot' }, [
    el('button', { class: 'btn primary block', text: '+ New trip', onClick: () => navigate('trips') }),
    el('div', { class: 'side-name', text: store.config.staffName ? `👤 ${store.config.staffName}` : '' }),
  ]));
  return nav;
}
function navigate(id, args) {
  current = id; navArgs = args || null;
  route();
}
function route() {
  if (!$('.shell')) renderShell();
  // refresh sidebar active state
  const side = $('.side'); if (side) side.replaceWith(renderSidebar());
  const main = $('#main');
  clear(main);
  const v = VIEWS[current] || VIEWS.trips;
  const ctx = { navigate, store, args: navArgs };
  try { main.appendChild(v.render(ctx)); }
  catch (e) { console.error(e); main.appendChild(el('div', { class: 'card', text: 'Error rendering view: ' + e.message })); }
  window.scrollTo(0, 0);
}

// ------------------------------------------------------------------ settings
function renderSettings(ctx) {
  const root = el('div');
  root.appendChild(pageHead('Settings', 'Routes & pricing · backup · data'));
  root.appendChild(renderRoutesCard(ctx));
  root.appendChild(renderProfileCard());
  root.appendChild(renderGitHubCard());
  root.appendChild(renderDataCard(ctx));
  return root;
}

function renderRoutesCard(ctx) {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: '🧭 Routes & pricing' }), el('span', { class: 'sub', text: 'channel prices are derived from these two base prices' })]),
  ]);
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Route' }), el('th', { class: 'num', text: 'Base 1 (regular)' }),
    el('th', { class: 'num', text: 'Base 2 (OTA)' }), el('th', {}),
  ])));
  const body = el('tbody');
  for (const r of store.routes) {
    const nameInp = el('input', { class: 'input sm', type: 'text', value: r.name });
    const b1 = el('input', { class: 'input num sm', type: 'number', step: '0.01', value: String(r.base1) });
    const b2 = el('input', { class: 'input num sm', type: 'number', step: '0.01', value: String(r.base2) });
    const saveRow = () => { store.updateRoute(r.id, { name: nameInp.value, base1: num(b1.value), base2: num(b2.value) }); toast('Route saved'); };
    [nameInp, b1, b2].forEach((i) => i.addEventListener('change', saveRow));
    body.appendChild(el('tr', {}, [
      el('td', {}, nameInp), el('td', { class: 'num' }, b1), el('td', { class: 'num' }, b2),
      el('td', { class: 'num' }, el('button', { class: 'btn ghost xs', text: '🗑', onClick: () => {
        confirmDialog({ title: `Remove route "${r.name}"?`, sub: 'Existing trips keep their snapshotted prices.', confirmLabel: 'Remove', kind: 'danger', onConfirm: () => { store.removeRoute(r.id); ctx.navigate('settings'); } });
      } })),
    ]));
  }
  tbl.appendChild(body);
  card.appendChild(el('div', { class: 'table-wrap' }, tbl));
  card.appendChild(el('button', { class: 'btn ghost sm mt', text: '+ Add route', onClick: () => {
    store.addRoute({ name: 'New Route', base1: 0, base2: 0 }); ctx.navigate('settings');
  } }));
  card.appendChild(el('p', { class: 'muted xs mt', html: 'Discounts (global): 10% off · 20% reattendee · OTA Klook/GYG −20% · OTA KKday −15%. Regular & Paypal use Base 1; OTA channels use Base 2.' }));
  return card;
}

function renderProfileCard() {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: '👤 App name & user' })]),
  ]);
  const brand = el('input', { class: 'input', type: 'text', value: store.config.brand || '' });
  const name = el('input', { class: 'input', type: 'text', value: store.config.staffName || '' });
  brand.addEventListener('change', () => { store.setConfig({ brand: brand.value.trim() || 'Daily Trip Tracker' }); toast('Saved'); route(); });
  name.addEventListener('change', () => { store.setConfig({ staffName: name.value.trim() }); toast('Saved'); });
  card.appendChild(el('div', { class: 'grid cols-2 gap' }, [
    el('div', { class: 'field' }, [el('label', { text: 'App name' }), brand]),
    el('div', { class: 'field' }, [el('label', { text: 'Your name (for the activity log)' }), name]),
  ]));
  return card;
}

function renderGitHubCard() {
  const g = store.config.github || {};
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: '☁️ GitHub backup' }), el('span', { class: 'sub', text: 'commit a JSON snapshot — git history = durable audit trail' })]),
  ]);
  const owner = el('input', { class: 'input sm', type: 'text', value: g.owner || '', placeholder: 'owner' });
  const repo = el('input', { class: 'input sm', type: 'text', value: g.repo || '', placeholder: 'repo' });
  const branch = el('input', { class: 'input sm', type: 'text', value: g.branch || 'main', placeholder: 'branch' });
  const path = el('input', { class: 'input sm', type: 'text', value: g.path || 'data/trips-backup.json', placeholder: 'path' });
  const token = el('input', { class: 'input sm', type: 'password', placeholder: gh.hasToken() ? '•••••• (saved on this device)' : 'fine-grained PAT (Contents: R/W)' });
  const autoSync = el('input', { type: 'checkbox' });
  autoSync.checked = !!g.autoSync;
  const status = el('p', { class: 'hint', style: 'min-height:18px' });

  const saveCfg = () => store.setConfig({ github: { ...store.config.github, owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim() || 'main', path: path.value.trim() || 'data/trips-backup.json', autoSync: autoSync.checked } });
  [owner, repo, branch, path].forEach((i) => i.addEventListener('change', saveCfg));
  autoSync.addEventListener('change', saveCfg);
  token.addEventListener('change', () => { if (token.value.trim()) { gh.setToken(token.value.trim()); token.value = ''; token.placeholder = '•••••• (saved on this device)'; toast('Token saved on this device'); } });

  card.appendChild(el('div', { class: 'grid cols-2 gap' }, [
    el('div', { class: 'field' }, [el('label', { text: 'Owner' }), owner]),
    el('div', { class: 'field' }, [el('label', { text: 'Repo' }), repo]),
    el('div', { class: 'field' }, [el('label', { text: 'Branch' }), branch]),
    el('div', { class: 'field' }, [el('label', { text: 'Path' }), path]),
    el('div', { class: 'field' }, [el('label', { text: 'Token (device-only)' }), token]),
    el('div', { class: 'field' }, [el('label', { text: 'Auto-backup on change' }), el('div', { class: 'flex aic gap' }, [autoSync, el('span', { class: 'muted', text: 'commit a few seconds after edits' })])]),
  ]));
  card.appendChild(el('div', { class: 'flex gap mt' }, [
    el('button', { class: 'btn', text: 'Test connection', onClick: async () => { saveCfg(); status.textContent = 'Testing…'; try { const n = await gh.testConnection(); status.textContent = '✓ Connected to ' + n; status.style.color = 'var(--in-700)'; } catch (e) { status.textContent = '✗ ' + e.message; status.style.color = 'var(--danger)'; } } }),
    el('button', { class: 'btn primary', text: 'Back up now', onClick: async () => { saveCfg(); status.textContent = 'Backing up…'; try { const url = await gh.backupNow('manual'); status.textContent = '✓ Backed up'; status.style.color = 'var(--in-700)'; toast('Backed up to GitHub'); } catch (e) { status.textContent = '✗ ' + e.message; status.style.color = 'var(--danger)'; } } }),
  ]));
  if (g.lastBackupAt) card.appendChild(el('p', { class: 'muted xs', text: 'Last backup: ' + fmtDateTime(g.lastBackupAt) }));
  card.appendChild(status);
  return card;
}

function renderDataCard(ctx) {
  const card = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: '💾 Data' }), el('span', { class: 'sub', text: 'local backup & restore' })]),
  ]);
  card.appendChild(el('div', { class: 'flex gap wrap' }, [
    el('button', { class: 'btn', text: '⬇ Export backup', onClick: () => exportBackup() }),
    el('button', { class: 'btn', text: '⬆ Import backup', onClick: () => importBackup(ctx) }),
    el('button', { class: 'btn danger', text: '♻ Reset all data', onClick: () => confirmDialog({ title: 'Reset ALL data?', sub: 'Deletes every trip, route and log entry on this device. Export a backup first if unsure.', confirmLabel: 'Reset everything', kind: 'danger', onConfirm: () => { store.reset(); store.completeSetup({}); toast('Data reset'); ctx.navigate('trips'); } }) }),
  ]));
  return card;
}
function exportBackup() {
  const data = JSON.stringify(store.exportData(), null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `trips-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  toast('Backup downloaded');
}
function importBackup(ctx) {
  const inp = el('input', { type: 'file', accept: 'application/json', style: 'display:none' });
  inp.addEventListener('change', () => {
    const f = inp.files[0]; if (!f) return;
    const r = new FileReader();
    r.onload = () => { try { store.importData(JSON.parse(r.result)); toast('Backup imported'); ctx.navigate('trips'); } catch (e) { toast('Invalid backup file: ' + e.message, 'err'); } };
    r.readAsText(f);
  });
  document.body.appendChild(inp); inp.click(); inp.remove();
}

// --------------------------------------------------- debounced auto-backup
let _bkTimer = null;
store.subscribe(() => {
  const g = store.config.github || {};
  if (!g.autoSync || !gh.hasToken() || !g.owner || !g.repo) return;
  clearTimeout(_bkTimer);
  _bkTimer = setTimeout(() => gh.autoBackup('auto'), 4000);
});

// ---------------------------------------------------------------- splash
function splash(msg) {
  app.classList.remove('locked');
  clear(app);
  app.appendChild(el('div', { class: 'splash' }, [el('div', { class: 'spinner' }), el('p', { text: msg })]));
}

// flush pending writes before the tab closes
window.addEventListener('beforeunload', () => { try { store.flush(); } catch (e) {} });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { try { store.flush(); } catch (e) {} } });

mount();
