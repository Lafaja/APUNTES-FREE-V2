// Menú circular: mantener pulsado sin moverse (lápiz o dedo) abre un círculo con las plumas y
// herramientas de la barra (anillo interior) y los colores (anillo exterior).
// Se elige arrastrando hasta la opción y soltando, o soltando primero y tocando la opción.

import { settings, INK_COLORS } from '../core/settings.js';
import { h } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { BRUSHES } from '../render/ink.js';

const BRUSH_ICONS = { pen: 'pen', fountain: 'fountain', brush: 'brush', pencil: 'pencil', highlighter: 'highlighter' };
const TOOLS = [
  { id: 'eraser', icon: 'eraser', name: 'Borrador' },
  { id: 'lasso', icon: 'lasso', name: 'Lazo' },
  { id: 'shape', icon: 'shapes', name: 'Formas' }
];

export class RadialMenu {
  constructor(editor) {
    this.editor = editor;
    this.watchState = null;
    this.el = null;
  }

  isOpen() {
    return !!this.el;
  }

  /** ¿Vigilar esta pulsación según los ajustes (activado y tipo de entrada)? */
  accepts(e) {
    if (!settings.get('radialMenu') || this.el) return false;
    const input = settings.get('radialMenuInput');
    const finger = e.pointerType === 'touch';
    if (e.pointerType === 'mouse') return false;
    if (input === 'pen' && finger) return false;
    if (input === 'finger' && !finger) return false;
    return true;
  }

