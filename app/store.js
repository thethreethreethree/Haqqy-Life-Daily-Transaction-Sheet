// store.js — the engine. Holds all state, persists it, and is the single place
// that mutates trips, routes and the activity log.
//
// Model (per the chosen design):
//   • A TRIP SHEET is one trip on one day. It is an editable document while
//     `status: 'open'`, and becomes read-only when `status: 'finalized'`
//     (re-openable, with the reopen recorded). Trips are NOT an append-only
//     ledger — they're working documents — so they have update()/delete().
//   • ROUTES carry the two base prices; channel prices are derived in compute.js.
//   • The ACTIVITY LOG is append-only and HASH-CHAINED (the one tamper-evident
//     surface kept from Frendz): hash = sha256(event-without-hash + prevHash).
//     Any out-of-band edit to the log breaks the chain and is flagged on load.
//
// Persistence: IndexedDB (primary; a year of trips is small but IDB is robust),
// with a localStorage fallback for private mode / no-IDB. The GitHub repo holds
// versioned JSON backups (git history = a durable, dated audit trail).

import { sha256, stableStringify, uid, nowISO, round2, num } from './util.js';
import { seedRoutes, defaultRoute, defaultTrip, computeTrip } from './compute.js';
import { normalizeItem, clearedCounts, compareInventories } from './inventory.js';

const STORAGE_KEY = 'dtt_state_v1';
const GENESIS = '0'.repeat(64);

// ------------------------------------------------------------- IndexedDB layer
const IDB_NAME = 'dtt';
const IDB_STORE = 'kv';
const IDB_KEY = 'state';

function idbOpen() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('no-idb')); return; }
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function idbGet(key) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction(IDB_STORE, 'readonly').objectStore(IDB_STORE).get(key);
      req.onsuccess = () => resolve(req.result == null ? null : req.result);
      req.onerror = () => reject(req.error);
    });
  } finally { db.close(); }
}
async function idbSet(key, val) {
  const db = await idbOpen();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      tx.objectStore(IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('idb-abort'));
    });
  } finally { db.close(); }
}

function defaultState() {
  return {
    version: 1,
    config: {
      brand: 'Haqqy Life · Boracay',
      currency: 'PHP',
      staffName: '',            // optional device-local name, stamped on the log
      setupComplete: false,
      createdAt: nowISO(),
      github: { owner: '', repo: '', branch: 'main', path: 'data/trips-backup.json', enabled: false },
    },
    routes: [],
    trips: [],
    inventory: [],              // stock items: { id, name, category, uom, count, par, ... }
    inventorySnapshots: [],     // saved stock-takes: { id, name, date, items: [...] }
    audit: [],                  // append-only, hash-chained activity log
  };
}

class Store {
  constructor() {
    this.state = null;
    this._subs = new Set();
    this.auditIntegrity = { ok: true, brokenAtSeq: null };
    this._suppressAudit = false;
  }

  // -------------------------------------------------------------- persistence
  async load() {
    let s = null;
    try { s = await idbGet(IDB_KEY); } catch (e) { /* no idb / private mode */ }
    if (!s) {
      let raw = null;
      try { raw = localStorage.getItem(STORAGE_KEY); } catch (e) { /* ignore */ }
      if (raw) { try { s = JSON.parse(raw); } catch (e) { s = null; } }
      if (s) this._migratedFromLS = true;
    }
    this.state = s || defaultState();
    // Migrate / ensure shape
    this.state = Object.assign(defaultState(), this.state);
    this.state.config = Object.assign(defaultState().config, this.state.config || {});
    if (!Array.isArray(this.state.routes)) this.state.routes = [];
    if (!Array.isArray(this.state.trips)) this.state.trips = [];
    if (!Array.isArray(this.state.inventory)) this.state.inventory = [];
    if (!Array.isArray(this.state.inventorySnapshots)) this.state.inventorySnapshots = [];
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    this.verifyAuditIntegrity();
    if (this._migratedFromLS) { this._migratedFromLS = false; this._persist(); }
    return this.state;
  }

