// store.smoke.mjs — headless smoke test of the engine (no browser). Stubs
// browser storage so we can exercise the real store logic in Node:
// setup → create → edit → compute → finalize → reopen, plus the activity-log
// hash chain AND a tamper-detection check. Run: node test/store.smoke.mjs
globalThis.indexedDB = undefined; // force the localStorage fallback path
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => mem.set(k, String(v)),
  removeItem: (k) => mem.delete(k),
};

const { store } = await import('../app/store.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.error('  ✗ ' + label); } };

await store.load();
ok('loads with empty state', store.trips.length === 0 && store.routes.length === 0);

store.completeSetup({ brand: 'Test', staffName: 'Maya' });
ok('setup seeds two routes (BIHOPA, BBA)', store.routes.length === 2 && store.activeRoutes().some(r => r.name === 'BIHOPA'));
ok('setup marks complete', store.isSetup());

const bihopa = store.activeRoutes().find(r => r.name === 'BIHOPA');
const t = store.createTrip({ routeId: bihopa.id, date: '2026-05-02' });
ok('creates a trip snapshotting route prices', t.base1 === 1490 && t.base2 === 1990 && t.status === 'open');

// edit guests + revenue/expenses to the real May 2 figures
store.updateTrip(t.id, { guests: { regular: { cash: 3, credit: 2 }, paypal: { count: 2 }, otaKlook: { count: 2 }, otaGYG: { count: 2 } } });
store.updateTrip(t.id, { revenue: { prevCashSales: { amount: 7000 }, cashFlow: { amount: 5000 }, magicIslandFee: { unit: 15, amount: 250 }, snorkelingFee: { unit: 15, amount: 100 } } });
store.updateTrip(t.id, { expenses: { coastGuardIH: { amount: 200 }, manifestIH: { amount: 600 }, magicIslandReload: { unit: 15, amount: 220 }, snorkelingFeeExp: { unit: 11, amount: 100 }, foodPancit: { amount: 250 }, transportParaw: { unit: 2, amount: 45 }, parcelSunglasses: { amount: 2288 } } });

const c = store.compute(t.id);
ok('engine computes grand total 16798', Math.abs(c.payment.grandTotal - 16798) < 0.005);
ok('engine computes NET 13892', Math.abs(c.net - 13892) < 0.005);
await store.flush(); // _persist() is async; wait for the write to land
ok('updateTrip persisted to localStorage fallback', mem.has('dtt_state_v1'));

// finalize → locked; further edits rejected
const fin = store.finalizeTrip(t.id);
ok('finalize locks the trip', fin.status === 'finalized' && fin.finalizedAt);
ok('finalize snapshots net', fin.finalSnapshot && Math.abs(fin.finalSnapshot.net - 13892) < 0.005);
const blocked = store.updateTrip(t.id, { gcash: 999 });
ok('edits to a finalized trip are blocked', blocked === null && store.tripById(t.id).gcash === 0);

// reopen → editable again
store.reopenTrip(t.id, 'fix expense');
ok('reopen unlocks the trip', store.tripById(t.id).status === 'open');
store.updateTrip(t.id, { gcash: 13892 });
const c2 = store.compute(t.id);
ok('counting full remit balances short/over to 0', c2.balanced && Math.abs(c2.shortOver) < 0.005);

// activity log hash chain
const integ = store.verifyAuditIntegrity();
ok('activity log hash chain verifies', integ.ok && integ.brokenAtSeq === null);
ok('activity log recorded the lifecycle events', store.audit.some(e => e.action === 'trip.finalize') && store.audit.some(e => e.action === 'trip.reopen'));

// tamper detection: alter a stored audit entry and confirm the chain breaks
const victim = store.audit[2];
const savedWhat = victim.what;
victim.what = savedWhat + ' (tampered)';
const broken = store.verifyAuditIntegrity();
ok('tampering with the log is DETECTED', !broken.ok && broken.brokenAtSeq === victim.seq);
victim.what = savedWhat; // restore
ok('restoring the entry re-verifies the chain', store.verifyAuditIntegrity().ok);

// custom (ad-hoc) expense lines
const t2 = store.createTrip({ routeId: bihopa.id, date: '2026-05-03' });
const base = store.compute(t2.id).expenseTotal;
const row = store.addCustomExpense(t2.id, 'Speedboat fuel');
ok('addCustomExpense returns a row with an id', row && row.id);
row.unit = 2; row.amount = 150; store.updateTrip(t2.id, { customExpenses: t2.customExpenses });
const afterAdd = store.compute(t2.id);
ok('custom expense (2 × ₱150) adds ₱300 to expense total', Math.abs(afterAdd.expenseTotal - (base + 300)) < 0.005);
ok('expenseRows includes the custom row flagged custom', afterAdd.expenseRows.some(r => r.custom && r.label === 'Speedboat fuel' && Math.abs(r.expense - 300) < 0.005));
ok('NET stays = revenue − expenses with the custom line', Math.abs(afterAdd.net - (afterAdd.revenueTotal - afterAdd.expenseTotal)) < 0.005);
store.removeCustomExpense(t2.id, row.id);
ok('removeCustomExpense restores the total', Math.abs(store.compute(t2.id).expenseTotal - base) < 0.005);
store.finalizeTrip(t2.id);
ok('addCustomExpense blocked on a finalized trip', store.addCustomExpense(t2.id) === null);

// custom (ad-hoc) revenue lines (mirror of expenses)
const t3 = store.createTrip({ routeId: bihopa.id, date: '2026-05-04' });
const baseRev = store.compute(t3.id).revenueTotal;
const baseNet = store.compute(t3.id).net;
const rrow = store.addCustomRevenue(t3.id, 'Charter add-on');
rrow.unit = 1; rrow.amount = 2000; store.updateTrip(t3.id, { customRevenue: t3.customRevenue });
const afterRev = store.compute(t3.id);
ok('custom revenue (₱2000) adds to revenue total', Math.abs(afterRev.revenueTotal - (baseRev + 2000)) < 0.005);
ok('custom revenue raises NET by its amount', Math.abs(afterRev.net - (baseNet + 2000)) < 0.005);
ok('custom revenue is NOT counted as additional cash collected', Math.abs(afterRev.additionalCash) < 0.005);
ok('revenueRows includes the custom revenue row flagged custom', afterRev.revenueRows.some(r => r.custom && r.label === 'Charter add-on' && Math.abs(r.revenue - 2000) < 0.005));
store.removeCustomRevenue(t3.id, rrow.id);
ok('removeCustomRevenue restores the revenue total', Math.abs(store.compute(t3.id).revenueTotal - baseRev) < 0.005);
store.finalizeTrip(t3.id);
ok('addCustomRevenue blocked on a finalized trip', store.addCustomRevenue(t3.id) === null);

// inventory: CRUD, snapshots, start-new-count, restore, compare
ok('inventory starts empty', store.inventory.length === 0);
const inv1 = store.addInventoryItem({ name: 'Bottled Water', category: 'Drinks', uom: 'EA', count: '24', par: '50' });
store.addInventoryItem({ name: 'House Rum', category: 'Bar', uom: 'ML', count: '3', par: '2' });
ok('addInventoryItem adds items with ids', store.inventory.length === 2 && inv1.id);
ok('inventoryCategories lists distinct cats', store.inventoryCategories().join(',') === 'Bar,Drinks');
store.updateInventoryItem(inv1.id, { count: '10' });
ok('updateInventoryItem changes the count', store.inventoryItemById(inv1.id).count === '10');
const snap = store.saveInventorySnapshot('Before count');
ok('saveInventorySnapshot stores a copy', store.inventorySnapshots.length === 1 && snap.items.length === 2);
store.startNewCount('Fresh');
ok('startNewCount snapshots then clears counts (keeps par)', store.inventory.every(i => i.count === '') && store.inventoryItemById(inv1.id).par === '50' && store.inventorySnapshots.length === 2);
store.updateInventoryItem(inv1.id, { count: '40' }); // recount water 10 → 40
const cmp = store.compareToSnapshot(snap.id);
const waterRow = cmp.rows.find(r => r.name === 'Bottled Water');
ok('compareToSnapshot shows the recount delta (10 → 40)', waterRow && Math.abs(waterRow.delta - 30) < 0.005);
store.removeInventoryItem(inv1.id);
ok('removeInventoryItem deletes the item', store.inventory.length === 1);
store.restoreInventorySnapshot(snap.id);
ok('restoreInventorySnapshot brings the list back', store.inventory.length === 2);
const n = store.importInventory(parseCsvRows(), { replace: true });
ok('importInventory (replace) swaps the list', n === 2 && store.inventory.length === 2 && store.inventory[0].name === 'Imported A');

function parseCsvRows() { return [{ name: 'Imported A', category: 'X', uom: 'EA', count: '1', par: '' }, { name: 'Imported B', category: 'X', uom: 'EA', count: '2', par: '' }]; }

// export/import round-trip
const exported = store.exportData();
ok('export carries trips + audit', exported.state.trips.length === 3 && exported.meta.auditEvents > 0);
ok('export carries inventory + snapshots', Array.isArray(exported.state.inventory) && exported.state.inventory.length === 2 && exported.state.inventorySnapshots.length >= 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
