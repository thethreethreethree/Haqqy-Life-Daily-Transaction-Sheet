// compute.js — the calculation core, PURE (no DOM, no storage). Every derived
// figure on a trip sheet is produced here from the trip's inputs + its route.
//
// This module is the faithful reconstruction of the spreadsheet's formulas:
//   • Pricing engine: a route has two base prices; each sales channel's price is
//     DERIVED (base × multiplier), never typed — mirrors J8:J14 in the sheet.
//   • Payment-method revenue: Σ(channel price × guests) split by how they paid
//     (cash / credit / paypal / OTA) + drink sales — mirrors J2:M2.
//   • Revenue ledger (cash side) and Expense ledger → NET = Revenue − Expenses,
//     which is the REMIT CASH figure (the trust-critical headline) — mirrors
//     D43 / E44 / E46.
//   • Cash count (denominations + Gcash) → Short(−)/Over(+) vs. the expected
//     remit — mirrors the denomination block and E52.
//
// Verified against the real sheet (May 2 BIHOPA): grand total 16,798 · revenue
// 21,720 · expenses 7,828 · NET 13,892 · 11 guests. See test/compute.test.mjs.

import { round2, num, uid, todayDate, nowISO } from './util.js';

// ---------------------------------------------------------------------------
// Sales channels. Price = route base × multiplier (DERIVED, like the sheet).
//   basis: which route base price (base1 = regular tour, base2 = OTA base)
//   mult:  discount multiplier applied to that base
//   split: true  → channel collects a cash/credit guest split (walk-in tiers)
//          false → all its guests pay by one fixed method (`method`)
// ---------------------------------------------------------------------------
export const CHANNELS = [
  { key: 'regular',    label: 'Regular',        basis: 'base1', mult: 1.0,  split: true },
  { key: 'discount10', label: '10% discount',   basis: 'base1', mult: 0.9,  split: true },
  { key: 'discount20', label: '20% reattendee', basis: 'base1', mult: 0.8,  split: true },
  { key: 'paypal',     label: 'Paypal Payment', basis: 'base1', mult: 1.0,  split: false, method: 'paypal' },
  { key: 'otaKlook',   label: 'OTA Klook',      basis: 'base2', mult: 0.8,  split: false, method: 'ota' },
  { key: 'otaGYG',     label: 'OTA GYG',        basis: 'base2', mult: 0.8,  split: false, method: 'ota' },
  { key: 'otaKKday',   label: 'OTA KKday',      basis: 'base2', mult: 0.85, split: false, method: 'ota' },
];

// Revenue ledger template (cash side). `derived` rows are computed, not typed:
//   totalCashSales = the cash collected from guests (the cash payment total).
// `group: 'fee'` rows are the add-on fees that sum to "additional cash collected".
export const REVENUE_ITEMS = [
  { key: 'totalCashSales', label: 'Total Cash Sales', derived: true, group: 'base' },
  { key: 'prevCashSales',  label: 'Cash sales from previous trip', group: 'carry' },
  { key: 'prevDrinkSales', label: 'HQ11 boat drink sales from previous trip', group: 'carry' },
  { key: 'cashFlow',       label: 'Cash Flow (from Ms Rebeca or reception)', group: 'carry' },
  { key: 'magicIslandFee', label: 'Magic Island Fee', group: 'fee' },
  { key: 'snorkelingFee',  label: 'Snorkeling Fee', group: 'fee' },
  { key: 'nabaoyFee',      label: 'Nabaoy Fee', group: 'fee' },
  { key: 'buruangaFee',    label: 'Buruanga Fee', group: 'fee' },
  { key: 'nabaoyDrink',    label: 'Nabaoy Drink Sales', group: 'fee' },
  { key: 'sunsetCruise',   label: 'Sunset Cruise (+ package)', group: 'fee' },
  { key: 'downPayment',    label: 'Down Payment (No Show)', group: 'fee' },
  { key: 'feeAdjustment',  label: 'fee (adjustment)', group: 'fee' },
];

