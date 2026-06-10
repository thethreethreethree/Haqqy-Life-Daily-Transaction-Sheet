// compute.test.mjs — verifies the calculation core reproduces the SOURCE SHEET
// exactly. Run: node test/compute.test.mjs
//
// Data below is the real "May 2 - BIHOPA" worksheet, read from the .xlsx:
//   route BIHOPA base1=1490 base2=1990
//   guests: Regular 3 cash / 2 credit · Paypal 2 · OTA Klook 2 · OTA GYG 2
//   revenue: prev cash 7000 · Cash Flow 5000 · Magic Island 15×250 · Snorkeling 15×100
//   expenses: Coast Guard 200 · Manifest 600 · Magic Island reload 15×220 ·
//             Snorkeling 11×100 · Pancit 250 · transport 2×45 · parcel 2288
// Expected (cells verified): grand total 16798 · revenue 21720 · expenses 7828 ·
//   NET 13892 · guests 11 · additional cash 5250.

import { defaultTrip, defaultRoute, computeTrip } from '../app/compute.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  const ok = Math.abs(Number(got) - Number(want)) < 0.005;
  if (ok) { pass++; console.log(`  ✓ ${label} = ${got}`); }
  else { fail++; console.error(`  ✗ ${label}: got ${got}, want ${want}`); }
}

// ---- build the May 2 BIHOPA trip from the real numbers ----
const route = defaultRoute('BIHOPA', 1490, 1990);
const trip = defaultTrip(route);
trip.guests.regular = { cash: 3, credit: 2 };
trip.guests.paypal = { count: 2 };
trip.guests.otaKlook = { count: 2 };
trip.guests.otaGYG = { count: 2 };
trip.guests.otaKKday = { count: 0 };
trip.revenue.prevCashSales = { unit: 1, amount: 7000, notes: '' };
trip.revenue.cashFlow = { unit: 1, amount: 5000, notes: 'c/o Jae' };
trip.revenue.magicIslandFee = { unit: 15, amount: 250, notes: '' };
trip.revenue.snorkelingFee = { unit: 15, amount: 100, notes: '' };
trip.expenses.coastGuardIH = { unit: 1, amount: 200, notes: '' };
trip.expenses.manifestIH = { unit: 1, amount: 600, notes: '' };
trip.expenses.magicIslandReload = { unit: 15, amount: 220, notes: '' };
trip.expenses.snorkelingFeeExp = { unit: 11, amount: 100, notes: '' };
trip.expenses.foodPancit = { unit: 1, amount: 250, notes: '' };
trip.expenses.transportParaw = { unit: 2, amount: 45, notes: '' };
trip.expenses.parcelSunglasses = { unit: 1, amount: 2288, notes: '' };

const c = computeTrip(trip);

console.log('May 2 - BIHOPA:');
eq('payment.cash', c.payment.cash, 4470);
eq('payment.cc', c.payment.cc, 2980);
eq('payment.paypal', c.payment.paypal, 2980);
eq('payment.ota', c.payment.ota, 6368);
eq('grand total', c.payment.grandTotal, 16798);
eq('total guests', c.guests, 11);
eq('additional cash collected', c.additionalCash, 5250);
eq('revenue total', c.revenueTotal, 21720);
eq('expense total', c.expenseTotal, 7828);
eq('NET / remit', c.net, 13892);
eq('short/over (nothing counted)', c.shortOver, -13892);

// ---- BBA pricing sanity (base1=1990 base2=2190): derived channel prices ----
const bba = defaultTrip(defaultRoute('BBA', 1990, 2190));
const cb = computeTrip(bba); // all-zero guests
console.log('\nBBA pricing (derived):');
// price checks via a single guest in each channel
function priceOf(key) {
  const t = defaultTrip(defaultRoute('BBA', 1990, 2190));
  if (t.guests[key].count != null) t.guests[key] = { count: 1 };
  else t.guests[key] = { cash: 1, credit: 0 };
  const r = computeTrip(t);
  return r.payment.cash + r.payment.cc + r.payment.paypal + r.payment.ota;
}
eq('BBA Regular price', priceOf('regular'), 1990);
eq('BBA 10% discount', priceOf('discount10'), 1791);
eq('BBA 20% reattendee', priceOf('discount20'), 1592);
eq('BBA OTA Klook (base2×0.8)', priceOf('otaKlook'), 1752);
eq('BBA OTA KKday (base2×0.85)', priceOf('otaKKday'), 1861.5);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
