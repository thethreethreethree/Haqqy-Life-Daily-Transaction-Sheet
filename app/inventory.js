// inventory.js — PURE helpers for the stock inventory (no DOM, no storage),
// adapted from the Hub & Sky Bar inventory tool. The item master plus a free-text
// "on hand" count and a "par" target; snapshots are full copies of the item list
// taken at a point in time, and compareInventories() diffs a snapshot vs current.
//
// Field note: the reference tool called the count "min on hand" (field `min`).
// Here it's `count` (on hand) with `par` as the target. CSV import accepts the old
// MinOnHand/min header so existing exports load unchanged.

import { num } from './util.js';

// Units of measure offered in the add/edit form (free-text also allowed).
export const UOM_OPTIONS = ['EA', 'ML', 'L', 'KG', 'GR', 'BT', 'CAN', 'PCS', 'PACK', 'BOX'];

// Normalize a loose object (from CSV/JSON/import) into a clean item (no id).
export function normalizeItem(obj) {
  obj = obj || {};
  return {
    name: String(obj.name ?? obj.Name ?? '').trim(),
    category: String(obj.category ?? obj.Category ?? 'General').trim() || 'General',
    uom: String(obj.uom ?? obj.UOM ?? 'EA').trim().toUpperCase() || 'EA',
    count: String(obj.count ?? obj.onHand ?? obj.OnHand ?? obj.min ?? obj.MinOnHand ?? '').trim(),
    par: String(obj.par ?? obj.Par ?? '').trim(),
  };
}

// ---------------------------------------------------------------- CSV
export function toCsv(items) {
  const header = ['Name', 'Category', 'UOM', 'OnHand', 'Par'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = (items || []).map((it) => [it.name, it.category, it.uom, it.count, it.par].map(esc).join(','));
  return [header.join(','), ...rows].join('\n');
}

// Proper RFC-4180-ish tokenizer: handles quoted fields with embedded commas,
// newlines, and escaped "" quotes — so item names like `Rum, "house"` survive.
function tokenizeCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; }
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c === '\r') { /* skip */ }
    else cell += c;
  }
  row.push(cell); rows.push(row);
  return rows;
}

export function parseCsv(text) {
  const rows = tokenizeCsv(String(text || ''));
  if (!rows.length) return [];
  const first = rows[0].map((c) => String(c).replace(/['"\s]/g, '').toLowerCase());
  const hasHeader = first.includes('name') && first.includes('category');
  const dataRows = hasHeader ? rows.slice(1) : rows;
  const out = [];
  for (const fields of dataRows) {
    if (!fields.length || !String(fields[0] || '').trim()) continue;
    const item = normalizeItem({
      Name: fields[0], Category: fields[1] || 'General', UOM: fields[2] || 'EA',
      OnHand: fields[3] || '', Par: fields[4] || '',
    });
    if (item.name) out.push(item);
  }
  return out;
}

// ------------------------------------------------- quantity parsing & compare
// Extract a comparable numeric magnitude from a free-text quantity, e.g.
// "2 Bot + 500mL" -> 2.5, "147 Grams" -> 147, "10 L" -> 10, "" -> null.
export function parseQuantity(value) {
  if (value == null || value === '') return null;
  const s = String(value);
  const bot = s.match(/(\d+(?:\.\d+)?)\s*bot/i);
  const ml = s.match(/(\d+(?:\.\d+)?)\s*ml/i);
  if (bot || ml) return (bot ? parseFloat(bot[1]) : 0) + (ml ? parseFloat(ml[1]) / 1000 : 0);
  const n = s.match(/-?\d+(?:\.\d+)?/);
  return n ? parseFloat(n[0]) : null;
}

// Low stock: count is numerically below par (only when both parse to numbers).
export function isLowStock(item) {
  const c = parseQuantity(item && item.count);
  const p = parseQuantity(item && item.par);
  return c != null && p != null && p > 0 && c < p;
}

// Compare two item lists by name using `field` (default 'count'). Returns
// per-item change rows with % plus added/removed/summary.
export function compareInventories(beforeItems, afterItems, field) {
  const key = field || 'count';
  const norm = (n) => String(n || '').trim().toLowerCase();
  const beforeMap = new Map((beforeItems || []).map((i) => [norm(i.name), i]));
  const afterMap = new Map((afterItems || []).map((i) => [norm(i.name), i]));
  const rows = [];
  let increased = 0, decreased = 0, unchanged = 0;

  (afterItems || []).forEach((a) => {
    const b = beforeMap.get(norm(a.name));
    if (!b) return;
    const beforeNum = parseQuantity(b[key]);
    const afterNum = parseQuantity(a[key]);
    let pct = null;
    if (beforeNum != null && afterNum != null && beforeNum !== 0) pct = ((afterNum - beforeNum) / Math.abs(beforeNum)) * 100;
    else if (beforeNum === 0 && afterNum != null && afterNum > 0) pct = Infinity;
    const delta = (afterNum != null && beforeNum != null) ? afterNum - beforeNum : null;
    if (delta != null) { if (delta > 0) increased++; else if (delta < 0) decreased++; else unchanged++; }
    rows.push({ name: a.name, before: b[key] || '', after: a[key] || '', beforeNum, afterNum, delta, pct });
  });

  const added = (afterItems || []).filter((a) => !beforeMap.has(norm(a.name))).map((a) => a.name);
  const removed = (beforeItems || []).filter((b) => !afterMap.has(norm(b.name))).map((b) => b.name);
  return { rows, added, removed, summary: { increased, decreased, unchanged, total: rows.length } };
}

// Clear the count fields for a fresh stock-take, keeping the item master.
export function clearedCounts(items) {
  return (items || []).map((it) => ({ ...it, count: '', par: it.par }));
}
