// views/inventory.js — the stock inventory: an item master with a free-text
// on-hand count + par target, search/filter/sort, CSV import/export, and saved
// snapshots with stock-take comparison. Adapted from the Hub & Sky Bar tool,
// re-skinned to the Haqqy Life theme.
import { el, intPlain, toast, fmtDateTime, escapeHtml } from '../util.js';
import { store } from '../store.js';
import { pageHead, openModal, confirmDialog, promptDialog } from '../components.js';
import { UOM_OPTIONS, parseCsv, toCsv, isLowStock, parseQuantity } from '../inventory.js';

export function render(ctx) {
  const root = el('div');
  const filter = { search: '', category: 'all', sortKey: '', sortDir: 'asc' };

  // ---- header ----
  root.appendChild(pageHead('Inventory', 'Stock list & stock-take',
    el('div', { class: 'flex gap aic' }, [
      el('button', { class: 'btn sm', text: '📸 Snapshots', onClick: () => openSnapshots(ctx) }),
      el('button', { class: 'btn primary', text: '+ Add item', onClick: () => openItemModal(ctx, null) }),
    ])));

  // ---- stat chips ----
  const items = store.inventory;
  const lowOut = el('span', { class: 'v out' });
  const catOut = el('span', { class: 'v' });
  const totOut = el('span', { class: 'v' });
  const refreshStats = () => {
    totOut.textContent = intPlain(store.inventory.length);
    catOut.textContent = intPlain(store.inventoryCategories().length);
    lowOut.textContent = intPlain(store.inventory.filter(isLowStock).length);
  };
  root.appendChild(el('div', { class: 'grid cols-3 gap' }, [
    el('div', { class: 'card stat-card' }, [el('span', { class: 'k', text: 'Items' }), totOut, el('span', { class: 'meta', text: 'in the stock list' })]),
    el('div', { class: 'card stat-card' }, [el('span', { class: 'k', text: 'Categories' }), catOut, el('span', { class: 'meta', text: 'distinct groups' })]),
    el('div', { class: 'card stat-card' }, [el('span', { class: 'k', text: 'Low stock' }), lowOut, el('span', { class: 'meta', text: 'on hand below par' })]),
  ]));

  // ---- toolbar ----
  const searchInp = el('input', { class: 'input', type: 'search', placeholder: 'Search items…' });
  const catSel = el('select', { class: 'input' });
  const rebuildCatFilter = () => {
    const cats = store.inventoryCategories();
    if (!cats.includes(filter.category)) filter.category = 'all';
    catSel.innerHTML = '';
    catSel.appendChild(el('option', { value: 'all', text: 'All categories' }));
    for (const c of cats) catSel.appendChild(el('option', { value: c, text: c, selected: c === filter.category ? 'selected' : null }));
    catSel.value = filter.category;
  };
  searchInp.addEventListener('input', () => { filter.search = searchInp.value; renderRows(); });
  catSel.addEventListener('change', () => { filter.category = catSel.value; renderRows(); });

  const toolbar = el('div', { class: 'card inv-toolbar' }, [
    el('div', { class: 'inv-tools' }, [
      el('div', { class: 'inv-search' }, [searchInp]),
      catSel,
      el('button', { class: 'btn sm', text: '⬆ Import CSV', onClick: () => doImport(ctx) }),
      el('button', { class: 'btn sm', text: '⬇ Export CSV', onClick: () => doExport() }),
    ]),
  ]);
  root.appendChild(toolbar);

  // ---- items table ----
  const countLabel = el('span', { class: 'sub' });
  const tbl = el('table', { class: 'tbl inv-table' });
  const thead = el('thead');
  const headRow = el('tr');
  const cols = [
    { key: 'name', label: 'Item' }, { key: 'category', label: 'Category' }, { key: 'uom', label: 'UOM', cls: 'num' },
    { key: 'count', label: 'On hand', cls: 'num' }, { key: 'par', label: 'Par', cls: 'num' }, { key: '', label: '', cls: 'num' },
  ];
  for (const c of cols) {
    const th = el('th', { class: (c.cls || '') + (c.key ? ' sortable' : ''), text: c.label });
    if (c.key) th.addEventListener('click', () => {
      if (filter.sortKey === c.key) filter.sortDir = filter.sortDir === 'asc' ? 'desc' : 'asc';
      else { filter.sortKey = c.key; filter.sortDir = 'asc'; }
      renderRows();
    });
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  tbl.appendChild(thead);
  const tbody = el('tbody');
  tbl.appendChild(tbody);

  function visibleRows() {
    let rows = store.inventory.slice();
    const s = filter.search.trim().toLowerCase();
    if (s) rows = rows.filter((it) => [it.name, it.category, it.uom, it.count, it.par].some((v) => String(v || '').toLowerCase().includes(s)));
    if (filter.category !== 'all') rows = rows.filter((it) => (it.category || '').trim() === filter.category);
    if (filter.sortKey) {
      const dir = filter.sortDir === 'desc' ? -1 : 1;
      rows.sort((a, b) => String(a[filter.sortKey] || '').localeCompare(String(b[filter.sortKey] || ''), undefined, { numeric: true, sensitivity: 'base' }) * dir);
    }
    return rows;
  }

  function rowEl(it) {
    const tr = el('tr', { dataset: { id: it.id } });
    if (isLowStock(it)) tr.classList.add('low');
    const countInp = el('input', { class: 'input num sm', type: 'text', value: it.count || '', placeholder: '—' });
    const parInp = el('input', { class: 'input num sm', type: 'text', value: it.par || '', placeholder: '—' });
    const onEdit = () => {
      store.updateInventoryItem(it.id, { count: countInp.value, par: parInp.value });
      tr.classList.toggle('low', isLowStock({ count: countInp.value, par: parInp.value }));
      refreshStats();
    };
    countInp.addEventListener('input', onEdit);
    parInp.addEventListener('input', onEdit);
    [countInp, parInp].forEach((i) => i.addEventListener('focus', () => i.select()));
    tr.appendChild(el('td', {}, [el('strong', { text: it.name }), isLowStock(it) ? el('span', { class: 'tag low-tag', text: 'LOW' }) : null]));
    tr.appendChild(el('td', {}, el('span', { class: 'tag cat', text: it.category || '—' })));
    tr.appendChild(el('td', { class: 'num mono', text: it.uom || '' }));
    tr.appendChild(el('td', { class: 'num' }, countInp));
    tr.appendChild(el('td', { class: 'num' }, parInp));
    tr.appendChild(el('td', { class: 'num' }, el('div', { class: 'flex gap aic', style: 'justify-content:flex-end' }, [
      el('button', { class: 'btn ghost xs', text: '✏️', title: 'Edit', onClick: () => openItemModal(ctx, it) }),
      el('button', { class: 'btn ghost xs', text: '🗑', title: 'Delete', onClick: () => confirmDialog({ title: `Remove "${it.name}"?`, sub: 'This removes it from the stock list.', confirmLabel: 'Remove', kind: 'danger', onConfirm: () => { store.removeInventoryItem(it.id); ctx.navigate('inventory'); } }) }),
    ])));
    return tr;
  }

  function renderRows() {
    rebuildCatFilter();
    const rows = visibleRows();
    tbody.innerHTML = '';
    if (!rows.length) {
      tbody.appendChild(el('tr', {}, el('td', { colspan: '6' }, el('div', { class: 'empty' }, [
        el('div', { class: 'ic', text: '📦' }),
        el('p', { text: store.inventory.length ? 'No items match your search/filter.' : 'No inventory items yet. Add one or import a CSV.' }),
      ]))));
    } else {
      for (const it of rows) tbody.appendChild(rowEl(it));
    }
    const total = store.inventory.length, shown = rows.length;
    countLabel.textContent = shown === total ? `${total} item${total === 1 ? '' : 's'}` : `${shown} of ${total} items`;
  }

  const tableCard = el('div', { class: 'card' }, [
    el('div', { class: 'card-h' }, [el('h3', { text: 'Stock list' }), countLabel]),
    el('div', { class: 'table-wrap' }, tbl),
  ]);
  root.appendChild(tableCard);

  refreshStats();
  renderRows();
  return root;
}

// ---- add / edit item modal ----
function openItemModal(ctx, item) {
  const isEdit = !!item;
  const name = el('input', { class: 'input', type: 'text', value: item ? item.name : '', placeholder: 'e.g. Bottled Water 500ml' });
  const cats = store.inventoryCategories();
  const category = el('input', { class: 'input', type: 'text', value: item ? item.category : '', placeholder: 'e.g. Drinks', list: 'inv-cat-list' });
  const catList = el('datalist', { id: 'inv-cat-list' }, cats.map((c) => el('option', { value: c })));
  const uom = el('select', { class: 'input' }, UOM_OPTIONS.map((u) => el('option', { value: u, text: u, selected: item && item.uom === u ? 'selected' : null })));
  const count = el('input', { class: 'input', type: 'text', value: item ? item.count : '', placeholder: 'on hand — e.g. 24 or "2 Bot + 500mL"' });
  const par = el('input', { class: 'input', type: 'text', value: item ? item.par : '', placeholder: 'par / target (optional)' });
  const body = el('div', {}, [
    catList,
    el('div', { class: 'field' }, [el('label', { text: 'Item name' }), name]),
    el('div', { class: 'grid cols-2 gap' }, [
      el('div', { class: 'field' }, [el('label', { text: 'Category' }), category]),
      el('div', { class: 'field' }, [el('label', { text: 'Unit (UOM)' }), uom]),
    ]),
    el('div', { class: 'grid cols-2 gap' }, [
      el('div', { class: 'field' }, [el('label', { text: 'On hand' }), count]),
      el('div', { class: 'field' }, [el('label', { text: 'Par' }), par]),
    ]),
  ]);
  openModal({
    title: isEdit ? 'Edit item' : 'Add item', body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: isEdit ? 'Save' : 'Add', kind: 'primary', onClick: (close) => {
        const data = { name: name.value.trim(), category: category.value.trim() || 'General', uom: uom.value, count: count.value.trim(), par: par.value.trim() };
        if (!data.name) { toast('Enter an item name', 'err'); return; }
        if (isEdit) store.updateInventoryItem(item.id, data); else store.addInventoryItem(data);
        close(); ctx.navigate('inventory');
      } },
    ],
  });
}

