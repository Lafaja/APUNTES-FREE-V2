// Enrutado de entrada táctil / lápiz / ratón para un visor.
//
// - Lápiz: siempre dibuja con la herramienta activa (el extremo borrador o el botón lateral borran).
// - Dedo: desplaza con inercia (o dibuja si el modo dedo lo permite). Dos dedos: zoom y desplazamiento.
// - Rechazo de palma: mientras el lápiz está apoyado (y 500 ms después) se ignoran los dedos.
// - Toque con dos dedos = deshacer; con tres dedos = rehacer.
// - Toque con un dedo (cuando el dedo desplaza) o Ctrl+clic: sigue los enlaces del PDF.

import { settings, fingerDraws } from '../core/settings.js';
import { pdfQueue } from '../render/pdf.js';

const PALM_GUARD_MS = 500;
const TAP_MAX_MS = 280;
const TAP_MAX_MOVE = 14;

export class InputController {
  constructor(viewer, editor) {
    this.viewer = viewer;
    this.editor = editor;
    this.el = viewer.scroll;
    this.touches = new Map();
    this.mode = 'idle'; // idle | draw | pan | pinch | mousepan
    this.drawPointer = null; // { id, type, pageIndex, tool, pen }
    this.penUntil = 0;
    this.velocity = { x: 0, y: 0, samples: [] };
    this.momentumRaf = 0;
    this.multiTap = null;
    this.spaceDown = false;

    this._down = e => this.onDown(e);
    this._move = e => this.onMove(e);
    this._up = e => this.onUp(e);
    this._cancel = e => this.onUp(e, true);
    this._ctx = e => e.preventDefault();
    this._keydown = e => {
      if (e.code === 'Space' && !isTyping(e)) this.spaceDown = true;
    };
    this._keyup = e => {
      if (e.code === 'Space') this.spaceDown = false;
    };
    this.el.addEventListener('pointerdown', this._down);
    this.el.addEventListener('pointermove', this._move);
    this.el.addEventListener('pointerup', this._up);
    this.el.addEventListener('pointercancel', this._cancel);
    this.el.addEventListener('lostpointercapture', this._cancel);
    this.el.addEventListener('contextmenu', this._ctx);
    window.addEventListener('keydown', this._keydown);
    window.addEventListener('keyup', this._keyup);
  }

  destroy() {
    this.stopMomentum();
    this.el.removeEventListener('pointerdown', this._down);
    this.el.removeEventListener('pointermove', this._move);
    this.el.removeEventListener('pointerup', this._up);
    this.el.removeEventListener('pointercancel', this._cancel);
    this.el.removeEventListener('lostpointercapture', this._cancel);
    this.el.removeEventListener('contextmenu', this._ctx);
    window.removeEventListener('keydown', this._keydown);
    window.removeEventListener('keyup', this._keyup);
  }

  // ------------------------------------------------------------------

  pointFromEvent(ev, pageIndex) {
    const pt = this.viewer.clientToPage(ev.clientX, ev.clientY, pageIndex);
    if (!pt) return null;
    const isPen = ev.pointerType === 'pen';
    let p = isPen && ev.pressure > 0 ? ev.pressure : 0.5;
    if (p > 1) p = 1;
    return { x: pt.x, y: pt.y, p, index: pt.index };
  }

