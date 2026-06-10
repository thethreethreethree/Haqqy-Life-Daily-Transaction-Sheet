// views/trips.js — the home view: a roll-up of the trip history plus the list
// of saved trip sheets. Click a trip to open its sheet; create new ones here.
import { el, peso, pesoPlain, intPlain, fmtPlainDate, fmtDateTime, toast } from '../util.js';
import { store } from '../store.js';
import { pageHead, openModal, confirmDialog } from '../components.js';
import { computeTrip } from '../compute.js';

export function render(ctx) {
  const root = el('div');
  const trips = store.tripsSorted();

  root.appendChild(pageHead(
    store.config.brand || 'Daily Trip Tracker',
    `Trip sheets · ${new Date().toLocaleDateString('en-PH', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`,
    el('button', { class: 'btn primary', text: '+ New trip sheet', onClick: () => newTripDialog(ctx) }),
  ));

  // ---- roll-up cards (this month) ----
  const month = new Date().toISOString().slice(0, 7);
  const mTrips = trips.filter((t) => (t.date || '').startsWith(month));
  let mNet = 0, mRev = 0, mGuests = 0;
  for (const t of mTrips) { const c = computeTrip(t); mNet += c.net; mRev += c.revenueTotal; mGuests += c.guests; }
  const open = trips.filter((t) => t.status === 'open').length;

  const cards = el('div', { class: 'grid cols-4 gap' }, [
    statCard('Trips this month', String(mTrips.length), `${open} open · ${trips.length} total`),
    statCard('Revenue this month', peso(mRev), 'cash side'),
    statCard('NET this month', peso(mNet), 'remit cash', mNet >= 0 ? 'in' : 'out'),
    statCard('Guests this month', intPlain(mGuests), 'across all trips'),
  ]);
  root.appendChild(cards);

  // ---- trip list ----
  const listCard = el('div', { class: 'card mt-lg' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Trip sheets' }), el('span', { class: 'sub', text: 'newest first' })]),
  ]);
  if (!trips.length) {
    listCard.appendChild(emptyState('🛥️', 'No trip sheets yet. Create your first one.'));
  } else {
    const tbl = el('table', { class: 'tbl trips-tbl' });
    tbl.appendChild(el('thead', {}, el('tr', {}, [
      el('th', { text: 'Date' }), el('th', { text: 'Route' }), el('th', { text: 'Status' }),
      el('th', { class: 'num', text: 'Revenue' }), el('th', { class: 'num', text: 'Expenses' }),
      el('th', { class: 'num', text: 'NET' }), el('th', { class: 'num', text: 'Short/Over' }), el('th', {}),
    ])));
    const body = el('tbody');
    for (const t of trips) {
      const c = computeTrip(t);
      const open = () => ctx.navigate('sheet', { tripId: t.id });
      body.appendChild(el('tr', { class: 'row-click', onClick: open }, [
        el('td', {}, [el('strong', { text: fmtPlainDate(t.date) })]),
        el('td', {}, el('span', { class: 'tag route', text: t.routeName })),
        el('td', {}, el('span', { class: `tag ${t.status === 'finalized' ? 'locked' : 'open'}`, text: t.status === 'finalized' ? '🔒 Finalised' : '● Open' })),
        el('td', { class: 'num', text: peso(c.revenueTotal) }),
        el('td', { class: 'num amt-out', text: peso(c.expenseTotal) }),
        el('td', { class: 'num strong', text: peso(c.net) }),
        el('td', { class: 'num ' + (c.balanced ? 'muted' : (c.shortOver < 0 ? 'amt-out' : 'amt-in')), text: c.balanced ? '✓' : `${c.shortOver >= 0 ? '+' : '−'}${pesoPlain(Math.abs(c.shortOver))}` }),
        el('td', { class: 'num' }, el('button', {
          class: 'btn ghost xs', text: '⋯',
          onClick: (e) => { e.stopPropagation(); rowMenu(ctx, t); },
        })),
      ]));
    }
    tbl.appendChild(body);
    listCard.appendChild(el('div', { class: 'table-wrap' }, tbl));
  }
  root.appendChild(listCard);
  return root;
}

function statCard(k, v, meta, cls = '') {
  return el('div', { class: 'card stat-card' }, [
    el('span', { class: 'k', text: k }),
    el('span', { class: 'v ' + cls, text: v }),
    el('span', { class: 'meta', text: meta }),
  ]);
}
function emptyState(icon, msg) {
  return el('div', { class: 'empty' }, [el('div', { class: 'ic', text: icon }), el('p', { text: msg })]);
}

function newTripDialog(ctx) {
  const routes = store.activeRoutes();
  if (!routes.length) { toast('Add a route first (Settings).', 'err'); ctx.navigate('settings'); return; }
  const sel = el('select', { class: 'input' });
  for (const r of routes) sel.appendChild(el('option', { value: r.id, text: `${r.name} (₱${pesoPlain(r.base1)} / ₱${pesoPlain(r.base2)})` }));
  const dateInp = el('input', { class: 'input', type: 'date', value: new Date().toISOString().slice(0, 10) });
  const body = el('div', {}, [
    el('div', { class: 'field' }, [el('label', { text: 'Route' }), sel]),
    el('div', { class: 'field' }, [el('label', { text: 'Trip date' }), dateInp]),
  ]);
  openModal({
    title: 'New trip sheet', body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: 'Create', kind: 'primary', onClick: (close) => { close(); const t = store.createTrip({ routeId: sel.value, date: dateInp.value }); ctx.navigate('sheet', { tripId: t.id }); } },
    ],
  });
}

function rowMenu(ctx, t) {
  const c = computeTrip(t);
  openModal({
    title: `${t.routeName} · ${fmtPlainDate(t.date)}`,
    sub: t.status === 'finalized' ? `Finalised ${fmtDateTime(t.finalizedAt)} · NET ₱${pesoPlain(c.net)}` : `Open · NET ₱${pesoPlain(c.net)}`,
    body: el('div', { class: 'menu-actions' }, [
      el('button', { class: 'btn', text: 'Open sheet', onClick: () => { document.querySelector('.modal-back')?.remove(); ctx.navigate('sheet', { tripId: t.id }); } }),
      el('button', { class: 'btn danger', text: 'Delete trip', onClick: () => {
        document.querySelector('.modal-back')?.remove();
        confirmDialog({ title: 'Delete this trip sheet?', sub: 'This cannot be undone (the deletion is recorded in the activity log).', confirmLabel: 'Delete', kind: 'danger', onConfirm: () => { store.deleteTrip(t.id); toast('Trip deleted'); ctx.navigate('trips'); } });
      } }),
    ]),
    actions: [{ label: 'Close', kind: 'ghost' }],
  });
}
