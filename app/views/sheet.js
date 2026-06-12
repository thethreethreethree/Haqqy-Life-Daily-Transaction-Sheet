// views/sheet.js — the trip sheet editor/viewer. Renders all blocks of one
// trip and recalculates derived figures live as inputs change.
//
// Live-recalc strategy: the DOM (inputs) is built ONCE. Each input writes its
// value straight into the trip via store.updateTrip(), then calls recalc(),
// which re-runs computeTrip() and updates only the OUTPUT nodes (totals, prices,
// short/over) registered in `outs`. Inputs are never rebuilt, so focus/caret are
// never lost mid-typing.
import { el, peso, pesoPlain, intPlain, num, fmtPlainDate, fmtDateTime, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, confirmDialog, promptDialog } from '../components.js';
import { CHANNELS, REVENUE_ITEMS, EXPENSE_ITEMS, DENOMINATIONS, computeTrip, channelPrice } from '../compute.js';

export function render(ctx) {
  const trip = store.tripById(ctx.args && ctx.args.tripId);
  const root = el('div');
  if (!trip) {
    root.appendChild(pageHead('Trip not found', 'It may have been deleted.'));
    root.appendChild(el('button', { class: 'btn primary', text: '← Back to trips', onClick: () => ctx.navigate('trips') }));
    return root;
  }

  const locked = trip.status === 'finalized';
  // Output nodes refreshed by recalc(): each is { node, get } where get(c) → text.
  const outs = [];
  const reg = (node, get) => { outs.push({ node, get }); return node; };

  function recalc() {
    const c = computeTrip(trip);
    for (const o of outs) o.node.textContent = o.get(c);
    // status-driven classes
    const so = root.querySelector('.shortover-badge');
    if (so) {
      so.className = 'shortover-badge ' + (c.balanced ? 'ok' : (c.shortOver < 0 ? 'short' : 'over'));
    }
    return c;
  }

  // A numeric input bound to a getter/setter into the trip.
  function numInput(getVal, setVal, { step = '0.01', cls = 'input num', min = null } = {}) {
    const inp = el('input', {
      class: cls, type: 'number', step, value: String(getVal() ?? 0),
      inputmode: 'decimal', disabled: locked || false,
    });
    if (min != null) inp.setAttribute('min', String(min));
    inp.addEventListener('input', () => { setVal(num(inp.value)); recalc(); });
    inp.addEventListener('focus', () => inp.select());
    return inp;
  }
  function textInput(getVal, setVal, placeholder = '') {
    const inp = el('input', { class: 'input', type: 'text', value: getVal() || '', placeholder, disabled: locked || false });
    inp.addEventListener('input', () => setVal(inp.value));
    return inp;
  }
  const upd = (patch) => store.updateTrip(trip.id, patch);

  // -------------------------------------------------------------- page header
  root.appendChild(pageHead(
    `${trip.routeName} · ${fmtPlainDate(trip.date)}`,
    locked ? `Finalised ${fmtDateTime(trip.finalizedAt)}` : 'Editing — fill in the day’s figures',
    el('div', { class: 'flex gap aic' }, [
      el('button', { class: 'btn ghost sm', text: '← Trips', onClick: () => ctx.navigate('trips') }),
      el('span', { class: `tag ${locked ? 'locked' : 'open'}`, text: locked ? '🔒 Finalised' : '● Open' }),
    ]),
  ));

  if (locked) {
    root.appendChild(el('div', { class: 'banner locked' }, [
      el('span', { html: '🔒 This sheet is <b>finalised and locked</b>. Reopen it to make changes.' }),
      el('button', { class: 'btn sm', text: 'Reopen', onClick: () => doReopen() }),
    ]));
  }

  // -------------------------------------------------- trip meta (date + route)
  const meta = el('div', { class: 'card' }, [
    el('div', { class: 'grid cols-3 gap' }, [
      field('Trip date', (() => {
        const inp = el('input', { class: 'input', type: 'date', value: trip.date, disabled: locked });
        inp.addEventListener('change', () => { upd({ date: inp.value }); toast('Date updated'); });
        return inp;
      })()),
      field('Route', (() => {
        const sel = el('select', { class: 'input', disabled: locked });
        for (const r of store.activeRoutes()) {
          sel.appendChild(el('option', { value: r.id, text: `${r.name} (₱${pesoPlain(r.base1)} / ₱${pesoPlain(r.base2)})`, selected: r.id === trip.routeId ? 'selected' : null }));
        }
        sel.addEventListener('change', () => {
          store.setTripRoute(trip.id, sel.value);
          ctx.navigate('sheet', { tripId: trip.id }); // re-render: prices changed
        });
        return sel;
      })()),
      field('Note', textInput(() => trip.note, (v) => upd({ note: v }), 'optional')),
    ]),
  ]);
  root.appendChild(meta);

  // ----------------------------------------------- payment summary (hero band)
  const heroVals = el('div', { class: 'pay-grid' });
  const payCell = (label, getter, cls = '') => {
    const v = el('div', { class: 'pay-v ' + cls });
    reg(v, getter);
    return el('div', { class: 'pay-cell' }, [el('div', { class: 'pay-k', text: label }), v]);
  };
  heroVals.appendChild(payCell('Cash', (c) => peso(c.payment.cash), 'in'));
  heroVals.appendChild(payCell('Credit Card', (c) => peso(c.payment.cc)));
  heroVals.appendChild(payCell('Paypal', (c) => peso(c.payment.paypal)));
  heroVals.appendChild(payCell('OTA', (c) => peso(c.payment.ota)));
  heroVals.appendChild(payCell('Grand total', (c) => peso(c.payment.grandTotal), 'strong'));
  heroVals.appendChild(payCell('Total guests', (c) => intPlain(c.guests)));
  heroVals.appendChild(payCell('Additional cash collected', (c) => peso(c.additionalCash)));
  root.appendChild(el('div', { class: 'card hero-pay' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Payment summary' }), el('span', { class: 'sub', text: 'auto-calculated from guests × price' })]),
    heroVals,
  ]));

  // ---------------------------------------------- guests & pricing (channels)
  const gWrap = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Guests & pricing' }), el('span', { class: 'sub', text: 'price is derived from the route base × discount' })]),
  ]);
  const gTbl = el('table', { class: 'tbl sheet-tbl' });
  gTbl.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Channel' }), el('th', { class: 'num', text: 'Price' }),
    el('th', { class: 'num', text: 'Cash' }), el('th', { class: 'num', text: 'Credit' }),
    el('th', { class: 'num', text: 'Guests' }), el('th', { class: 'num', text: 'Revenue' }),
  ])));
  const gBody = el('tbody');
  for (const ch of CHANNELS) {
    const price = channelPrice(ch, trip);
    let cashCell, creditCell;
    if (ch.split) {
      cashCell = el('td', { class: 'num' }, numInput(
        () => trip.guests[ch.key].cash,
        (v) => upd({ guests: { [ch.key]: { cash: v } } }),
        { step: '1', cls: 'input num sm', min: 0 }));
      creditCell = el('td', { class: 'num' }, numInput(
        () => trip.guests[ch.key].credit,
        (v) => upd({ guests: { [ch.key]: { credit: v } } }),
        { step: '1', cls: 'input num sm', min: 0 }));
    } else {
      // single count → goes to its fixed method (paypal / OTA)
      const span = el('td', { class: 'num', colspan: '2' }, numInput(
        () => trip.guests[ch.key].count,
        (v) => upd({ guests: { [ch.key]: { count: v } } }),
        { step: '1', cls: 'input num sm', min: 0 }));
      cashCell = span; creditCell = null;
    }
    const guestsOut = reg(el('span'), (c) => intPlain(channelGuestsFor(ch, c, trip)));
    const revOut = reg(el('span'), (c) => peso(channelRevenueFor(ch, trip)));
    const row = el('tr', {}, [
      el('td', {}, [el('strong', { text: ch.label }), el('div', { class: 'muted xs', text: payLabel(ch) })]),
      el('td', { class: 'num mono', text: peso(price) }),
    ]);
    row.appendChild(cashCell);
    if (creditCell) row.appendChild(creditCell);
    row.appendChild(el('td', { class: 'num' }, guestsOut));
    row.appendChild(el('td', { class: 'num amt-in' }, revOut));
    gBody.appendChild(row);
  }
  gTbl.appendChild(gBody);
  gWrap.appendChild(el('div', { class: 'table-wrap' }, gTbl));
  root.appendChild(gWrap);

  // ------------------------------------------------------------ drink sales
  root.appendChild(drinkSalesCard(trip, locked, upd, recalc, ctx));

  // --------------------------------------------------------- revenue ledger
  root.appendChild(ledgerCard({
    title: 'Revenue', sub: 'cash side — what came in', cls: 'in',
    items: REVENUE_ITEMS, kind: 'revenue', trip, locked, upd, recalc, reg, numInput, textInput,
    totalGet: (c) => c.revenueTotal, ctx,
    customField: 'customRevenue', addLabel: '+ Add revenue source', placeholder: 'revenue source',
  }));

  // --------------------------------------------------------- expense ledger
  root.appendChild(ledgerCard({
    title: 'Expenses', sub: 'costs paid out of the day’s cash', cls: 'out',
    items: EXPENSE_ITEMS, kind: 'expenses', trip, locked, upd, recalc, reg, numInput, textInput,
    totalGet: (c) => c.expenseTotal, ctx,
    customField: 'customExpenses', addLabel: '+ Add expense', placeholder: 'expense name',
  }));

  // ----------------------------------------------------- cash reconciliation
  root.appendChild(reconCard(trip, locked, upd, numInput, reg));

  // ------------------------------------------------------- ticket inventory
  root.appendChild(ticketCard(trip, locked, upd, numInput, reg));

  // ---------------------------------------------------------- finalize bar
  if (!locked) {
    root.appendChild(el('div', { class: 'finalize-bar' }, [
      el('div', { class: 'muted', text: 'When the day is counted and balanced, finalise to lock this sheet.' }),
      el('button', { class: 'btn primary', text: '🔒 Finalise & lock', onClick: () => doFinalize() }),
    ]));
  }

  function doFinalize() {
    const c = computeTrip(trip);
    const warn = c.balanced ? '' : `\n\n⚠ Cash count is ${c.shortOver < 0 ? 'SHORT' : 'OVER'} by ₱${pesoPlain(Math.abs(c.shortOver))}.`;
    confirmDialog({
      title: 'Finalise this trip sheet?',
      sub: `NET / remit will lock at ₱${pesoPlain(c.net)}.${warn}\n\nYou can reopen it later if needed.`,
      confirmLabel: 'Finalise & lock', kind: 'primary',
      onConfirm: () => { store.finalizeTrip(trip.id); toast('Trip finalised & locked'); ctx.navigate('sheet', { tripId: trip.id }); },
    });
  }
  function doReopen() {
    promptDialog({
      title: 'Reopen this sheet?', sub: 'It will become editable again. This is recorded in the activity log.',
      label: 'Reason (optional)', placeholder: 'e.g. correcting expense entry', confirmLabel: 'Reopen',
      onSubmit: (reason) => { store.reopenTrip(trip.id, reason); toast('Trip reopened'); ctx.navigate('sheet', { tripId: trip.id }); },
    });
  }

  recalc();
  return root;
}