// Expense ledger template (the costs paid out of the day's cash).
export const EXPENSE_ITEMS = [
  { key: 'hq11BoatPetty',   label: 'HQ 11 Boat Petty Cash' },
  { key: 'hq11DrinksPetty', label: 'HQ 11 Drinks Sales Petty Cash' },
  { key: 'coastGuardIH',    label: 'Coast Guard - IH' },
  { key: 'manifestIH',      label: 'Manifest - IH' },
  { key: 'manifestBPC',     label: 'Manifest - sBPC / CG' },
  { key: 'boatRental',      label: 'Boat Rental' },
  { key: 'jeepneyRental',   label: 'Jeepney rental' },
  { key: 'magicIslandReload', label: 'Magic Island Tickets reload' },
  { key: 'snorkelingFeeExp', label: 'Snorkeling Fee' },
  { key: 'nabaoyForeign',   label: 'Nabaoy Fee (Foreign)' },
  { key: 'nabaoyLocal',     label: 'Nabaoy Fee (Local)' },
  { key: 'buruangaFeeExp',  label: 'Buruanga Fee' },
  { key: 'parkingFee',      label: 'Parking Fee' },
  { key: 'foodProduction',  label: 'Food Production' },
  { key: 'drinkInventory',  label: 'Drink Inventory' },
  { key: 'foodPancit',      label: 'Food Production - Pancit' },
  { key: 'transportParaw',  label: 'transport (Paraw - Frendz)' },
  { key: 'parcelSunglasses', label: 'parcel - Sunglasses Props' },
];

// Cash denominations counted at remit (peso bills & coins).
export const DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1];

// ---------------------------------------------------------------------------
// Defaults / factory
// ---------------------------------------------------------------------------
export function defaultRoute(name = 'BIHOPA', base1 = 1490, base2 = 1990) {
  return { id: uid('route'), name, base1: round2(base1), base2: round2(base2), createdAt: nowISO(), active: true };
}

// The two routes seen in the source workbook.
export function seedRoutes() {
  return [
    defaultRoute('BIHOPA', 1490, 1990),
    defaultRoute('BBA', 1990, 2190),
  ];
}

