// Herramientas de dibujo: pluma/subrayador, borrador y formas.
// Todas dibujan la vista previa en la capa superpuesta (overlay) del visor y, al terminar,
// confirman el cambio en la sesión (que lo guarda y lo añade al historial).

import { makeStroke, strokeBBox, strokeHitByEraser, splitStrokeByEraser } from '../model/stroke.js';
import { drawLiveStroke, drawStroke, BRUSHES } from '../render/ink.js';
import { settings } from '../core/settings.js';
import { recognizeShape } from './recognize.js';

// Formas perfectas: si el lápiz se queda quieto este tiempo al final de un trazo, se intenta reconocer.
const HOLD_MS = 550;
const HOLD_MOVE_PX = 4; // movimiento (en píxeles de pantalla) que se considera "seguir dibujando"
const SNAP_MIN_PX = 30; // tamaño mínimo en pantalla para convertir (evita convertir letras)

function withPageClip(viewer, pageIndex, fn) {
  const ctx = viewer.octx;
  const m = viewer.overlayTransform(pageIndex);
  ctx.save();
  ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
  const ref = viewer.session.node.pages[pageIndex];
  if (ref) {
    ctx.beginPath();
    ctx.rect(0, 0, ref.w, ref.h);
    ctx.clip();
  }
  try {
    fn(ctx);
  } finally {
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pluma / subrayador
// ---------------------------------------------------------------------------

export class PenTool {
  constructor(editor) {
    this.editor = editor;
    this.modifies = true;
    this.usesPrediction = true;
    this.live = null;
    this.raf = 0;
  }

  begin(ctx) {
    const preset = this.editor.activePreset();
    this.ctx = ctx;
    this.minDist = 0.4 / ctx.viewer.zoom;
    this.live = { t: preset.t, c: preset.c, w: preset.w, np: ctx.np ? 1 : 0, pts: [ctx.x, ctx.y, ctx.p] };
    this.predicted = null;
    this.startTime = performance.now();
    this.snapped = null;
    this.holdAnchor = { x: ctx.x, y: ctx.y };
    this.armHold();
    this.render();
  }

  // ---------------- Formas perfectas (mantener el lápiz quieto) ----------------

  armHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!settings.get('shapeSnap')) return;
    this.holdTimer = setTimeout(() => this.onHold(), HOLD_MS);
  }

  onHold() {
    this.holdTimer = null;
    if (!this.live || this.snapped) return;
    const zoom = this.ctx.viewer.zoom;
    const shape = recognizeShape(this.live.pts, { minSize: SNAP_MIN_PX / zoom });
    if (!shape) return;
    this.snapped = this.shapeStroke(shape);
    if (navigator.vibrate) try { navigator.vibrate(10); } catch {}
    this.render();
  }

  /** Trazo "perfecto" con el mismo color y grosor que la pluma activa. */
  shapeStroke(shape) {
    const live = this.live;
    const b = BRUSHES[live.t] || BRUSHES.pen;
    const flat = [];
    for (let i = 0; i + 1 < shape.pts.length; i += 2) flat.push(shape.pts[i], shape.pts[i + 1], 0.5);
    if (live.t === 'highlighter') {
      // El subrayador conserva su aspecto (translúcido y por debajo de la tinta).
      return makeStroke({ t: 'highlighter', c: live.c, w: live.w, pts: densifyFlat(flat, shape.closed, 3 / this.ctx.viewer.zoom), np: true });
    }
    const extra = { sh: shape.type };
    if (shape.closed) extra.closed = 1;
    if (b.alpha < 1) extra.a = b.alpha;
    // perfect-freehand dibuja un grosor de ~√2 × tamaño con presión media: la forma usa el mismo grosor visual.
    const w = Math.max(0.5, live.w * b.sizeMul * Math.SQRT2 * (b.simulate ? 0.8 : 1));
    return makeStroke({ t: 'shape', c: live.c, w, pts: flat, np: true, extra });
  }

  move(points, predicted) {
    if (!this.live) return;
    const pts = this.live.pts;
    // Si el lápiz se mueve de verdad, se sigue dibujando a mano (y se deshace la forma si la había).
    const tol = HOLD_MOVE_PX / this.ctx.viewer.zoom;
    for (const p of points) {
      if (Math.hypot(p.x - this.holdAnchor.x, p.y - this.holdAnchor.y) > tol) {
        this.holdAnchor = { x: p.x, y: p.y };
        if (this.snapped) this.snapped = null;
        this.armHold();
      }
    }
    for (const p of points) {
      const n = pts.length;
      const dx = p.x - pts[n - 3];
      const dy = p.y - pts[n - 2];
      if (dx * dx + dy * dy < this.minDist * this.minDist) {
        // Mismo sitio: actualizar la presión para que la punta responda.
        pts[n - 1] = Math.max(pts[n - 1], p.p);
        continue;
      }
      pts.push(p.x, p.y, p.p);
    }
    this.predicted = predicted;
    this.scheduleRender();
  }

  scheduleRender() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.render();
    });
  }

  render() {
    const { viewer, pageIndex } = this.ctx;
    viewer.clearOverlay();
    if (!this.live) return;
    let s = this.live;
    if (this.predicted && this.predicted.length) {
      const extra = [];
      for (const p of this.predicted) extra.push(p.x, p.y, s.pts[s.pts.length - 1]);
      s = { ...s, pts: s.pts.concat(extra) };
    }
    if (this.snapped) {
      withPageClip(viewer, pageIndex, c => drawLiveStroke(c, this.snapped));
      return;
    }
    withPageClip(viewer, pageIndex, c => {
      if (s.pts.length === 3) {
        // Un solo punto: dibujar un punto visible.
        drawLiveStroke(c, { ...s, pts: [s.pts[0], s.pts[1], s.pts[2], s.pts[0] + 0.01, s.pts[1] + 0.01, s.pts[2]] });
      } else {
        drawLiveStroke(c, s);
      }
    });
  }

  end(lastPoint) {
    if (!this.live) return;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    const { viewer, pageId, pageIndex } = this.ctx;
    const live = this.live;
    this.live = null;
    if (this.snapped) {
      const shape = this.snapped;
      this.snapped = null;
      viewer.session.addStrokes(pageId, [shape], { origin: viewer, label: 'Forma' });
      this.editor.afterStroke(viewer, pageIndex, strokeBBox(shape));
      requestAnimationFrame(() => {
        if (!this.live) viewer.clearOverlay();
      });
      return;
    }
    if (lastPoint) {
      const n = live.pts.length;
      const dx = lastPoint.x - live.pts[n - 3];
      const dy = lastPoint.y - live.pts[n - 2];
      if (dx * dx + dy * dy >= this.minDist * this.minDist) live.pts.push(lastPoint.x, lastPoint.y, live.pts[n - 1]);
    }
    let pts = live.pts;
    if (pts.length === 3) pts = [pts[0], pts[1], pts[2], pts[0] + 0.05, pts[1] + 0.05, pts[2]];
    const stroke = makeStroke({ t: live.t, c: live.c, w: live.w, pts, np: !!live.np });
    const session = viewer.session;
    session.addStrokes(pageId, [stroke], { origin: viewer, label: 'Trazo' });
    this.editor.afterStroke(viewer, pageIndex, strokeBBox(stroke));
    // Borrar la vista previa en el siguiente frame (evita parpadeos con canvas desincronizado).
    requestAnimationFrame(() => {
      if (!this.live) viewer.clearOverlay();
    });
  }

  cancel() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    this.live = null;
    this.snapped = null;
    if (this.ctx) this.ctx.viewer.clearOverlay();
  }
}

