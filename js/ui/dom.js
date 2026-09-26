// Ayudantes mínimos para crear y manipular DOM.

import { icon } from './icons.js';

/**
 * h('div.clase#id', { attrs, on: { click }, style: {} }, ...hijos)
 * Los hijos pueden ser nodos, cadenas (texto) o arrays.
 */
export function h(spec, props, ...children) {
  const m = /^([a-z0-9-]+)?((?:[.#][\w-]+)*)$/i.exec(spec) || [];
  const el = document.createElement(m[1] || 'div');
  const rest = m[2] || '';
  rest.replace(/([.#])([\w-]+)/g, (_, kind, name) => {
    if (kind === '.') el.classList.add(name);
    else el.id = name;
    return '';
  });
  if (props && (typeof props !== 'object' || props instanceof Node || Array.isArray(props))) {
    children.unshift(props);
    props = null;
  }
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'on') {
        for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
      } else if (k === 'style' && typeof v === 'object') {
        Object.assign(el.style, v);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k === 'html') {
        el.innerHTML = v;
      } else if (k === 'text') {
        el.textContent = v;
      } else if (k === 'class') {
        el.className += (el.className ? ' ' : '') + v;
      } else if (k in el && typeof v !== 'string') {
        el[k] = v;
      } else if (v === true) {
        el.setAttribute(k, '');
      } else {
        el.setAttribute(k, String(v));
      }
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function iconEl(name, cls = '') {
  const span = document.createElement('span');
  span.className = `icon ${cls}`.trim();
  span.innerHTML = icon(name);
  return span;
}

export function btn(label, { icon: iconName, variant = '', title, onClick, disabled, cls = '' } = {}) {
  const b = h(`button.btn${variant ? '.' + variant.split(' ').join('.') : ''}`, { type: 'button', title: title || undefined, disabled: !!disabled });
  if (cls) b.className += ' ' + cls;
  if (iconName) b.appendChild(iconEl(iconName));
  if (label) b.appendChild(document.createTextNode(label));
  if (onClick) b.addEventListener('click', onClick);
  return b;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/** Pulsación larga táctil / clic derecho → callback. Devuelve función para desactivar. */
export function onLongPress(el, callback, { delay = 480, moveTolerance = 10 } = {}) {
  let timer = null;
  let sx = 0;
  let sy = 0;
  let fired = false;
  const cancel = () => {
    clearTimeout(timer);
    timer = null;
  };
  const down = e => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    fired = false;
    sx = e.clientX;
    sy = e.clientY;
    cancel();
    timer = setTimeout(() => {
      fired = true;
      timer = null;
      if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
      callback(e);
    }, delay);
  };
  const move = e => {
    if (timer && Math.hypot(e.clientX - sx, e.clientY - sy) > moveTolerance) cancel();
  };
  const click = e => {
    if (fired) {
      e.preventDefault();
      e.stopImmediatePropagation();
      fired = false;
    }
  };
  const ctx = e => {
    e.preventDefault();
    cancel();
    fired = true;
    callback(e);
    setTimeout(() => { fired = false; }, 50);
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', cancel);
  el.addEventListener('pointercancel', cancel);
  el.addEventListener('pointerleave', cancel);
  el.addEventListener('click', click, true);
  el.addEventListener('contextmenu', ctx);
  return () => {
    cancel();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', cancel);
    el.removeEventListener('pointercancel', cancel);
    el.removeEventListener('pointerleave', cancel);
    el.removeEventListener('click', click, true);
    el.removeEventListener('contextmenu', ctx);
  };
}