  onDown(e) {
    if (e.target && e.target.closest && e.target.closest('button, .add-page-btn, .selection-menu')) return;
    this.stopMomentum();
    this.editor.setActiveViewer(this.viewer);
    const type = e.pointerType || 'mouse';

    if (type === 'pen') {
      if (!settings.get('penDetected')) {
        settings.set('penDetected', true);
        this.editor.onPenDetected();
      }
      // El lápiz manda: se cancela cualquier gesto de dedos en curso.
      this.cancelTouches();
      this.penUntil = Date.now() + PALM_GUARD_MS;
      if (this.drawPointer) return;
      const eraser = e.button === 5 || (e.buttons & 32) === 32 || (e.buttons & 2) === 2;
      this.startDraw(e, eraser ? 'eraser' : null);
      return;
    }

    if (type === 'mouse') {
      if (e.button === 1 || (e.button === 0 && this.spaceDown)) {
        e.preventDefault();
        this.mode = 'mousepan';
        this.lastPan = { x: e.clientX, y: e.clientY, id: e.pointerId };
        try { this.el.setPointerCapture(e.pointerId); } catch {}
        return;
      }
      if (e.button !== 0 || this.drawPointer) return;
      if (e.ctrlKey || e.metaKey) {
        // Ctrl+clic: seguir un enlace del PDF (con el ratón, el clic normal dibuja).
        e.preventDefault();
        this.editor.onTap(this.viewer, e.clientX, e.clientY, { mouse: true });
        return;
      }
      this.startDraw(e, null);
      return;
    }

    // ---- Táctil ----
    if (Date.now() < this.penUntil || (this.drawPointer && this.drawPointer.type === 'pen')) return; // palma
    e.preventDefault();
    this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });

    if (this.touches.size === 1) {
      this.multiTap = { count: 1, t0: performance.now(), maxCount: 1, moved: false, x: e.clientX, y: e.clientY };
      if (fingerDraws() && !this.editor.isReadOnly()) {
        this.startDraw(e, null);
        if (this.drawPointer) this.drawPointer.startedAt = performance.now();
      } else {
        this.beginPan(e);
      }
      return;
    }

    if (this.multiTap && performance.now() - this.multiTap.t0 < 180) {
      this.multiTap.count = this.touches.size;
      this.multiTap.maxCount = Math.max(this.multiTap.maxCount, this.touches.size);
    } else {
      this.multiTap = null;
    }

    if (this.touches.size === 2) {
      // Un trazo con el dedo que acaba de empezar era en realidad el inicio de un gesto.
      if (this.drawPointer && this.drawPointer.type === 'touch') this.cancelDraw();
      this.mode = 'pinch';
      const [a, b] = [...this.touches.values()];
      this.viewer.pinchStart((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }

  onMove(e) {
    const type = e.pointerType || 'mouse';
    if (this.drawPointer && e.pointerId === this.drawPointer.id) {
      this.moveDraw(e);
      return;
    }
    if (this.mode === 'mousepan' && this.lastPan && e.pointerId === this.lastPan.id) {
      this.el.scrollLeft -= e.clientX - this.lastPan.x;
      this.el.scrollTop -= e.clientY - this.lastPan.y;
      this.lastPan.x = e.clientX;
      this.lastPan.y = e.clientY;
      return;
    }
    if (type !== 'touch') {
      this.editor.onHover(this.viewer, e);
      return;
    }
    const t = this.touches.get(e.pointerId);
    if (!t) return;
    const px = t.x;
    const py = t.y;
    t.x = e.clientX;
    t.y = e.clientY;
    if (this.multiTap && Math.hypot(t.x - t.sx, t.y - t.sy) > TAP_MAX_MOVE) this.multiTap.moved = true;

    if (this.mode === 'pan' && this.touches.size === 1) {
      const dx = t.x - px;
      const dy = t.y - py;
      this.el.scrollLeft -= dx;
      this.el.scrollTop -= dy;
      this.trackVelocity(dx, dy);
    } else if (this.mode === 'pinch' && this.touches.size >= 2) {
      const [a, b] = [...this.touches.values()];
      this.viewer.pinchMove((a.x + b.x) / 2, (a.y + b.y) / 2, Math.hypot(a.x - b.x, a.y - b.y));
    }
  }

  onUp(e, cancelled = false) {
    const type = e.pointerType || 'mouse';
    if (this.drawPointer && e.pointerId === this.drawPointer.id) {
      if (cancelled && e.type === 'lostpointercapture' && !this.drawPointer.ending) {
        // Captura perdida sin pointerup: terminar el trazo tal cual (no se descarta tinta).
        this.endDraw(e);
      } else if (cancelled && e.type === 'pointercancel') {
        this.endDraw(e);
      } else if (!cancelled) {
        this.endDraw(e);
      }
      return;
    }
    if (this.mode === 'mousepan' && this.lastPan && e.pointerId === this.lastPan.id) {
      this.mode = 'idle';
      this.lastPan = null;
      return;
    }
    if (type !== 'touch') return;
    if (!this.touches.has(e.pointerId)) return;
    this.touches.delete(e.pointerId);

    if (this.mode === 'pinch' && this.touches.size < 2) {
      this.viewer.pinchEnd();
      this.checkMultiTap();
      if (this.touches.size === 1) {
        // Continuar desplazando con el dedo que queda, sin saltos.
        const [rest] = [...this.touches.values()];
        rest.sx = rest.x;
        rest.sy = rest.y;
        this.mode = 'pan';
        this.velocity.samples = [];
      } else {
        this.mode = 'idle';
      }
      return;
    }
    if (this.mode === 'pan' && this.touches.size === 0) {
      this.mode = 'idle';
      if (!cancelled) this.startMomentum();
      this.checkMultiTap();
      return;
    }
    if (this.touches.size === 0) {
      this.checkMultiTap();
      this.mode = 'idle';
    }
  }

  checkMultiTap() {
    const m = this.multiTap;
    if (!m || this.touches.size > 0) return;
    this.multiTap = null;
    if (m.moved || performance.now() - m.t0 > TAP_MAX_MS * 1.6) return;
    if (m.maxCount === 1) {
      this.editor.onTap(this.viewer, m.x, m.y, { mouse: false });
      return;
    }
    if (!settings.get('twoFingerUndo')) return;
    if (m.maxCount === 2) this.editor.undo();
    else if (m.maxCount === 3) this.editor.redo();
  }

  cancelTouches() {
    if (this.mode === 'pinch') this.viewer.pinchEnd();
    if (this.drawPointer && this.drawPointer.type === 'touch') this.cancelDraw();
    this.touches.clear();
    this.multiTap = null;
    if (this.mode !== 'draw') this.mode = 'idle';
    this.stopMomentum();
  }

  // ---------------- Dibujo ----------------

  startDraw(e, forcedTool) {
    const tool = this.editor.toolFor(forcedTool);
    if (!tool) return;
    if (this.editor.isReadOnly() && tool.modifies) {
      this.editor.flashReadOnly();
      if (e.pointerType === 'touch') this.beginPan(e);
      return;
    }
    const pt = this.pointFromEvent(e, -1);
    if (!pt) return;
    const pageRef = this.viewer.session.node.pages[pt.index];
    if (!pageRef) return;
    const page = this.viewer.session.getPageSync(pageRef.id);
    if (!page) return; // aún cargando: se ignora (tarda milisegundos)
    e.preventDefault();
    try { this.el.setPointerCapture(e.pointerId); } catch {}
    this.drawPointer = { id: e.pointerId, type: e.pointerType || 'mouse', pageIndex: pt.index, tool, pen: e.pointerType === 'pen' };
    this.mode = 'draw';
    pdfQueue.pause();
    // Solo la pluma aplaza los repintados (el borrador necesita ver al momento lo que borra).
    this.viewer.setDrawing(tool === this.editor.tools.pen);
    tool.begin({
      viewer: this.viewer,
      pageIndex: pt.index,
      pageId: pageRef.id,
      page,
      x: pt.x,
      y: pt.y,
      p: pt.p,
      np: e.pointerType !== 'pen',
      pointerType: e.pointerType,
      clientX: e.clientX,
      clientY: e.clientY
    });
  }

  moveDraw(e) {
    const d = this.drawPointer;
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : null;
    const list = events && events.length ? events : [e];
    const pts = [];
    for (const ev of list) {
      const p = this.pointFromEvent(ev, d.pageIndex);
      if (p) pts.push(p);
    }
    let predicted = null;
    if (typeof e.getPredictedEvents === 'function' && d.tool.usesPrediction) {
      const pe = e.getPredictedEvents();
      if (pe && pe.length) {
        predicted = [];
        for (const ev of pe.slice(0, 2)) {
          const p = this.pointFromEvent(ev, d.pageIndex);
          if (p) predicted.push(p);
        }
      }
    }
    if (d.pen) this.penUntil = Date.now() + PALM_GUARD_MS;
    d.tool.move(pts, predicted, e);
  }

  endDraw(e) {
    const d = this.drawPointer;
    if (!d) return;
    d.ending = true;
    this.drawPointer = null;
    this.mode = 'idle';
    try {
      if (this.el.hasPointerCapture && this.el.hasPointerCapture(d.id)) this.el.releasePointerCapture(d.id);
    } catch {}
    const last = e && e.clientX !== undefined ? this.pointFromEvent(e, d.pageIndex) : null;
    try {
      d.tool.end(last);
    } finally {
      if (d.pen) this.penUntil = Date.now() + PALM_GUARD_MS;
      pdfQueue.resume();
      this.viewer.setDrawing(false);
    }
    if (d.type === 'touch') this.touches.delete(d.id);
  }

  cancelDraw() {
    const d = this.drawPointer;
    if (!d) return;
    this.drawPointer = null;
    try { d.tool.cancel(); } catch {}
    pdfQueue.resume();
    this.viewer.setDrawing(false);
    this.mode = 'idle';
  }

  // ---------------- Desplazamiento con inercia ----------------

  beginPan(e) {
    this.mode = 'pan';
    this.velocity = { x: 0, y: 0, samples: [] };
    if (!this.touches.has(e.pointerId)) {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now() });
    }
  }

  trackVelocity(dx, dy) {
    const now = performance.now();
    const s = this.velocity.samples;
    s.push({ t: now, dx, dy });
    while (s.length && now - s[0].t > 90) s.shift();
  }

  startMomentum() {
    const s = this.velocity.samples;
    if (s.length < 2) return;
    // Si el dedo se detuvo antes de levantarse, no hay inercia (evita "saltos" al soltar).
    if (performance.now() - s[s.length - 1].t > 70) return;
    const dt = s[s.length - 1].t - s[0].t || 16;
    let sx = 0;
    let sy = 0;
    for (const k of s) {
      sx += k.dx;
      sy += k.dy;
    }
    let vx = sx / dt; // px/ms
    let vy = sy / dt;
    if (Math.hypot(vx, vy) < 0.12) return;
    let last = performance.now();
    const step = now => {
      const elapsed = Math.min(40, now - last);
      last = now;
      const decay = Math.pow(0.9965, elapsed); // rozamiento suave (similar a iOS)
      vx *= decay;
      vy *= decay;
      const beforeL = this.el.scrollLeft;
      const beforeT = this.el.scrollTop;
      this.el.scrollLeft -= vx * elapsed;
      this.el.scrollTop -= vy * elapsed;
      const stuck = this.el.scrollLeft === beforeL && this.el.scrollTop === beforeT;
      if (Math.hypot(vx, vy) > 0.02 && !stuck) this.momentumRaf = requestAnimationFrame(step);
      else this.momentumRaf = 0;
    };
    this.momentumRaf = requestAnimationFrame(step);
  }

  stopMomentum() {
    if (this.momentumRaf) cancelAnimationFrame(this.momentumRaf);
    this.momentumRaf = 0;
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}