  /**
   * Empieza a vigilar una pulsación. Si se mantiene quieta el tiempo configurado, llama a
   * onFire() (que debe cancelar el trazo o desplazamiento en curso) y abre el menú.
   */
  watch(e, onFire) {
    if (!this.accepts(e)) return;
    this.cancelWatch();
    const w = { id: e.pointerId, x: e.clientX, y: e.clientY };
    const slop = e.pointerType === 'touch' ? 10 : 6;
    const onMove = ev => {
      if (ev.pointerId === w.id && Math.hypot(ev.clientX - w.x, ev.clientY - w.y) > slop) this.cancelWatch();
    };
    const onEnd = ev => {
      if (ev.pointerId === w.id) this.cancelWatch();
    };
    // Un segundo dedo (zoom) o cualquier otra pulsación cancela la espera.
    const onOtherDown = ev => {
      if (ev.pointerId !== w.id) this.cancelWatch();
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerup', onEnd, true);
    window.addEventListener('pointercancel', onEnd, true);
    window.addEventListener('pointerdown', onOtherDown, true);
    w.cleanup = () => {
      window.removeEventListener('pointermove', onMove, true);
      window.removeEventListener('pointerup', onEnd, true);
      window.removeEventListener('pointercancel', onEnd, true);
      window.removeEventListener('pointerdown', onOtherDown, true);
    };
    w.timer = setTimeout(() => {
      this.cancelWatch();
      if (onFire) onFire();
      this.open(w.x, w.y, w.id);
    }, Number(settings.get('radialMenuDelay')) || 500);
    this.watchState = w;
  }

  cancelWatch() {
    const w = this.watchState;
    if (!w) return;
    this.watchState = null;
    clearTimeout(w.timer);
    w.cleanup();
  }

  // ------------------------------------------------------------------

  items() {
    const ed = this.editor;
    const activeId = settings.get('activePresetId');
    const tools = settings.get('presets').slice(0, 9).map(p => ({
      kind: 'preset',
      id: p.id,
      icon: BRUSH_ICONS[p.t] || 'pen',
      color: p.c,
      name: BRUSHES[p.t]?.name || 'Pluma',
      active: ed.tool === 'pen' && p.id === activeId
    }));
    for (const t of TOOLS) tools.push({ kind: 'tool', id: t.id, icon: t.icon, name: t.name, active: ed.tool === t.id });
    const fav = settings.get('favColors');
    const colors = [];
    for (const c of [...fav, ...INK_COLORS]) {
      const lc = c.toLowerCase();
      if (lc !== '#ffffff' && !colors.includes(lc)) colors.push(lc);
    }
    return { tools, colors: colors.slice(0, 16) };
  }

  open(x, y, pointerId) {
    this.close();
    const { tools, colors } = this.items();
    const cur = (this.editor.activePreset()?.c || '').toLowerCase();
    const innerR = 74;
    const outerR = 128;
    const wheelR = 150;
    const margin = 8;
    const cx = Math.min(window.innerWidth - wheelR - margin, Math.max(wheelR + margin, x));
    const cy = Math.min(window.innerHeight - wheelR - margin, Math.max(wheelR + margin, y));

    const overlay = h('div.radial-overlay', { role: 'dialog', 'aria-label': 'Menú rápido de herramientas y colores' });
    const wheel = h('div.radial-wheel', {
      style: { left: `${cx}px`, top: `${cy}px`, width: `${wheelR * 2}px`, height: `${wheelR * 2}px`, marginLeft: `${-wheelR}px`, marginTop: `${-wheelR}px` }
    });
    overlay.appendChild(wheel);
    const place = (el, angle, r) => {
      el.style.left = `${wheelR + r * Math.cos(angle)}px`;
      el.style.top = `${wheelR + r * Math.sin(angle)}px`;
    };

    tools.forEach((t, i) => {
      const b = h('button.radial-item.radial-tool', { type: 'button', title: t.name, 'aria-label': t.name });
      b.innerHTML = icon(t.icon);
      if (t.color) b.appendChild(h('span.radial-badge', { style: { backgroundColor: t.color } }));
      if (t.active) b.classList.add('active');
      b._choose = () => (t.kind === 'preset' ? this.editor.selectPreset(t.id) : this.editor.setTool(t.id));
      place(b, -Math.PI / 2 + (i / tools.length) * Math.PI * 2, innerR);
      wheel.appendChild(b);
    });
    colors.forEach((c, i) => {
      const b = h('button.radial-item.radial-color', { type: 'button', 'aria-label': `Color ${c}` });
      b.appendChild(h('span.radial-dot', { style: { backgroundColor: c } }));
      if (c === cur) b.classList.add('active');
      b._choose = () => this.chooseColor(c);
      place(b, -Math.PI / 2 + (i / colors.length) * Math.PI * 2, outerR);
      wheel.appendChild(b);
    });
    const center = h('button.radial-item.radial-center', { type: 'button', 'aria-label': 'Cerrar', style: { left: `${wheelR}px`, top: `${wheelR}px` } }, '✕');
    wheel.appendChild(center);

    document.body.appendChild(overlay);
    this.el = overlay;
    if (navigator.vibrate) try { navigator.vibrate(12); } catch {}

    const itemAt = ev => {
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      return el ? el.closest('.radial-item') : null;
    };
    const choose = item => {
      if (item && item._choose) item._choose();
      this.close();
    };

    // Arrastrar desde la pulsación que abrió el menú: resaltar y elegir al soltar.
    let moved = false;
    let dragging = true;
    let hovered = null;
    const setHovered = item => {
      if (hovered === item) return;
      if (hovered) hovered.classList.remove('hover');
      hovered = item;
      if (hovered) hovered.classList.add('hover');
    };
    const onDragMove = ev => {
      if (ev.pointerId !== pointerId) return;
      if (Math.hypot(ev.clientX - x, ev.clientY - y) > 18) moved = true;
      setHovered(itemAt(ev));
    };
    const onDragEnd = ev => {
      if (ev.pointerId !== pointerId) return;
      endDrag();
      if (moved) choose(itemAt(ev));
      else setHovered(null);
    };
    const endDrag = () => {
      dragging = false;
      window.removeEventListener('pointermove', onDragMove, true);
      window.removeEventListener('pointerup', onDragEnd, true);
      window.removeEventListener('pointercancel', onDragEnd, true);
    };
    window.addEventListener('pointermove', onDragMove, true);
    window.addEventListener('pointerup', onDragEnd, true);
    window.addEventListener('pointercancel', onDragEnd, true);

    // Modo toque: tras soltar sin arrastrar, tocar una opción la elige y tocar fuera cierra.
    overlay.addEventListener('pointerdown', ev => {
      if (dragging) return;
      ev.preventDefault();
      ev.stopPropagation();
      choose(ev.target.closest('.radial-item'));
    });
    overlay.addEventListener('contextmenu', ev => ev.preventDefault());
    const onKey = ev => {
      if (ev.key === 'Escape') this.close();
    };
    document.addEventListener('keydown', onKey);
    overlay._cleanup = () => {
      endDrag();
      document.removeEventListener('keydown', onKey);
    };
  }

  /** Cambia el color de la pluma activa (y vuelve a la pluma si había otra herramienta). */
  chooseColor(c) {
    const ed = this.editor;
    const p = ed.activePreset();
    if (!p) return;
    ed.toolbar.updatePreset(p.id, { c });
    if (ed.tool !== 'pen') ed.selectPreset(p.id);
  }

  close() {
    const el = this.el;
    if (!el) return;
    this.el = null;
    if (el._cleanup) el._cleanup();
    el.classList.add('closing');
    setTimeout(() => el.remove(), 120);
  }
}
