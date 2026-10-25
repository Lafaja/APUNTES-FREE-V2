// Herramientas de dibujo: pluma/subrayador, borrador y formas.
// Todas dibujan la vista previa en la capa superpuesta (overlay) del visor y, al terminar,
// confirman el cambio en la sesión (que lo guarda y lo añade al historial).

import { makeStroke, strokeBBox, strokeHitByEraser, splitStrokeByEraser } from '../model/stroke.js';
import { drawLiveStroke, drawStroke, BRUSHES, thinningFor } from '../render/ink.js';
import { settings, timing } from '../core/settings.js';
import { recognizeShape } from './recognize.js';

// Formas perfectas: si el lápiz se queda quieto `shapeSnapDelay` ms al final de un trazo (moviéndose
// menos de `shapeSnapTolerance` píxeles de pantalla), se intenta reconocer. Ambos en Ajustes → Tiempos.
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
    // Sin puntos predichos: se dibujaban como un tramo recto por delante de la punta.
    this.usesPrediction = false;
    this.live = null;
    this.raf = 0;
  }

  begin(ctx) {
    const preset = this.editor.activePreset();
    this.ctx = ctx;
    this.minDist = 0.4 / ctx.viewer.zoom;
    this.live = { t: preset.t, c: preset.c, w: preset.w, np: ctx.np ? 1 : 0, pts: [ctx.x, ctx.y, ctx.p] };
    const th = thinningFor(preset.t, settings.get('pressure'));
    if (th !== undefined) this.live.th = th;
    if (preset.ds && preset.ds !== 'solid' && preset.t !== 'highlighter') this.live.ds = preset.ds;
    this.predicted = null;
    this.startTime = performance.now();
    this.snapped = null;
    this.snapEdit = null;
    this.holdAnchor = { x: ctx.x, y: ctx.y };
    this.armHold();
    this.render();
  }

  // ---------------- Formas perfectas (mantener el lápiz quieto) ----------------

  armHold() {
    clearTimeout(this.holdTimer);
    this.holdTimer = null;
    if (!settings.get('shapeSnap')) return;
    this.holdTimer = setTimeout(() => this.onHold(), timing('shapeSnapDelay'));
  }

  onHold() {
    this.holdTimer = null;
    if (!this.live || this.snapped) return;
    const zoom = this.ctx.viewer.zoom;
    const shape = recognizeShape(this.live.pts, { minSize: SNAP_MIN_PX / zoom });
    if (!shape) return;
    this.snapEdit = editableShape(shape);
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
    if (live.ds) extra.ds = live.ds;
    // perfect-freehand dibuja un grosor de ~√2 × tamaño con presión media: la forma usa el mismo grosor visual.
    const w = Math.max(0.5, live.w * b.sizeMul * Math.SQRT2 * (b.simulate ? 0.8 : 1));
    return makeStroke({ t: 'shape', c: live.c, w, pts: flat, np: true, extra });
  }

  move(points, predicted) {
    if (!this.live) return;
    const pts = this.live.pts;
    // Si el lápiz se mueve de verdad, se sigue dibujando a mano (y se deshace la forma si la había).
    const tol = timing('shapeSnapTolerance') / this.ctx.viewer.zoom;
    // Línea o círculo ya perfectos: seguir moviendo el lápiz los ajusta (ángulo/largo o tamaño).
    if (this.snapped && this.snapEdit && points.length) {
      const p = points[points.length - 1];
      if (Math.hypot(p.x - this.holdAnchor.x, p.y - this.holdAnchor.y) > tol || this.snapEdit.moved) {
        this.snapEdit.moved = true;
        this.snapped = this.shapeStroke(adjustShape(this.snapEdit, p));
        this.scheduleRender();
      }
      return;
    }
    for (const p of points) {
      if (Math.hypot(p.x - this.holdAnchor.x, p.y - this.holdAnchor.y) > tol) {
        this.holdAnchor = { x: p.x, y: p.y };
        if (this.snapped) this.snapped = null;
        this.snapEdit = null;
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
      if (this.snapEdit) drawSnapLabel(viewer, pageIndex, this.snapEdit);
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
      this.snapEdit = null;
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
    const extra = {};
    if (live.th !== undefined) extra.th = live.th;
    if (live.ds) extra.ds = live.ds;
    const stroke = makeStroke({ t: live.t, c: live.c, w: live.w, pts, np: !!live.np, extra });
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
    this.snapEdit = null;
    if (this.ctx) this.ctx.viewer.clearOverlay();
  }
}

// ---------------- Ajuste de la forma perfecta tras reconocerla ----------------

const DEG = Math.PI / 180;
const ANGLE_MAGNET = 3; // grados: cerca de un múltiplo de 45° se queda exacto

/** Estado editable de una línea (primer punto fijo) o un círculo (centro fijo); null para el resto. */
function editableShape(shape) {
  const P = shape.pts;
  if (shape.type === 'line') return { type: 'line', ax: P[0], ay: P[1], bx: P[2], by: P[3], moved: false };
  if (shape.type === 'circle') {
    let cx = 0, cy = 0;
    const n = P.length / 2;
    for (let i = 0; i < P.length; i += 2) { cx += P[i]; cy += P[i + 1]; }
    cx /= n;
    cy /= n;
    return { type: 'circle', cx, cy, r: Math.hypot(P[0] - cx, P[1] - cy), moved: false };
  }
  return null;
}

/** Ángulo de la línea en grados (0 = hacia la derecha, en sentido antihorario, 0–359). */
function lineAngle(e) {
  const a = Math.atan2(-(e.by - e.ay), e.bx - e.ax) / DEG;
  return (Math.round(a) + 360) % 360;
}

/** Recalcula la forma con el lápiz en `p`: la línea apunta al lápiz, el círculo pasa por él. */
function adjustShape(e, p) {
  if (e.type === 'line') {
    const len = Math.hypot(p.x - e.ax, p.y - e.ay);
    let ang = Math.atan2(p.y - e.ay, p.x - e.ax);
    const snap = Math.round(ang / (45 * DEG)) * 45 * DEG;
    if (Math.abs(ang - snap) < ANGLE_MAGNET * DEG) ang = snap;
    e.bx = e.ax + Math.cos(ang) * len;
    e.by = e.ay + Math.sin(ang) * len;
    return { type: 'line', pts: [e.ax, e.ay, e.bx, e.by], closed: false };
  }
  e.r = Math.max(1, Math.hypot(p.x - e.cx, p.y - e.cy));
  return { type: 'circle', pts: circlePoints(e.cx, e.cy, e.r), closed: true };
}

function circlePoints(cx, cy, r) {
  const n = Math.max(40, Math.min(120, Math.round(r / 1.5)));
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push(cx + r * Math.cos(t), cy + r * Math.sin(t));
  }
  return pts;
}

