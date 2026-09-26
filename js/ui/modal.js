// Diálogos modales basados en promesas.

import { h, iconEl } from './dom.js';

const stack = [];

function onKey(e) {
  const top = stack[stack.length - 1];
  if (!top) return;
  if (e.key === 'Escape' && top.dismissible) {
    e.preventDefault();
    top.close(top.cancelValue);
  } else if (e.key === 'Enter' && top.enterValue !== undefined && !e.shiftKey) {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'TEXTAREA' || tag === 'BUTTON') return;
    e.preventDefault();
    top.close(typeof top.enterValue === 'function' ? top.enterValue() : top.enterValue);
  }
}

/**
 * openModal({ title, body, buttons: [{ label, value, variant, icon }], wide, dismissible, cancelValue, onOpen })
 * Devuelve { promise, close, el }.
 */
export function openModal({ title, body, buttons = [], wide = false, xwide = false, dismissible = true, cancelValue = null, enterValue, onOpen, headerExtra } = {}) {
  const root = document.getElementById('modal-root');
  let resolveFn;
  const promise = new Promise(r => { resolveFn = r; });
  const backdrop = h('div.modal-backdrop');
  const dialog = h(`div.modal${wide ? '.wide' : ''}${xwide ? '.xwide' : ''}`, { role: 'dialog', 'aria-modal': 'true' });
  const header = h('div.modal-header', h('h2', title || ''));
  if (headerExtra) header.appendChild(headerExtra);
  if (dismissible) {
    const x = h('button.btn.btn-icon', { type: 'button', 'aria-label': 'Cerrar', on: { click: () => close(cancelValue) } }, iconEl('x'));
    header.appendChild(x);
  }
  const bodyEl = h('div.modal-body');
  if (typeof body === 'string') bodyEl.appendChild(h('p', body));
  else if (body) bodyEl.appendChild(body);
  dialog.append(header, bodyEl);
  let footer = null;
  if (buttons.length) {
    footer = h('div.modal-footer');
    for (const b of buttons) {
      if (b === 'spacer') {
        footer.appendChild(h('span.spacer'));
        continue;
      }
      const el = h(`button.btn${b.variant ? '.' + b.variant : ''}`, { type: 'button', disabled: !!b.disabled });
      if (b.icon) el.appendChild(iconEl(b.icon));
      el.appendChild(document.createTextNode(b.label));
      el.addEventListener('click', async () => {
        if (b.onClick) {
          const r = await b.onClick(el);
          if (r === false) return;
        }
        close(typeof b.value === 'function' ? b.value() : b.value);
      });
      if (b.id) el.dataset.id = b.id;
      footer.appendChild(el);
    }
    dialog.appendChild(footer);
  }
  backdrop.appendChild(dialog);
  backdrop.addEventListener('pointerdown', e => {
    if (e.target === backdrop && dismissible) backdrop._downOnBackdrop = true;
  });
  backdrop.addEventListener('click', e => {
    if (e.target === backdrop && dismissible && backdrop._downOnBackdrop) close(cancelValue);
    backdrop._downOnBackdrop = false;
  });
  root.appendChild(backdrop);
  const entry = { dismissible, cancelValue, enterValue, close: null };
  let closed = false;
  function close(value) {
    if (closed) return;
    closed = true;
    const i = stack.indexOf(entry);
    if (i !== -1) stack.splice(i, 1);
    if (!stack.length) document.removeEventListener('keydown', onKey);
    backdrop.remove();
    resolveFn(value);
  }
  entry.close = close;
  if (!stack.length) document.addEventListener('keydown', onKey);
  stack.push(entry);
  if (onOpen) onOpen({ dialog, body: bodyEl, footer, close });
  const autofocus = dialog.querySelector('[autofocus]');
  if (autofocus) setTimeout(() => autofocus.focus(), 30);
  return { promise, close, el: dialog, body: bodyEl, footer };
}

export function isModalOpen() {
  return stack.length > 0;
}

export function alertDialog(message, title = 'Aviso') {
  return openModal({ title, body: message, buttons: [{ label: 'Entendido', value: true, variant: 'btn-primary' }], enterValue: true }).promise;
}

export function confirmDialog(message, { title = '¿Seguro?', confirmLabel = 'Aceptar', cancelLabel = 'Cancelar', danger = false } = {}) {
  return openModal({
    title,
    body: message,
    cancelValue: false,
    enterValue: true,
    buttons: [
      { label: cancelLabel, value: false, variant: 'btn-ghost' },
      { label: confirmLabel, value: true, variant: danger ? 'btn-danger' : 'btn-primary' }
    ]
  }).promise;
}

export function promptDialog({ title, label, value = '', placeholder = '', confirmLabel = 'Guardar', hint = '' }) {
  const input = h('input.text-input', { type: 'text', value, placeholder, autofocus: true, autocomplete: 'off', enterkeyhint: 'done' });
  const body = h('div', h('label.field', h('span', label || ''), input), hint ? h('div.hint', hint) : null);
  const m = openModal({
    title,
    body,
    cancelValue: null,
    enterValue: () => input.value,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: confirmLabel, value: () => input.value, variant: 'btn-primary' }
    ]
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 40);
  return m.promise;
}