/** Añade puntos intermedios (cada `step`) a una polilínea plana [x, y, p, ...]. */
function densifyFlat(flat, closed, step) {
  const n = flat.length / 3;
  const out = [];
  const m = closed ? n : n - 1;
  for (let i = 0; i < m; i++) {
    const ax = flat[i * 3], ay = flat[i * 3 + 1];
    const j = (i + 1) % n;
    const bx = flat[j * 3], by = flat[j * 3 + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / Math.max(0.5, step)));
    for (let t = 0; t < k; t++) out.push(ax + ((bx - ax) * t) / k, ay + ((by - ay) * t) / k, 0.5);
  }
  const endI = closed ? 0 : n - 1;
  out.push(flat[endI * 3], flat[endI * 3 + 1], 0.5);
  return out;
}

// ---------------------------------------------------------------------------
// Borrador (trazo completo o precisión)
// ---------------------------------------------------------------------------

export class EraserTool {
  constructor(editor) {
    this.editor = editor;
    this.modifies = true;
    this.usesPrediction = false;
  }

  radius(viewer) {
    const size = settings.get('eraser').size || 18;
    return size / 2 / viewer.zoom;
  }

  begin(ctx) {
    this.ctx = ctx;
    this.ops = [];
    this.last = { x: ctx.x, y: ctx.y };
    this.eraseSegment(this.last, this.last);
    this.drawCursor(this.last);
  }

  move(points) {
    for (const p of points) {
      this.eraseSegment(this.last, p);
      this.last = { x: p.x, y: p.y };
    }
    this.drawCursor(this.last);
  }

  eraseSegment(a, b) {
    const { viewer, pageId } = this.ctx;
    const session = viewer.session;
    const page = session.getPageSync(pageId);
    if (!page) return;
    const r = this.radius(viewer);
    const precision = settings.get('eraser').mode === 'precision';
    const ops = [];
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const s = page.strokes[i];
      if (precision) {
        const frags = splitStrokeByEraser(s, a.x, a.y, b.x, b.y, r);
        if (frags) ops.push({ key: 'strokes', index: i, removed: [s], added: frags });
      } else if (strokeHitByEraser(s, a.x, a.y, b.x, b.y, r)) {
        ops.push({ key: 'strokes', index: i, removed: [s], added: [] });
      }
    }
    if (!ops.length) return;
    // Índices descendentes: cada operación no afecta a las anteriores.
    session.commit(pageId, ops, { record: false, origin: viewer });
    this.ops.push(...ops);
  }

  drawCursor(p) {
    const { viewer, pageIndex } = this.ctx;
    viewer.clearOverlay();
    const ctx = viewer.octx;
    const m = viewer.overlayTransform(pageIndex);
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    const r = this.radius(viewer);
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(148,163,184,0.18)';
    ctx.fill();
    ctx.lineWidth = 1.5 / viewer.zoom;
    ctx.strokeStyle = 'rgba(71,85,105,0.85)';
    ctx.stroke();
    ctx.restore();
  }

  end() {
    const { viewer, pageId } = this.ctx;
    if (this.ops.length) viewer.session.recordOps(pageId, this.ops, 'Borrar');
    this.ops = [];
    viewer.clearOverlay();
  }

  cancel() {
    this.end();
  }
}

