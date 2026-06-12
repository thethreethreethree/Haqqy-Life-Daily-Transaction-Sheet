// dom.render.mjs — renders the views in a real DOM (jsdom) to confirm they build
// without throwing AND that live recalculation works. Run: node test/dom.render.mjs
// (jsdom must be installed: npm i jsdom --no-save)
import { JSDOM } from 'jsdom';
const dom = new JSDOM('<!DOCTYPE html><body><div id="app"></div></body>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.Event = dom.window.Event;
globalThis.indexedDB = undefined; // force localStorage fallback (jsdom has localStorage)

const { store } = await import('../app/store.js');
const sheet = await import('../app/views/sheet.js');
const trips = await import('../app/views/trips.js');
const activity = await import('../app/views/activity.js');
const inventory = await import('../app/views/inventory.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.error('  ✗ ' + label); } };

await store.load();
store.completeSetup({ brand: 'Haqqy Life · Boracay', staffName: 'Maya' });
const bihopa = store.activeRoutes().find(r => r.name === 'BIHOPA');
const t = store.createTrip({ routeId: bihopa.id, date: '2026-05-02' });
store.updateTrip(t.id, { guests: { regular: { cash: 3, credit: 2 }, paypal: { count: 2 }, otaKlook: { count: 2 }, otaGYG: { count: 2 } } });
store.updateTrip(t.id, { revenue: { prevCashSales: { amount: 7000 }, cashFlow: { amount: 5000 }, magicIslandFee: { unit: 15, amount: 250 }, snorkelingFee: { unit: 15, amount: 100 } } });
store.updateTrip(t.id, { expenses: { coastGuardIH: { amount: 200 }, manifestIH: { amount: 600 }, magicIslandReload: { unit: 15, amount: 220 }, snorkelingFeeExp: { unit: 11, amount: 100 }, foodPancit: { amount: 250 }, transportParaw: { unit: 2, amount: 45 }, parcelSunglasses: { amount: 2288 } } });

const ctx = { navigate: () => {}, store, args: { tripId: t.id } };

// ---- sheet view renders with correct derived figures ----
let root;
try { root = sheet.render(ctx); document.body.appendChild(root); ok('sheet view renders without throwing', true); }
catch (e) { ok('sheet view renders without throwing', false); console.error('   ', e); }
if (root) {
  const html = root.textContent;
  ok('sheet shows grand total ₱16,798.00', html.includes('16,798.00'));
  ok('sheet shows NET ₱13,892.00', html.includes('13,892.00'));
  ok('sheet shows revenue total ₱21,720.00', html.includes('21,720.00'));
  ok('sheet shows expense total ₱7,828.00', html.includes('7,828.00'));

  // live recalc: bump Regular cash 3 → 4 (one more cash guest @ ₱1,490)
  const nums = root.querySelectorAll('input[type=number]');
  const regularCash = nums[0];
  ok('found the Regular-cash input', !!regularCash && regularCash.value === '3');
  if (regularCash) {
    regularCash.value = '4';
    regularCash.dispatchEvent(new Event('input'));
    const grand = root.querySelector('.pay-v.strong').textContent;
    ok('live recalc updates grand total to ₱18,288.00', grand.includes('18,288.00'));
    const net = root.querySelector('.recon-net-v').textContent;
    ok('live recalc updates NET to ₱15,382.00', net.includes('15,382.00')); // 13892 + 1490
  }
}

// ---- "add new expense" feature: custom row + button render ----
store.addCustomExpense(t.id, 'Speedboat fuel');
const ce = t.customExpenses[0]; ce.unit = 1; ce.amount = 500; store.updateTrip(t.id, { customExpenses: t.customExpenses });
const root2 = sheet.render({ navigate: () => {}, store, args: { tripId: t.id } });
const customLabel = root2.querySelector('.custom-row input'); // label lives in an <input> (not textContent)
ok('custom expense row renders with its label', !!customLabel && customLabel.value === 'Speedboat fuel');
ok('"+ Add expense" button is present', root2.textContent.includes('+ Add expense'));
ok('custom expense (₱500) lifts expense total to ₱8,328.00', root2.textContent.includes('8,328.00'));
ok('add buttons live in card headers (revenue + expenses)', root2.querySelectorAll('.card-h .btn').length >= 2);

// the bug fix: clicking + Add expense inserts a row IN PLACE without navigating
// (navigate() runs window.scrollTo(0,0) → the page jump the user reported).
let navCalls = 0;
const root3 = sheet.render({ navigate: () => { navCalls++; }, store, args: { tripId: t.id } });
const beforeRows = root3.querySelectorAll('.custom-row').length;
const addButton = [...root3.querySelectorAll('button')].find(b => b.textContent.includes('Add expense'));
ok('add button found', !!addButton);
addButton.dispatchEvent(new Event('click'));
ok('clicking add inserts a row in place (+1)', root3.querySelectorAll('.custom-row').length === beforeRows + 1);
ok('clicking add does NOT navigate (so the page cannot jump)', navCalls === 0);
const expBody = addButton.closest('.card').querySelector('tbody'); // scope to the Expenses card
ok('custom rows render above the template rows', expBody.firstChild.classList.contains('custom-row'));

// ---- "add new revenue source" on the Revenue card (mirror of expenses) ----
store.addCustomRevenue(t.id, 'Charter add-on');
const cr = t.customRevenue[0]; cr.unit = 1; cr.amount = 2000; store.updateTrip(t.id, { customRevenue: t.customRevenue });
const root4 = sheet.render({ navigate: () => {}, store, args: { tripId: t.id } });
const revBtn = [...root4.querySelectorAll('button')].find(b => b.textContent.includes('Add revenue source'));
ok('"+ Add revenue source" button present on Revenue card', !!revBtn);
ok('custom revenue row renders with its label', !![...root4.querySelectorAll('.custom-row input')].find(i => i.value === 'Charter add-on'));

// ---- trips list renders ----
try { const r = trips.render({ navigate: () => {}, store, args: null }); document.body.appendChild(r); ok('trips view renders; lists the BIHOPA trip', r.textContent.includes('BIHOPA')); }
catch (e) { ok('trips view renders', false); console.error('   ', e); }

// ---- inventory view renders (items, low-stock, toolbar) ----
store.addInventoryItem({ name: 'Bottled Water', category: 'Drinks', uom: 'EA', count: '5', par: '50' }); // low
store.addInventoryItem({ name: 'Ice', category: 'Drinks', uom: 'KG', count: '100', par: '10' });         // ok
let invRoot;
try { invRoot = inventory.render({ navigate: () => {}, store, args: null }); document.body.appendChild(invRoot); ok('inventory view renders without throwing', true); }
catch (e) { ok('inventory view renders without throwing', false); console.error('   ', e); }
if (invRoot) {
  ok('inventory lists an item', invRoot.textContent.includes('Bottled Water'));
  ok('low-stock row is flagged', !!invRoot.querySelector('.inv-table tr.low'));
  ok('toolbar has Import/Export CSV', invRoot.textContent.includes('Import CSV') && invRoot.textContent.includes('Export CSV'));
  ok('+ Add item button present', [...invRoot.querySelectorAll('button')].some(b => b.textContent.includes('Add item')));
}

// ---- activity log renders & reports verified chain ----
try { const r = activity.render(); document.body.appendChild(r); ok('activity view renders; chain shows "verified"', r.textContent.includes('verified')); }
catch (e) { ok('activity view renders', false); console.error('   ', e); }

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