/** Etiqueta junto a la forma: el ángulo de la línea o «Círculo perfecto» (con el centro marcado). */
function drawSnapLabel(viewer, pageIndex, e) {
  const ctx = viewer.octx;
  const m = viewer.overlayTransform(pageIndex);
  const d = viewer.dpr;
  const toScreen = (x, y) => [m[0] * x + m[4], m[3] * y + m[5]];
  let text;
  let x;
  let y;
  if (e.type === 'line') {
    const ang = lineAngle(e);
    text = ang % 90 === 0 ? `${ang}° ${ang % 180 === 0 ? 'horizontal' : 'vertical'}` : `${ang}°`;
    [x, y] = toScreen(e.bx, e.by);
    x += 18 * d;
    y -= 22 * d;
  } else {
    text = 'Círculo perfecto';
    const [cx, cy] = toScreen(e.cx, e.cy);
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#2563eb';
    ctx.beginPath();
    ctx.arc(cx, cy, 3.5 * d, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    x = cx;
    y = cy - m[3] * e.r - 20 * d;
  }
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.font = `600 ${13 * d}px system-ui, sans-serif`;
  const w = ctx.measureText(text).width + 18 * d;
  const hgt = 24 * d;
  x = Math.max(4 * d, Math.min(viewer.overlay.width - w - 4 * d, x - (e.type === 'circle' ? w / 2 : 0)));
  y = Math.max(hgt / 2 + 4 * d, Math.min(viewer.overlay.height - hgt / 2 - 4 * d, y));
  ctx.fillStyle = 'rgba(37, 99, 235, 0.92)';
  ctx.beginPath();
  if (ctx.roundRect) ctx.roundRect(x, y - hgt / 2, w, hgt, hgt / 2);
  else ctx.rect(x, y - hgt / 2, w, hgt);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 9 * d, y + 0.5 * d);
  ctx.restore();
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
    if (cfg.ds && cfg.ds !== 'solid') extra.ds = cfg.ds;
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