// ---- CSV import / export ----
function doExport() {
  const csv = toCsv(store.inventory);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `inventory-${new Date().toISOString().slice(0, 10)}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  toast('Inventory exported');
}
function doImport(ctx) {
  const inp = el('input', { type: 'file', accept: '.csv,text/csv', style: 'display:none' });
  inp.addEventListener('change', async () => {
    const f = inp.files[0]; if (!f) return;
    const text = await f.text();
    const rows = parseCsv(text);
    if (!rows.length) { toast('No rows found in that CSV', 'err'); return; }
    const finish = (replace) => { store.importInventory(rows, { replace }); toast(`Imported ${rows.length} item${rows.length === 1 ? '' : 's'}`); ctx.navigate('inventory'); };
    if (store.inventory.length) {
      openModal({
        title: `Import ${rows.length} items`, sub: 'Add these to your current list, or replace it entirely?',
        actions: [
          { label: 'Cancel', kind: 'ghost' },
          { label: 'Replace list', kind: 'danger', onClick: (c) => { c(); finish(true); } },
          { label: 'Append', kind: 'primary', onClick: (c) => { c(); finish(false); } },
        ],
      });
    } else finish(false);
  });
  document.body.appendChild(inp); inp.click(); inp.remove();
}

// ---- snapshots & analysis modal ----
function openSnapshots(ctx) {
  const body = el('div', { class: 'snap-wrap' });
  const { modal } = openModal({
    title: '📸 Snapshots & stock-take analysis',
    sub: 'Save the current counts, start a fresh count, or compare a saved snapshot against now.',
    body, wide: true,
    actions: [{ label: 'Close', kind: 'ghost' }],
  });

  function rebuild() {
    body.innerHTML = '';
    // actions
    body.appendChild(el('div', { class: 'flex gap wrap', style: 'margin-bottom:14px' }, [
      el('button', { class: 'btn primary sm', text: '💾 Save snapshot', onClick: () => {
        if (!store.inventory.length) { toast('Nothing to snapshot yet', 'err'); return; }
        promptDialog({ title: 'Save snapshot', label: 'Snapshot name', value: 'Stock-take ' + new Date().toLocaleDateString('en-PH'), confirmLabel: 'Save', onSubmit: (n) => { store.saveInventorySnapshot(n); toast('Snapshot saved'); rebuild(); } });
      } }),
      el('button', { class: 'btn sm', text: '🔄 Start new count', onClick: () => {
        if (!store.inventory.length) { toast('Nothing to clear yet', 'err'); return; }
        confirmDialog({ title: 'Start a new count?', sub: `Saves the current counts as a snapshot, then clears the on-hand count for all ${store.inventory.length} items (names, categories, UOM and par are kept).`, confirmLabel: 'Snapshot & clear', onConfirm: () => { store.startNewCount(); toast('Snapshot saved & counts cleared'); rebuild(); ctx.navigate('inventory'); } });
      } }),
    ]));

    const snaps = store.inventorySnapshots.slice().reverse();
    // compare
    if (snaps.length) {
      const sel = el('select', { class: 'input sm' }, snaps.map((s) => el('option', { value: s.id, text: `${s.name} · ${fmtDateTime(s.date)}` })));
      const result = el('div', { class: 'cmp-result' });
      body.appendChild(el('div', { class: 'inv-compare' }, [
        el('h4', { class: 'sub-h', text: 'Compare snapshot → current' }),
        el('div', { class: 'flex gap aic wrap' }, [sel, el('button', { class: 'btn sm', text: 'Compare', onClick: () => { result.innerHTML = ''; result.appendChild(compareTable(store.compareToSnapshot(sel.value), store.snapshotById(sel.value))); } })]),
        result,
      ]));
    }

    // snapshot list
    const list = el('div', { class: 'snap-list' });
    if (!snaps.length) list.appendChild(el('p', { class: 'cmp-empty muted', text: 'No snapshots saved yet. Use “Save snapshot” or “Start new count”.' }));
    for (const s of snaps) {
      list.appendChild(el('div', { class: 'snap-row' }, [
        el('div', {}, [el('strong', { text: s.name }), el('div', { class: 'muted xs', text: `${fmtDateTime(s.date)} · ${s.items.length} items` })]),
        el('div', { class: 'flex gap aic' }, [
          el('button', { class: 'btn ghost xs', text: 'Restore', onClick: () => confirmDialog({ title: `Restore "${s.name}"?`, sub: 'This replaces the current stock list with the snapshot.', confirmLabel: 'Restore', onConfirm: () => { store.restoreInventorySnapshot(s.id); toast('Snapshot restored'); rebuild(); ctx.navigate('inventory'); } }) }),
          el('button', { class: 'btn ghost xs', text: '🗑', title: 'Delete', onClick: () => { store.deleteInventorySnapshot(s.id); rebuild(); } }),
        ]),
      ]));
    }
    body.appendChild(el('h4', { class: 'sub-h', style: 'margin-top:14px', text: 'Saved snapshots' }));
    body.appendChild(list);
  }
  rebuild();
}

function compareTable(result, snap) {
  if (!result) return el('p', { class: 'muted', text: 'Snapshot not found.' });
  const { rows, added, removed, summary } = result;
  const changed = rows.filter((r) => r.delta != null && r.delta !== 0);
  const wrap = el('div', {});
  wrap.appendChild(el('p', { class: 'cmp-caption muted xs', html: `Comparing <b>${escapeHtml(snap ? snap.name : '')}</b> (before) vs current counts (after).` }));
  wrap.appendChild(el('div', { class: 'cmp-summary' }, [
    el('span', { class: 'cmp-up', text: `${summary.increased} up` }),
    el('span', { class: 'cmp-down', text: `${summary.decreased} down` }),
    el('span', { class: 'cmp-flat', text: `${summary.unchanged} same` }),
    added.length ? el('span', { class: 'cmp-add', text: `${added.length} added` }) : null,
    removed.length ? el('span', { class: 'cmp-rem', text: `${removed.length} removed` }) : null,
  ]));
  const tbl = el('table', { class: 'tbl' });
  tbl.appendChild(el('thead', {}, el('tr', {}, [el('th', { text: 'Item' }), el('th', { class: 'num', text: 'Before' }), el('th', { class: 'num', text: 'After' }), el('th', { class: 'num', text: 'Change' })])));
  const tb = el('tbody');
  if (!changed.length) tb.appendChild(el('tr', {}, el('td', { colspan: '4', class: 'muted', text: 'No measurable changes between these counts.' })));
  for (const r of changed) {
    tb.appendChild(el('tr', {}, [
      el('td', { text: r.name }), el('td', { class: 'num mono', text: r.before || '—' }), el('td', { class: 'num mono', text: r.after || '—' }),
      el('td', { class: 'num' }, pctBadge(r.pct)),
    ]));
  }
  tbl.appendChild(tb);
  wrap.appendChild(el('div', { class: 'table-wrap' }, tbl));
  return wrap;
}
function pctBadge(pct) {
  if (pct == null) return el('span', { class: 'cmp-flat', text: 'n/a' });
  if (!isFinite(pct)) return el('span', { class: 'cmp-up', text: 'NEW' });
  const cls = pct > 0 ? 'cmp-up' : (pct < 0 ? 'cmp-down' : 'cmp-flat');
  return el('span', { class: cls, text: `${pct > 0 ? '+' : ''}${pct.toFixed(1)}%` });
}