// ---- small helpers --------------------------------------------------------
function field(label, control) {
  return el('div', { class: 'field' }, [el('label', { text: label }), control]);
}
function payLabel(ch) {
  if (ch.split) return 'cash / credit';
  return ch.method === 'paypal' ? 'paypal' : 'OTA';
}
function channelGuestsFor(ch, c, trip) {
  const g = trip.guests[ch.key] || {};
  return ch.split ? (num(g.cash) + num(g.credit)) : num(g.count);
}
function channelRevenueFor(ch, trip) {
  const price = channelPrice(ch, trip);
  const g = trip.guests[ch.key] || {};
  const n = ch.split ? (num(g.cash) + num(g.credit)) : num(g.count);
  return price * n;
}

// A revenue/expense ledger card (Description · unit · amount · total · notes).
function ledgerCard({ title, sub, cls, items, kind, trip, locked, upd, recalc, reg, numInput, textInput, totalGet, ctx, customField, addLabel, placeholder }) {
  const custom = !!customField; // custom (ad-hoc) rows enabled when a field is given
  const tbl = el('table', { class: 'tbl sheet-tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {}, [
    el('th', { text: 'Description' }), el('th', { class: 'num', text: 'Unit' }),
    el('th', { class: 'num', text: 'Amount' }), el('th', { class: 'num', text: title === 'Revenue' ? 'Revenue' : 'Expense' }),
    el('th', { text: 'Notes' }),
  ])));
  const body = el('tbody');

  // Build one editable custom row. Its line total is updated INLINE (not via the
  // recalc registry), so removing the row leaves no dangling registered node and
  // add/remove can be done purely in the DOM — no full re-render, no scroll jump.
  function makeCustomRow(c) {
    const lineOut = el('span', { text: peso(num(c.unit) * num(c.amount)) });
    const persist = () => store.updateTrip(trip.id, { [customField]: trip[customField] });
    const refresh = () => { lineOut.textContent = peso(num(c.unit) * num(c.amount)); recalc(); };
    const labelInp = el('input', { class: 'input sm', type: 'text', value: c.label || '', placeholder: placeholder || 'name', disabled: locked || false });
    labelInp.addEventListener('input', () => { c.label = labelInp.value; persist(); });
    const mkNum = (key, step) => {
      const inp = el('input', { class: 'input num sm', type: 'number', step, min: '0', value: String(c[key] ?? 0), disabled: locked || false });
      inp.addEventListener('input', () => { c[key] = num(inp.value); persist(); refresh(); });
      inp.addEventListener('focus', () => inp.select());
      return inp;
    };
    const noteInp = el('input', { class: 'input sm', type: 'text', value: c.notes || '', disabled: locked || false });
    noteInp.addEventListener('input', () => { c.notes = noteInp.value; persist(); });
    const del = el('button', {
      class: 'btn ghost xs', text: '✕', title: 'Remove this line', disabled: locked || false,
      onClick: () => { store.removeCustomLine(trip.id, customField, c.id); const tr = del.closest('tr'); if (tr) tr.remove(); recalc(); },
    });
    return el('tr', { class: 'custom-row' }, [
      el('td', {}, labelInp),
      el('td', { class: 'num' }, mkNum('unit', '1')),
      el('td', { class: 'num' }, mkNum('amount', '0.01')),
      el('td', { class: 'num amt-' + cls }, lineOut),
      el('td', {}, el('div', { class: 'flex gap aic' }, [noteInp, del])),
    ]);
  }

  // Custom rows render at the TOP of the list, so a newly-added one appears right
  // under the header (where the add button lives) — visible without scrolling.
  if (custom) for (const c of (trip[customField] || [])) body.appendChild(makeCustomRow(c));

  let firstTemplateRow = null;
  for (const it of items) {
    const lineOut = el('span');
    if (it.derived) {
      // Total Cash Sales — computed (= cash collected from guests). Read-only.
      reg(lineOut, (c) => peso(c.payment.cash));
      const row = el('tr', { class: 'derived-row' }, [
        el('td', {}, [el('strong', { text: it.label }), el('div', { class: 'muted xs', text: 'auto = cash from guests' })]),
        el('td', { class: 'num muted', text: '—' }),
        el('td', { class: 'num muted', text: '—' }),
        el('td', { class: 'num amt-' + cls }, lineOut),
        el('td', {}, ''),
      ]);
      if (!firstTemplateRow) firstTemplateRow = row;
      body.appendChild(row);
      continue;
    }
    const bucket = trip[kind][it.key];
    reg(lineOut, () => peso(num(bucket.unit) * num(bucket.amount)));
    const unitInp = numInput(() => bucket.unit, (v) => upd({ [kind]: { [it.key]: { unit: v } } }), { step: '1', cls: 'input num sm', min: 0 });
    const amtInp = numInput(() => bucket.amount, (v) => upd({ [kind]: { [it.key]: { amount: v } } }), { step: '0.01', cls: 'input num', min: 0 });
    const noteInp = textInput(() => bucket.notes, (v) => upd({ [kind]: { [it.key]: { notes: v } } }), '');
    const row = el('tr', {}, [
      el('td', { text: it.label }),
      el('td', { class: 'num' }, unitInp),
      el('td', { class: 'num' }, amtInp),
      el('td', { class: 'num amt-' + cls }, lineOut),
      el('td', {}, noteInp),
    ]);
    if (!firstTemplateRow) firstTemplateRow = row;
    body.appendChild(row);
  }
  tbl.appendChild(body);

  const totOut = el('span', { class: 'big' });
  reg(totOut, (c) => peso(totalGet(c)));
  tbl.appendChild(el('tfoot', {}, el('tr', {}, [
    el('td', { colspan: '3', class: 'ttl-label', text: `Total ${title.toLowerCase()}` }),
    el('td', { class: 'num amt-' + cls }, totOut),
    el('td', {}, ''),
  ])));

  // Header. The add button sits here (top-right). Clicking inserts a row IN PLACE
  // at the top of the list and recalculates — no navigate(), so the page can't jump.
  const addBtn = (custom && !locked) ? el('button', {
    class: 'btn primary sm', text: addLabel || '+ Add line',
    onClick: () => {
      const row = store.addCustomLine(trip.id, customField);
      if (!row) return;
      const tr = makeCustomRow(row);
      if (firstTemplateRow) body.insertBefore(tr, firstTemplateRow); else body.appendChild(tr);
      recalc();
      const inp = tr.querySelector('input');
      if (inp && inp.focus) { try { inp.focus({ preventScroll: true }); } catch (e) { /* older browsers */ } }
    },
  }) : null;

  return el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [
      el('h3', { text: title }),
      el('div', { class: 'flex gap aic' }, [el('span', { class: 'sub', text: sub }), addBtn]),
    ]),
    el('div', { class: 'table-wrap' }, tbl),
  ]);
}