// ---------------------------------------------------------------------------
// Formas geométricas
// ---------------------------------------------------------------------------

export const SHAPES = [
  { id: 'line', name: 'Línea', icon: 'line' },
  { id: 'arrow', name: 'Flecha', icon: 'arrow' },
  { id: 'rect', name: 'Rectángulo', icon: 'rect' },
  { id: 'ellipse', name: 'Elipse', icon: 'ellipse' },
  { id: 'triangle', name: 'Triángulo', icon: 'triangle' },
  { id: 'star', name: 'Estrella', icon: 'star' },
  { id: 'hexagon', name: 'Hexágono', icon: 'hexagon' }
];

/** Genera los vértices de una forma entre dos puntos (a, b). */
export function shapePoints(type, a, b) {
  const minX = Math.min(a.x, b.x);
  const maxX = Math.max(a.x, b.x);
  const minY = Math.min(a.y, b.y);
  const maxY = Math.max(a.y, b.y);
  const w = maxX - minX;
  const h = maxY - minY;
  const cx = minX + w / 2;
  const cy = minY + h / 2;
  const out = [];
  let closed = false;
  if (type === 'line' || type === 'arrow') {
    out.push(a.x, a.y, 0.5, b.x, b.y, 0.5);
  } else if (type === 'rect') {
    out.push(minX, minY, 0.5, maxX, minY, 0.5, maxX, maxY, 0.5, minX, maxY, 0.5);
    closed = true;
  } else if (type === 'ellipse') {
    const n = Math.max(24, Math.min(96, Math.round((w + h) / 6)));
    for (let i = 0; i < n; i++) {
      const t = (i / n) * Math.PI * 2;
      out.push(cx + (w / 2) * Math.cos(t), cy + (h / 2) * Math.sin(t), 0.5);
    }
    closed = true;
  } else if (type === 'triangle') {
    out.push(cx, minY, 0.5, maxX, maxY, 0.5, minX, maxY, 0.5);
    closed = true;
  } else if (type === 'star') {
    const R = Math.min(w, h) / 2;
    const r = R * 0.45;
    for (let i = 0; i < 10; i++) {
      const rad = i % 2 === 0 ? R : r;
      const t = (i / 10) * Math.PI * 2 - Math.PI / 2;
      out.push(cx + rad * Math.cos(t), cy + rad * Math.sin(t), 0.5);
    }
    closed = true;
  } else if (type === 'hexagon') {
    const R = Math.min(w, h) / 2;
    for (let i = 0; i < 6; i++) {
      const t = (i / 6) * Math.PI * 2;
      out.push(cx + R * Math.cos(t), cy + R * Math.sin(t), 0.5);
    }
    closed = true;
  }
  return { pts: out, closed };
}

export class ShapeTool {
  constructor(editor) {
    this.editor = editor;
    this.modifies = true;
    this.usesPrediction = false;
  }

  begin(ctx) {
    this.ctx = ctx;
    this.a = { x: ctx.x, y: ctx.y };
    this.b = { x: ctx.x, y: ctx.y };
  }

  build() {
    const cfg = settings.get('shape');
    const { pts, closed } = shapePoints(cfg.type, this.a, this.b);
    if (!pts.length) return null;
    const extra = { sh: cfg.type };
    if (closed) extra.closed = 1;
    if (closed && cfg.fill && cfg.fill !== 'none') {
      extra.fill = cfg.fill;
      extra.fc = cfg.color;
    }
    return makeStroke({ t: 'shape', c: cfg.color, w: cfg.w, pts, np: true, extra });
  }

  move(points) {
    const p = points[points.length - 1];
    if (!p) return;
    this.b = { x: p.x, y: p.y };
    const s = this.build();
    const { viewer, pageIndex } = this.ctx;
    viewer.clearOverlay();
    if (s) withPageClip(viewer, pageIndex, c => drawStroke(c, s));
  }

  end(last) {
    if (last) this.b = { x: last.x, y: last.y };
    const { viewer, pageId } = this.ctx;
    viewer.clearOverlay();
    const size = Math.hypot(this.b.x - this.a.x, this.b.y - this.a.y) * viewer.zoom;
    if (size < 6) return;
    const s = this.build();
    if (!s) return;
    viewer.session.addStrokes(pageId, [s], { origin: viewer, label: 'Forma' });
  }

  cancel() {
    if (this.ctx) this.ctx.viewer.clearOverlay();
  }
}
