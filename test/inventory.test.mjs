// inventory.test.mjs — pure helpers for the stock inventory. Run: node test/inventory.test.mjs
import { parseQuantity, isLowStock, toCsv, parseCsv, compareInventories, clearedCounts, normalizeItem } from '../app/inventory.js';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { pass++; console.log('  ✓ ' + label); } else { fail++; console.error('  ✗ ' + label); } };
const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.005;

console.log('parseQuantity:');
ok('"2 Bot + 500mL" → 2.5', near(parseQuantity('2 Bot + 500mL'), 2.5));
ok('"147 Grams" → 147', near(parseQuantity('147 Grams'), 147));
ok('"10 L" → 10', near(parseQuantity('10 L'), 10));
ok('"24" → 24', near(parseQuantity('24'), 24));
ok('"" → null', parseQuantity('') === null);
ok('"no number" → null', parseQuantity('no number') === null);

console.log('isLowStock:');
ok('count 5 < par 10 → low', isLowStock({ count: '5', par: '10' }) === true);
ok('count 12 ≥ par 10 → not low', isLowStock({ count: '12', par: '10' }) === false);
ok('non-numeric count → not low', isLowStock({ count: 'plenty', par: '10' }) === false);
ok('no par → not low', isLowStock({ count: '5', par: '' }) === false);

console.log('CSV round-trip:');
const items = [
  { name: 'Bottled Water', category: 'Drinks', uom: 'EA', count: '24', par: '50' },
  { name: 'Rum, "house"', category: 'Bar', uom: 'ML', count: '2 Bot + 500mL', par: '' },
];
const back = parseCsv(toCsv(items));
ok('round-trips item count', back.length === 2 && back[0].name === 'Bottled Water' && back[0].count === '24');
ok('round-trips quoted name + free-text count', back[1].name === 'Rum, "house"' && back[1].count === '2 Bot + 500mL');

console.log('legacy MinOnHand CSV maps to count:');
const legacy = parseCsv('Name,Category,UOM,MinOnHand,Par\n"ABSOLUT VODKA","BAR","L","1 Bot + 760mL",""');
ok('4th column (MinOnHand) → count', legacy.length === 1 && legacy[0].count === '1 Bot + 760mL' && legacy[0].uom === 'L');

console.log('compareInventories:');
const before = [{ name: 'A', count: '10' }, { name: 'B', count: '4' }, { name: 'C', count: '3' }];
const after = [{ name: 'A', count: '15' }, { name: 'B', count: '2' }, { name: 'D', count: '7' }];
const cmp = compareInventories(before, after, 'count');
const rowA = cmp.rows.find(r => r.name === 'A');
ok('A 10→15 = +50%', near(rowA.pct, 50) && near(rowA.delta, 5));
ok('summary: 1 up, 1 down', cmp.summary.increased === 1 && cmp.summary.decreased === 1);
ok('D added, C removed', cmp.added.includes('D') && cmp.removed.includes('C'));

console.log('clearedCounts:');
const cleared = clearedCounts([{ id: 'x', name: 'A', category: 'Bar', uom: 'EA', count: '9', par: '20' }]);
ok('clears count, keeps par + id + name', cleared[0].count === '' && cleared[0].par === '20' && cleared[0].id === 'x' && cleared[0].name === 'A');

console.log('normalizeItem accepts onHand/min aliases:');
ok('reads onHand', normalizeItem({ name: 'X', onHand: '5' }).count === '5');
ok('reads min', normalizeItem({ name: 'Y', min: '7' }).count === '7');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
