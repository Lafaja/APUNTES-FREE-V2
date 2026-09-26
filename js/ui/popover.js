// Popovers y menús contextuales anclados a un elemento o a un punto.

import { h, iconEl } from './dom.js';

let current = null;

export function closePopover() {
  if (current) {
    const c = current;
    current = null;
    c.layer.remove();
    c.pop.remove();
    if (c.onClose) c.onClose();
  }
}

export function isPopoverOpen() {
  return !!current;
}

/**
 * Abre `content` junto a `anchor` (Element o {x, y}). Cierra el anterior.
 * Devuelve la función de cierre.
 */
export function openPopover(anchor, content, { onClose, placement = 'below', className = '' } = {}) {
  closePopover();
  const root = document.getElementById('popover-root');
  const layer = h('div.popover-layer');
  const pop = h(`div.popover${className ? '.' + className : ''}`, { role: 'dialog' });
  pop.appendChild(content);
  layer.addEventListener('pointerdown', e => {
    e.preventDefault();
    closePopover();
  });
  root.append(layer, pop);
  current = { layer, pop, onClose };
  position(pop, anchor, placement);
  return closePopover;
}

function position(pop, anchor, placement) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pr = pop.getBoundingClientRect();
  let ax, ay, aw = 0, ah = 0;
  if (anchor instanceof Element) {
    const r = anchor.getBoundingClientRect();
    ax = r.left;
    ay = r.top;
    aw = r.width;
    ah = r.height;
  } else {
    ax = anchor.x;
    ay = anchor.y;
  }
  let left = ax + aw / 2 - pr.width / 2;
  let top = placement === 'above' ? ay - pr.height - 8 : ay + ah + 8;
  if (placement !== 'above' && top + pr.height > vh - 8) {
    const above = ay - pr.height - 8;
    top = above >= 8 ? above : Math.max(8, vh - pr.height - 8);
  }
  if (placement === 'above' && top < 8) top = ay + ah + 8;
  left = Math.max(8, Math.min(vw - pr.width - 8, left));
  top = Math.max(8, Math.min(vh - pr.height - 8, top));
  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(top)}px`;
}

/**
 * Menú de acciones. items: [{ label, icon, onClick, danger, hint, disabled } | 'sep' | { title }]
 */
export function openMenu(anchor, items, opts = {}) {
  const list = h('div.menu', { role: 'menu' });
  for (const it of items) {
    if (!it) continue;
    if (it === 'sep') {
      list.appendChild(h('div.menu-sep'));
      continue;
    }
    if (it.title) {
      list.appendChild(h('div.menu-title', it.title));
      continue;
    }
    const b = h(`button.menu-item${it.danger ? '.danger' : ''}`, { type: 'button', role: 'menuitem', disabled: !!it.disabled });
    if (it.icon) b.appendChild(iconEl(it.icon));
    b.appendChild(h('span', it.label));
    if (it.hint) b.appendChild(h('span.menu-hint', it.hint));
    if (it.disabled) b.style.opacity = '0.4';
    b.addEventListener('click', () => {
      closePopover();
      if (it.onClick) it.onClick();
    });
    list.appendChild(b);
  }
  return openPopover(anchor, list, opts);
}
