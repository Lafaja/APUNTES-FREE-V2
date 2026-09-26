import { icon } from './icons.js';

const ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'info' };

/** Aviso breve. Devuelve una función para cerrarlo. */
export function toast(message, { type = 'info', duration = 3200, action = null } = {}) {
  const root = document.getElementById('toast-root');
  if (!root) return () => {};
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', type === 'error' ? 'alert' : 'status');
  el.innerHTML = icon(ICONS[type] || 'info');
  const span = document.createElement('span');
  span.textContent = message;
  el.appendChild(span);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 180);
  };
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action.label;
    b.addEventListener('click', () => {
      close();
      action.fn();
    });
    el.appendChild(b);
  }
  root.appendChild(el);
  while (root.children.length > 3) root.firstElementChild.remove();
  if (duration > 0) setTimeout(close, duration);
  close.update = text => {
    span.textContent = text;
  };
  return close;
}