  _persist() {
    this._dirty = true;
    if (this._writing) return this._writing;
    this._writing = (async () => {
      try {
        while (this._dirty) {
          this._dirty = false;
          try {
            await idbSet(IDB_KEY, this.state);
          } catch (e) {
            try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state)); }
            catch (e2) { console.error('persist failed (idb + localStorage)', e, e2); }
          }
        }
      } finally { this._writing = null; }
    })();
    return this._writing;
  }
  async flush() { if (this._writing) await this._writing; }

  save() { this._persist(); this.emit(); }

  reset() {
    this.state = defaultState();
    this._audit('data.reset', 'All data reset');
    this.save();
  }

  // ---------------------------------------------------------------- pub/sub
  subscribe(fn) { this._subs.add(fn); return () => this._subs.delete(fn); }
  emit() { for (const fn of this._subs) { try { fn(this.state); } catch (e) { console.error(e); } } }

  // ---------------------------------------------------------------- config
  get config() { return this.state.config; }
  setConfig(patch) {
    Object.assign(this.state.config, patch);
    this._audit('settings.update', 'Updated settings', { keys: Object.keys(patch) });
    this.save();
  }
  isSetup() { return !!this.state.config.setupComplete; }
  // First-run setup: brand + optional name; seeds the two source routes.
  completeSetup({ brand, staffName } = {}) {
    const c = this.state.config;
    if (brand) c.brand = brand;
    if (staffName != null) c.staffName = staffName;
    if (!this.state.routes.length) this.state.routes = seedRoutes();
    c.setupComplete = true;
    this._audit('setup.complete', 'App initialised', { brand: c.brand });
    this.save();
  }

  // ----------------------------------------------------------------- routes
  get routes() { return this.state.routes; }
  activeRoutes() { return this.state.routes.filter((r) => r.active !== false); }
  routeById(id) { return this.state.routes.find((r) => r.id === id) || null; }
  addRoute({ name, base1, base2 }) {
    const r = defaultRoute(String(name || '').trim() || 'Route', num(base1), num(base2));
    this.state.routes.push(r);
    this._audit('route.create', `Added route "${r.name}" (base ₱${r.base1} / ₱${r.base2})`, { id: r.id, name: r.name, base1: r.base1, base2: r.base2 });
    this.save();
    return r;
  }
  updateRoute(id, patch) {
    const r = this.routeById(id);
    if (!r) return null;
    const before = { name: r.name, base1: r.base1, base2: r.base2, active: r.active };
    if (patch.name != null) r.name = String(patch.name).trim();
    if (patch.base1 != null) r.base1 = round2(num(patch.base1));
    if (patch.base2 != null) r.base2 = round2(num(patch.base2));
    if (patch.active != null) r.active = !!patch.active;
    const after = { name: r.name, base1: r.base1, base2: r.base2, active: r.active };
    this._audit('route.update', `Updated route "${r.name}"`, { id, before, after });
    this.save();
    return r;
  }
  removeRoute(id) {
    const i = this.state.routes.findIndex((r) => r.id === id);
    if (i < 0) return false;
    const [r] = this.state.routes.splice(i, 1);
    this._audit('route.remove', `Removed route "${r.name}"`, { id, name: r.name });
    this.save();
    return true;
  }

  // ------------------------------------------------------------------ trips
  get trips() { return this.state.trips; }
  // Newest trip first (by trip date, then creation).
  tripsSorted() {
    return this.state.trips.slice().sort((a, b) =>
      (a.date < b.date ? 1 : a.date > b.date ? -1 : (a.createdAt < b.createdAt ? 1 : -1)));
  }
  tripById(id) { return this.state.trips.find((t) => t.id === id) || null; }

  createTrip({ routeId, date } = {}) {
    const route = (routeId && this.routeById(routeId)) || this.activeRoutes()[0] || defaultRoute();
    const t = defaultTrip(route);
    if (date) t.date = date;
    this.state.trips.push(t);
    this._audit('trip.create', `New trip sheet · ${t.routeName} · ${t.date}`, { id: t.id, route: t.routeName, date: t.date });
    this.save();
    return t;
  }

  // Patch a trip's data (open trips only). `patch` is a deep-ish merge on the
  // known sub-objects so a view can save just the block it edited.
  updateTrip(id, patch) {
    const t = this.tripById(id);
    if (!t) return null;
    if (t.status === 'finalized') return null; // locked; must reopen first
    for (const k of Object.keys(patch)) {
      const v = patch[k];
      if (v && typeof v === 'object' && !Array.isArray(v) && t[k] && typeof t[k] === 'object' && !Array.isArray(t[k])) {
        // shallow-merge nested blocks (guests, revenue, expenses, cashCount, tickets)
        for (const kk of Object.keys(v)) {
          if (v[kk] && typeof v[kk] === 'object' && !Array.isArray(v[kk]) && t[k][kk] && typeof t[k][kk] === 'object') {
            Object.assign(t[k][kk], v[kk]);
          } else { t[k][kk] = v[kk]; }
        }
      } else { t[k] = v; }
    }
    t.updatedAt = nowISO();
    // Quiet save: editing a sheet shouldn't flood the activity log on every
    // keystroke. Material lifecycle events (create/finalize/reopen/delete) ARE
    // logged. We persist + emit without an audit row here.
    this.save();
    return t;
  }

  // Change which route a trip uses (re-snapshots its base prices).
  setTripRoute(id, routeId) {
    const t = this.tripById(id);
    const r = this.routeById(routeId);
    if (!t || !r || t.status === 'finalized') return null;
    t.routeId = r.id; t.routeName = r.name; t.base1 = r.base1; t.base2 = r.base2;
    t.updatedAt = nowISO();
    this.save();
    return t;
  }

  // Custom (ad-hoc) ledger lines beyond the fixed template, for either the revenue
  // side (field 'customRevenue') or the expense side ('customExpenses'). Open trips
  // only; editing a row's fields afterwards goes through updateTrip like any block.
  addCustomLine(id, field, label = '') {
    if (field !== 'customRevenue' && field !== 'customExpenses') return null;
    const t = this.tripById(id);
    if (!t || t.status === 'finalized') return null;
    if (!Array.isArray(t[field])) t[field] = [];
    const row = { id: uid(field === 'customRevenue' ? 'crev' : 'cexp'), label: String(label || '').trim(), unit: 1, amount: 0, notes: '' };
    t[field].push(row);
    t.updatedAt = nowISO();
    this.save();
    return row;
  }
  removeCustomLine(id, field, rowId) {
    if (field !== 'customRevenue' && field !== 'customExpenses') return false;
    const t = this.tripById(id);
    if (!t || t.status === 'finalized') return false;
    t[field] = (t[field] || []).filter((r) => r.id !== rowId);
    t.updatedAt = nowISO();
    this.save();
    return true;
  }
  // Named wrappers (stable API used by the views & tests).
  addCustomExpense(id, label = '') { return this.addCustomLine(id, 'customExpenses', label); }
  removeCustomExpense(id, rowId) { return this.removeCustomLine(id, 'customExpenses', rowId); }
  addCustomRevenue(id, label = '') { return this.addCustomLine(id, 'customRevenue', label); }
  removeCustomRevenue(id, rowId) { return this.removeCustomLine(id, 'customRevenue', rowId); }

  finalizeTrip(id) {
    const t = this.tripById(id);
    if (!t || t.status === 'finalized') return null;
    const c = computeTrip(t);
    t.status = 'finalized';
    t.finalizedAt = nowISO();
    t.updatedAt = t.finalizedAt;
    t.finalSnapshot = { revenue: c.revenueTotal, expenses: c.expenseTotal, net: c.net, counted: c.count.total, shortOver: c.shortOver, guests: c.guests };
    this._audit('trip.finalize',
      `Finalised ${t.routeName} · ${t.date} · NET ₱${c.net.toLocaleString()} · short/over ${c.shortOver >= 0 ? '+' : ''}${c.shortOver.toLocaleString()}`,
      { id: t.id, ...t.finalSnapshot });
    this.save();
    return t;
  }
  reopenTrip(id, reason = '') {
    const t = this.tripById(id);
    if (!t || t.status !== 'finalized') return null;
    t.status = 'open';
    t.finalizedAt = null;
    t.updatedAt = nowISO();
    this._audit('trip.reopen', `Reopened ${t.routeName} · ${t.date}${reason ? ' · ' + reason : ''}`, { id: t.id, reason });
    this.save();
    return t;
  }
  deleteTrip(id) {
    const i = this.state.trips.findIndex((t) => t.id === id);
    if (i < 0) return false;
    const [t] = this.state.trips.splice(i, 1);
    this._audit('trip.delete', `Deleted trip ${t.routeName} · ${t.date}`, { id: t.id, route: t.routeName, date: t.date });
    this.save();
    return true;
  }

  // Convenience: the computed view for a trip (pure; safe to call per render).
  compute(id) { const t = this.tripById(id); return t ? computeTrip(t) : null; }

  // -------------------------------------------------------------- inventory
  // A standalone stock list (not per-trip): items with a free-text on-hand
  // count + par target, plus saved snapshots for stock-take comparison.
  get inventory() { return this.state.inventory; }
  inventoryCategories() {
    return Array.from(new Set((this.state.inventory || []).map((i) => (i.category || '').trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }
  inventoryItemById(id) { return (this.state.inventory || []).find((i) => i.id === id) || null; }
  addInventoryItem({ name, category, uom, count, par } = {}) {
    const it = normalizeItem({ name, category, uom, count, par });
    if (!it.name) return null;
    const row = { id: uid('inv'), ...it, createdAt: nowISO(), updatedAt: nowISO() };
    this.state.inventory.push(row);
    this._audit('inventory.add', `Added inventory item "${row.name}"`, { id: row.id, name: row.name, category: row.category });
    this.save();
    return row;
  }
  updateInventoryItem(id, patch) {
    const it = this.inventoryItemById(id);
    if (!it) return null;
    for (const k of ['name', 'category', 'uom', 'count', 'par']) {
      if (k in patch) it[k] = k === 'uom' ? String(patch[k] || '').toUpperCase() : patch[k];
    }
    it.updatedAt = nowISO();
    this.save(); // quiet — inline count edits during a stock-take shouldn't flood the log
    return it;
  }
  removeInventoryItem(id) {
    const i = this.state.inventory.findIndex((x) => x.id === id);
    if (i < 0) return false;
    const [it] = this.state.inventory.splice(i, 1);
    this._audit('inventory.remove', `Removed inventory item "${it.name}"`, { id, name: it.name });
    this.save();
    return true;
  }
  // Bulk import (parsed CSV/JSON rows). replace=true swaps the whole list.
  importInventory(items, { replace = false } = {}) {
    const rows = (items || []).map((o) => normalizeItem(o)).filter((o) => o.name)
      .map((o) => ({ id: uid('inv'), ...o, createdAt: nowISO(), updatedAt: nowISO() }));
    if (replace) this.state.inventory = rows; else this.state.inventory.push(...rows);
    this._audit('inventory.import', `Imported ${rows.length} inventory item${rows.length === 1 ? '' : 's'}${replace ? ' (replaced list)' : ''}`, { count: rows.length, replace });
    this.save();
    return rows.length;
  }

  // ---- snapshots (saved stock-takes) ----
  get inventorySnapshots() { return this.state.inventorySnapshots; }
  snapshotById(id) { return (this.state.inventorySnapshots || []).find((s) => s.id === id) || null; }
  saveInventorySnapshot(name) {
    const snap = {
      id: uid('snap'), name: String(name || 'Snapshot').trim() || 'Snapshot', date: nowISO(),
      items: (this.state.inventory || []).map((it) => ({ name: it.name, category: it.category, uom: it.uom, count: it.count, par: it.par })),
    };
    this.state.inventorySnapshots.push(snap);
    this._audit('inventory.snapshot', `Saved stock-take snapshot "${snap.name}" (${snap.items.length} items)`, { id: snap.id, name: snap.name, items: snap.items.length });
    this.save();
    return snap;
  }
  deleteInventorySnapshot(id) {
    const i = this.state.inventorySnapshots.findIndex((s) => s.id === id);
    if (i < 0) return false;
    const [s] = this.state.inventorySnapshots.splice(i, 1);
    this._audit('inventory.snapshot_delete', `Deleted snapshot "${s.name}"`, { id, name: s.name });
    this.save();
    return true;
  }
  restoreInventorySnapshot(id) {
    const s = this.snapshotById(id);
    if (!s) return false;
    this.state.inventory = s.items.map((it) => ({ id: uid('inv'), ...normalizeItem(it), createdAt: nowISO(), updatedAt: nowISO() }));
    this._audit('inventory.restore', `Restored snapshot "${s.name}" (${s.items.length} items)`, { id, name: s.name });
    this.save();
    return true;
  }
  // Snapshot the current counts, then clear them for a fresh stock-take (the item
  // master — name/category/uom/par — is kept). Mirrors "Start new inventory".
  startNewCount(name) {
    const snap = this.saveInventorySnapshot(name || ('Stock-take ' + nowISO().slice(0, 10)));
    this.state.inventory = clearedCounts(this.state.inventory);
    this._audit('inventory.new_count', `Started a new count — cleared ${this.state.inventory.length} on-hand counts`, { snapshot: snap.id, items: this.state.inventory.length });
    this.save();
    return snap;
  }
  // Compare a saved snapshot (before) vs the current counts (after).
  compareToSnapshot(id) {
    const s = this.snapshotById(id);
    if (!s) return null;
    return compareInventories(s.items, this.state.inventory, 'count');
  }

  // ------------------------------------------------------ activity / audit log
  _lastAuditHash() {
    const A = this.state.audit;
    return A.length ? A[A.length - 1].hash : GENESIS;
  }
  _audit(action, what, details = {}) {
    if (this._suppressAudit) return null;
    const ev = {
      seq: this.state.audit.length + 1,
      id: uid('aud'),
      ts: nowISO(),
      actor: (this.state.config && this.state.config.staffName) || 'staff',
      action,
      what: what || '',
      details: details || {},
      prevHash: this._lastAuditHash(),
    };
    ev.hash = sha256(stableStringify(ev));
    this.state.audit.push(ev);
    // NB: _audit is always called from a mutator that itself calls save();
    // we don't save() here to avoid a double write.
    return ev;
  }
  verifyAuditIntegrity() {
    let prev = GENESIS;
    let brokenAtSeq = null;
    for (const ev of this.state.audit) {
      const { hash, ...rest } = ev;
      if (rest.prevHash !== prev) { brokenAtSeq = ev.seq; break; }
      if (sha256(stableStringify(rest)) !== hash) { brokenAtSeq = ev.seq; break; }
      prev = hash;
    }
    this.auditIntegrity = { ok: brokenAtSeq == null, brokenAtSeq };
    return this.auditIntegrity;
  }
  get audit() { return this.state.audit; }

  // ------------------------------------------------------------- export/import
  exportData() {
    return {
      meta: {
        app: 'Daily Trip Tracker',
        exportedAt: nowISO(),
        version: this.state.version,
        trips: this.state.trips.length,
        routes: this.state.routes.length,
        auditEvents: this.state.audit.length,
        auditIntegrity: this.verifyAuditIntegrity(),
      },
      state: this.state,
    };
  }
  importData(payload) {
    const s = payload && payload.state ? payload.state : payload;
    if (!s || !Array.isArray(s.trips)) throw new Error('Invalid backup file.');
    this.state = Object.assign(defaultState(), s);
    this.state.config = Object.assign(defaultState().config, s.config || {});
    if (!Array.isArray(this.state.routes)) this.state.routes = [];
    if (!Array.isArray(this.state.trips)) this.state.trips = [];
    if (!Array.isArray(this.state.inventory)) this.state.inventory = [];
    if (!Array.isArray(this.state.inventorySnapshots)) this.state.inventorySnapshots = [];
    if (!Array.isArray(this.state.audit)) this.state.audit = [];
    this.verifyAuditIntegrity();
    this._audit('data.import', `Imported backup (${this.state.trips.length} trips)`, { trips: this.state.trips.length });
    this.save();
  }
}

export const store = new Store();
export { GENESIS };
