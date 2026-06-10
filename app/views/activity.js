// views/activity.js — the append-only, hash-chained activity log. Shows who did
// what and when, and whether the chain still verifies (tamper-evident).
import { el, fmtDateTime, escapeHtml } from '../util.js';
import { store } from '../store.js';
import { pageHead } from '../components.js';

const ICONS = {
  'setup.complete': '🚀', 'trip.create': '➕', 'trip.finalize': '🔒', 'trip.reopen': '🔓',
  'trip.delete': '🗑️', 'route.create': '🧭', 'route.update': '✏️', 'route.remove': '➖',
  'settings.update': '⚙️', 'backup.github': '☁️', 'data.import': '📥', 'data.reset': '♻️',
};

export function render() {
  const root = el('div');
  const integ = store.verifyAuditIntegrity();
  root.appendChild(pageHead('Activity log', 'Every meaningful action — hash-chained & tamper-evident',
    el('span', { class: `integrity ${integ.ok ? 'ok' : 'bad'}` }, [
      el('span', { class: 'dot' }),
      integ.ok ? 'Log verified' : `Chain broken @ #${integ.brokenAtSeq}`,
    ])));

  const events = store.audit.slice().reverse();
  const card = el('div', { class: 'card' });
  if (!events.length) {
    card.appendChild(el('div', { class: 'empty' }, [el('div', { class: 'ic', text: '🪵' }), el('p', { text: 'No activity recorded yet.' })]));
  } else {
    const list = el('div', { class: 'act-list' });
    for (const ev of events) {
      list.appendChild(el('div', { class: 'act-row' }, [
        el('div', { class: 'act-ic', text: ICONS[ev.action] || '•' }),
        el('div', { class: 'act-main' }, [
          el('div', { class: 'act-what', text: ev.what || ev.action }),
          el('div', { class: 'act-meta', html: `#${ev.seq} · <b>${escapeHtml(ev.actor || 'staff')}</b> · ${fmtDateTime(ev.ts)} · <code>${escapeHtml(ev.action)}</code>` }),
        ]),
      ]));
    }
    card.appendChild(list);
  }
  root.appendChild(card);
  return root;
}