// Drink sales mini-table (per-method quantities → feeds cash/cc/paypal).
function drinkSalesCard(trip, locked, upd, recalc, ctx) {
  const wrap = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Drink sales' }), el('span', { class: 'sub', text: 'optional — adds to cash / cc / paypal' })]),
  ]);
  if (!trip.drinkSales.length) {
    wrap.appendChild(el('p', { class: 'muted', style: 'margin:4px 0', text: 'No drink sales recorded.' }));
  } else {
    const tbl = el('table', { class: 'tbl sheet-tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Drink' }), el('th', { class: 'num', text: 'Unit ₱' }),
      el('th', { class: 'num', text: 'Cash qty' }), el('th', { class: 'num', text: 'CC qty' }),
      el('th', { class: 'num', text: 'Paypal qty' }), el('th', {}),
    ])));
    const body = el('tbody');
    trip.drinkSales.forEach((d, i) => {
      const mk = (key, step = '1') => {
        const inp = el('input', { class: 'input num sm', type: 'number', step, value: String(d[key] ?? 0), disabled: locked });
        inp.addEventListener('input', () => { d[key] = key === 'name' ? inp.value : num(inp.value); store.updateTrip(trip.id, { drinkSales: trip.drinkSales }); recalc(); });
        return inp;
      };
      const nameInp = el('input', { class: 'input sm', type: 'text', value: d.name || '', placeholder: 'name', disabled: locked });
      nameInp.addEventListener('input', () => { d.name = nameInp.value; store.updateTrip(trip.id, { drinkSales: trip.drinkSales }); });
      const del = el('button', { class: 'btn ghost xs', text: '✕', disabled: locked, onClick: () => { trip.drinkSales.splice(i, 1); store.updateTrip(trip.id, { drinkSales: trip.drinkSales }); ctx.navigate('sheet', { tripId: trip.id }); } });
      body.appendChild(el('tr', {}, [
        el('td', {}, nameInp), el('td', { class: 'num' }, mk('unitPrice', '0.01')),
        el('td', { class: 'num' }, mk('qtyCash')), el('td', { class: 'num' }, mk('qtyCC')),
        el('td', { class: 'num' }, mk('qtyPaypal')), el('td', { class: 'num' }, del),
      ]));
    });
    tbl.appendChild(body);
    wrap.appendChild(el('div', { class: 'table-wrap' }, tbl));
  }
  if (!locked) {
    wrap.appendChild(el('button', {
      class: 'btn ghost sm mt', text: '+ Add drink',
      onClick: () => { trip.drinkSales.push({ name: '', unitPrice: 0, qtyCash: 0, qtyCC: 0, qtyPaypal: 0 }); store.updateTrip(trip.id, { drinkSales: trip.drinkSales }); ctx.navigate('sheet', { tripId: trip.id }); },
    }));
  }
  return wrap;
}

