// components.js — shared UI primitives: modal, confirm, prompt, page header.
// (No PIN gate — this app has no login/roles.)
import { el } from './util.js';

export function openModal({ title, sub, body, actions = [], wide = false }) {
  const back = el('div', { class: 'modal-back' });
  const modal = el('div', { class: 'modal' + (wide ? ' wide' : '') });
  if (title) modal.appendChild(el('h3', { text: title }));
  if (sub) modal.appendChild(el('p', { class: 'm-sub', text: sub }));
  if (body) modal.appendChild(body);
  const foot = el('div', { class: 'm-foot' });
  const close = () => back.remove();
  for (const a of actions) {
    foot.appendChild(el('button', {
      class: 'btn ' + (a.kind || ''),
      text: a.label,
      onClick: () => { if (a.onClick) a.onClick(close); else close(); },
    }));
  }
  if (actions.length) modal.appendChild(foot);
  back.appendChild(modal);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(ev) {
    if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });
  document.body.appendChild(back);
  const focusable = modal.querySelector('input, select, textarea, button');
  if (focusable) setTimeout(() => focusable.focus(), 50);
  return { close, modal };
}

export function confirmDialog({ title, sub, confirmLabel = 'Confirm', kind = 'primary', onConfirm }) {
  openModal({
    title, sub,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: confirmLabel, kind, onClick: (close) => { close(); onConfirm && onConfirm(); } },
    ],
  });
}

// A single-line text prompt. Calls onSubmit(value) on confirm.
export function promptDialog({ title, sub, label, placeholder = '', value = '', confirmLabel = 'OK', kind = 'primary', onSubmit }) {
  const inp = el('input', { class: 'input', type: 'text', placeholder, value });
  const body = el('div', {}, [
    el('div', { class: 'field' }, [label ? el('label', { text: label }) : null, inp]),
  ]);
  const submit = (close) => { close(); onSubmit && onSubmit(inp.value.trim()); };
  const { close } = openModal({
    title, sub, body,
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      { label: confirmLabel, kind, onClick: submit },
    ],
  });
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(close); });
}

// Section header helper.
export function pageHead(title, subtitle, right) {
  const wrap = el('div', { class: 'topbar' });
  const crumbs = el('div', { class: 'crumbs' }, [
    el('h1', { text: title }),
    subtitle ? el('p', { text: subtitle }) : null,
  ]);
  wrap.appendChild(crumbs);
  if (right) wrap.appendChild(right);
  return wrap;
}