// A blank trip sheet bound to a route (a snapshot of the route's prices is taken
// so a later price change never silently rewrites a past trip's figures).
export function defaultTrip(route) {
  const r = route || defaultRoute();
  const guests = {};
  for (const ch of CHANNELS) guests[ch.key] = ch.split ? { cash: 0, credit: 0 } : { count: 0 };
  const revenue = {};
  for (const it of REVENUE_ITEMS) if (!it.derived) revenue[it.key] = { unit: 1, amount: 0, notes: '' };
  const expenses = {};
  for (const it of EXPENSE_ITEMS) expenses[it.key] = { unit: 1, amount: 0, notes: '' };
  const cashCount = {};
  for (const d of DENOMINATIONS) cashCount[String(d)] = 0;
  return {
    id: uid('trip'),
    date: todayDate(),
    routeId: r.id,
    routeName: r.name,
    base1: r.base1,
    base2: r.base2,
    status: 'open',            // 'open' (editable) → 'finalized' (locked)
    createdAt: nowISO(),
    updatedAt: nowISO(),
    finalizedAt: null,
    guests,
    drinkSales: [],            // [{ id, name, unitPrice, qtyCash, qtyCC, qtyPaypal }]
    revenue,
    expenses,
    cashCount,
    gcash: 0,
    tickets: { inventory: 0, consumed: 0, purchased: 0 },
    note: '',
  };
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------
// The derived price for one channel given a trip's snapshotted base prices.
export function channelPrice(channel, trip) {
  const base = channel.basis === 'base2' ? num(trip.base2) : num(trip.base1);
  return round2(base * channel.mult);
}
// Guest count on a channel (split channels sum cash+credit).
export function channelGuests(channel, trip) {
  const g = (trip.guests && trip.guests[channel.key]) || {};
  return channel.split ? (num(g.cash) + num(g.credit)) : num(g.count);
}

// ---------------------------------------------------------------------------
// Drink sales → per-method totals (mirrors the J16:L17 drink mini-table).
// ---------------------------------------------------------------------------
export function drinkTotals(trip) {
  let cash = 0, cc = 0, paypal = 0;
  for (const d of (trip.drinkSales || [])) {
    const p = num(d.unitPrice);
    cash += p * num(d.qtyCash);
    cc += p * num(d.qtyCC);
    paypal += p * num(d.qtyPaypal);
  }
  return { cash: round2(cash), cc: round2(cc), paypal: round2(paypal), total: round2(cash + cc + paypal) };
}

// ---------------------------------------------------------------------------
// Payment-method revenue (mirrors J2 / K2 / L2 / M2 and the grand total N2).
//   cash   = Σ split-channel price × cash-paying guests   + drink cash
//   cc     = Σ split-channel price × credit-paying guests + drink cc
//   paypal = paypal price × paypal guests                 + drink paypal
//   ota    = Σ OTA-channel price × guests
// ---------------------------------------------------------------------------
export function paymentTotals(trip) {
  const drinks = drinkTotals(trip);
  let cash = drinks.cash, cc = drinks.cc, paypal = drinks.paypal, ota = 0;
  for (const ch of CHANNELS) {
    const price = channelPrice(ch, trip);
    const g = (trip.guests && trip.guests[ch.key]) || {};
    if (ch.split) {
      cash += price * num(g.cash);
      cc += price * num(g.credit);
    } else if (ch.method === 'paypal') {
      paypal += price * num(g.count);
    } else { // ota
      ota += price * num(g.count);
    }
  }
  cash = round2(cash); cc = round2(cc); paypal = round2(paypal); ota = round2(ota);
  return { cash, cc, paypal, ota, grandTotal: round2(cash + cc + paypal + ota) };
}

// Total guests across all channels (mirrors I2 = sum of guest counts).
export function totalGuests(trip) {
  let n = 0;
  for (const ch of CHANNELS) n += channelGuests(ch, trip);
  return n;
}

// ---------------------------------------------------------------------------
// Revenue ledger (cash side). The derived "Total Cash Sales" row = cash payment
// total. Each typed row's revenue = unit × amount. Returns rows + totals.
// ---------------------------------------------------------------------------
export function revenueRows(trip) {
  const pay = paymentTotals(trip);
  return REVENUE_ITEMS.map((it) => {
    if (it.derived) {
      return { ...it, unit: 1, amount: pay.cash, revenue: pay.cash, notes: '' };
    }
    const v = (trip.revenue && trip.revenue[it.key]) || { unit: 1, amount: 0 };
    const revenue = round2(num(v.unit) * num(v.amount));
    return { ...it, unit: num(v.unit), amount: num(v.amount), revenue, notes: v.notes || '' };
  });
}
export function expenseRows(trip) {
  return EXPENSE_ITEMS.map((it) => {
    const v = (trip.expenses && trip.expenses[it.key]) || { unit: 1, amount: 0 };
    const expense = round2(num(v.unit) * num(v.amount));
    return { ...it, unit: num(v.unit), amount: num(v.amount), expense, notes: v.notes || '' };
  });
}

// ---------------------------------------------------------------------------
// Cash count → counted total (denominations + Gcash).
// ---------------------------------------------------------------------------
export function cashCountTotal(trip) {
  let bills = 0;
  for (const d of DENOMINATIONS) bills += d * num((trip.cashCount || {})[String(d)]);
  const gcash = num(trip.gcash);
  return { bills: round2(bills), gcash: round2(gcash), total: round2(bills + gcash) };
}

// ---------------------------------------------------------------------------
// The full computed view of a trip — everything the UI renders. One call.
// ---------------------------------------------------------------------------
export function computeTrip(trip) {
  const pay = paymentTotals(trip);
  const rev = revenueRows(trip);
  const exp = expenseRows(trip);
  const revenueTotal = round2(rev.reduce((s, r) => s + r.revenue, 0));
  const expenseTotal = round2(exp.reduce((s, r) => s + r.expense, 0));
  // "additional cash collected" = the add-on fees (Magic Island, Snorkeling, …),
  // i.e. cash taken on top of the base tour price (the sheet's O1 = sum of fees).
  const additionalCash = round2(rev.filter((r) => r.group === 'fee').reduce((s, r) => s + r.revenue, 0));
  const net = round2(revenueTotal - expenseTotal); // NET = REMIT CASH (cash to hand over)
  const count = cashCountTotal(trip);
  const shortOver = round2(count.total - net);     // − short, + over, 0 balanced
  const t = trip.tickets || {};
  const ticketsOnHand = num(t.inventory) - num(t.consumed) + num(t.purchased);
  return {
    payment: pay,
    guests: totalGuests(trip),
    drinks: drinkTotals(trip),
    revenueRows: rev,
    expenseRows: exp,
    revenueTotal,
    expenseTotal,
    additionalCash,
    net,
    remit: net,
    count,
    shortOver,
    balanced: Math.abs(shortOver) < 0.005,
    tickets: { ...t, onHand: ticketsOnHand },
  };
}