// Cash reconciliation: NET/remit + denomination count → short/over.
function reconCard(trip, locked, upd, numInput, reg) {
  const wrap = el('div', { class: 'card recon' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Cash reconciliation' }), el('span', { class: 'sub', text: 'count the drawer — must match NET' })]),
  ]);

  // headline NET / remit
  const netOut = reg(el('div', { class: 'recon-net-v' }), (c) => peso(c.net));
  wrap.appendChild(el('div', { class: 'recon-net' }, [
    el('div', { class: 'recon-net-k', text: 'NET · Remit cash' }),
    netOut,
    el('div', { class: 'lockline', text: '🔒 = Revenue − Expenses · cannot be typed' }),
  ]));

  const grid = el('div', { class: 'grid cols-2 gap' });

  // denomination counter
  const denWrap = el('div', {}, [el('h4', { class: 'sub-h', text: 'Cash counted' })]);
  const denTbl = el('table', { class: 'tbl den-tbl' });
  const denBody = el('tbody');
  for (const d of DENOMINATIONS) {
    const subOut = reg(el('span', { class: 'mono' }), () => peso(d * num(trip.cashCount[String(d)])));
    const inp = numInput(() => trip.cashCount[String(d)], (v) => upd({ cashCount: { [String(d)]: v } }), { step: '1', cls: 'input num sm', min: 0 });
    denBody.appendChild(el('tr', {}, [
      el('td', { class: 'mono', text: '₱' + intPlain(d) }),
      el('td', { class: 'num', text: '×' }),
      el('td', { class: 'num' }, inp),
      el('td', { class: 'num' }, subOut),
    ]));
  }
  // gcash row
  const gOut = reg(el('span', { class: 'mono' }), () => peso(num(trip.gcash)));
  denBody.appendChild(el('tr', {}, [
    el('td', { class: 'mono', text: 'Gcash' }), el('td', {}, ''),
    el('td', { class: 'num' }, numInput(() => trip.gcash, (v) => upd({ gcash: v }), { step: '0.01', cls: 'input num', min: 0 })),
    el('td', { class: 'num' }, gOut),
  ]));
  denTbl.appendChild(denBody);
  const countOut = reg(el('span', { class: 'big' }), (c) => peso(c.count.total));
  denTbl.appendChild(el('tfoot', {}, el('tr', {}, [
    el('td', { colspan: '3', class: 'ttl-label', text: 'Counted total' }),
    el('td', { class: 'num' }, countOut),
  ])));
  denWrap.appendChild(el('div', { class: 'table-wrap' }, denTbl));
  grid.appendChild(denWrap);

  // short/over summary
  const expOut = reg(el('span', { class: 'mono' }), (c) => peso(c.net));
  const cntOut = reg(el('span', { class: 'mono' }), (c) => peso(c.count.total));
  const soOut = reg(el('span', { class: 'so-v' }), (c) => `${c.shortOver >= 0 ? '+' : '−'}₱${pesoPlain(Math.abs(c.shortOver))}`);
  const soWrap = el('div', { class: 'recon-so' }, [
    el('h4', { class: 'sub-h', text: 'Short / Over' }),
    line('Expected (NET)', expOut),
    line('Counted', cntOut),
    el('div', { class: 'shortover-badge' }, [
      el('span', { class: 'so-k', text: 'Difference' }),
      soOut,
    ]),
    el('p', { class: 'muted xs', text: '0 = balanced · (−) short · (+) over' }),
  ]);
  grid.appendChild(soWrap);
  wrap.appendChild(grid);
  return wrap;

  function line(k, vNode) {
    return el('div', { class: 'recon-line' }, [el('span', { class: 'k', text: k }), el('span', { class: 'v' }, vNode)]);
  }
}

// Magic Island ticket inventory.
function ticketCard(trip, locked, upd, numInput, reg) {
  const onHandOut = reg(el('span', { class: 'big' }), (c) => intPlain(c.tickets.onHand));
  return el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Magic Island tickets' }), el('span', { class: 'sub', text: 'on hand = inventory − consumed + purchased' })]),
    el('div', { class: 'grid cols-4 gap' }, [
      field('Inventory (start)', numInput(() => trip.tickets.inventory, (v) => upd({ tickets: { inventory: v } }), { step: '1', min: 0 })),
      field('Consumed', numInput(() => trip.tickets.consumed, (v) => upd({ tickets: { consumed: v } }), { step: '1', min: 0 })),
      field('Purchased', numInput(() => trip.tickets.purchased, (v) => upd({ tickets: { purchased: v } }), { step: '1', min: 0 })),
      el('div', { class: 'field' }, [el('label', { text: 'New on hand' }), el('div', { class: 'onhand' }, onHandOut)]),
    ]),
  ]);
}
