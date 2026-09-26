// Motor de tinta: geometría de los trazos (perfect-freehand) y dibujo en canvas.
// La misma geometría se usa en pantalla, en miniaturas y en la exportación a PDF.

import { getStroke } from '../../libs/perfect-freehand/index.mjs';
import { strokeBBox, rectsIntersect } from '../model/stroke.js';

export const BRUSHES = {
  pen: { name: 'Bolígrafo', thinning: 0.15, smoothing: 0.6, streamline: 0.38, alpha: 1, sizeMul: 1.15 },
  fountain: { name: 'Pluma', thinning: 0.6, smoothing: 0.62, streamline: 0.42, alpha: 1, sizeMul: 1.6, simulate: true },
  brush: { name: 'Pincel', thinning: 0.8, smoothing: 0.55, streamline: 0.42, alpha: 0.96, sizeMul: 2.3, simulate: true, taper: true },
  pencil: { name: 'Lápiz', thinning: 0.3, smoothing: 0.5, streamline: 0.32, alpha: 0.72, sizeMul: 0.95 },
  highlighter: { name: 'Subrayador', thinning: 0, smoothing: 0.55, streamline: 0.5, alpha: 0.36, sizeMul: 1, flat: true }
};

export const HIGHLIGHTER_ALPHA = BRUSHES.highlighter.alpha;

function easeOutSine(t) {
  return Math.sin((t * Math.PI) / 2);
}

/** Opciones de perfect-freehand para un trazo. */
export function freehandOptions(s, last = true) {
  const b = BRUSHES[s.t] || BRUSHES.pen;
  const size = Math.max(0.5, s.w * b.sizeMul);
  const opts = {
    size,
    thinning: b.thinning,
    smoothing: b.smoothing,
    streamline: b.streamline,
    simulatePressure: !!(s.np && b.simulate),
    easing: easeOutSine,
    last
  };
  if (b.flat) {
    opts.start = { cap: false, taper: 0 };
    opts.end = { cap: false, taper: 0 };
  } else if (b.taper) {
    opts.start = { cap: true, taper: size * 2.5 };
    opts.end = { cap: true, taper: size * 3.5 };
  } else {
    opts.start = { cap: true, taper: 0 };
    opts.end = { cap: true, taper: 0 };
  }
  if (s.np && !b.simulate) {
    // Sin presión real: grosor constante.
    opts.thinning = 0;
  }
  return opts;
}

/** Convierte el Float32Array [x,y,p,...] a la entrada de perfect-freehand. */
function toInput(pts, np) {
  const n = pts.length / 3;
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const p = pts[i * 3 + 2];
    out[i] = [pts[i * 3], pts[i * 3 + 1], np ? 0.5 : p > 0 ? p : 0.5];
  }
  return out;
}

/** Polígono de contorno del trazo (array de [x, y]). */
export function strokeOutline(s, last = true) {
  return getStroke(toInput(s.pts, s.np), freehandOptions(s, last));
}

/** Construye un Path2D suavizado (curvas cuadráticas por puntos medios) a partir del contorno. */
export function outlineToPath2D(outline) {
  const path = new Path2D();
  const n = outline.length;
  if (n < 3) return path;
  path.moveTo(outline[0][0], outline[0][1]);
  for (let i = 1; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    path.quadraticCurveTo(a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
  }
  path.closePath();
  return path;
}

/** Misma geometría como cadena SVG (para exportar a PDF). */
export function outlineToSvg(outline) {
  const n = outline.length;
  if (n < 3) return '';
  const f = v => (Math.round(v * 100) / 100).toString();
  let d = `M${f(outline[0][0])} ${f(outline[0][1])}`;
  for (let i = 1; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    d += `Q${f(a[0])} ${f(a[1])} ${f((a[0] + b[0]) / 2)} ${f((a[1] + b[1]) / 2)}`;
  }
  return d + 'Z';
}

/** Trazado de polilínea suavizada (trazos heredados de la versión anterior). */
function legacyPolyline(pts) {
  const path = new Path2D();
  const n = pts.length / 3;
  if (n === 0) return path;
  const X = i => pts[i * 3];
  const Y = i => pts[i * 3 + 1];
  path.moveTo(X(0), Y(0));
  if (n === 2) {
    path.lineTo(X(1), Y(1));
    return path;
  }
  if (n > 2) {
    path.lineTo((X(0) + X(1)) / 2, (Y(0) + Y(1)) / 2);
    for (let i = 1; i < n - 1; i++) {
      path.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
    }
    path.lineTo(X(n - 1), Y(n - 1));
  }
  return path;
}

function legacySvg(pts) {
  const n = pts.length / 3;
  const f = v => (Math.round(v * 100) / 100).toString();
  if (n === 0) return '';
  const X = i => pts[i * 3];
  const Y = i => pts[i * 3 + 1];
  let d = `M${f(X(0))} ${f(Y(0))}`;
  if (n === 1) return `${d}L${f(X(0) + 0.01)} ${f(Y(0))}`;
  if (n === 2) return `${d}L${f(X(1))} ${f(Y(1))}`;
  d += `L${f((X(0) + X(1)) / 2)} ${f((Y(0) + Y(1)) / 2)}`;
  for (let i = 1; i < n - 1; i++) {
    d += `Q${f(X(i))} ${f(Y(i))} ${f((X(i) + X(i + 1)) / 2)} ${f((Y(i) + Y(i + 1)) / 2)}`;
  }
  return `${d}L${f(X(n - 1))} ${f(Y(n - 1))}`;
}

function shapePath(s) {
  const path = new Path2D();
  const p = s.pts;
  const n = p.length / 3;
  if (!n) return path;
  path.moveTo(p[0], p[1]);
  for (let i = 1; i < n; i++) path.lineTo(p[i * 3], p[i * 3 + 1]);
  if (s.closed) path.closePath();
  return path;
}

function shapeSvg(s) {
  const p = s.pts;
  const n = p.length / 3;
  const f = v => (Math.round(v * 100) / 100).toString();
  if (!n) return '';
  let d = `M${f(p[0])} ${f(p[1])}`;
  for (let i = 1; i < n; i++) d += `L${f(p[i * 3])} ${f(p[i * 3 + 1])}`;
  if (s.closed) d += 'Z';
  return d;
}

/** Punta de flecha rellena para formas "arrow" (los dos últimos puntos definen la dirección). */
function arrowHead(s) {
  const p = s.pts;
  const n = p.length / 3;
  if (n < 2) return null;
  const x2 = p[(n - 1) * 3], y2 = p[(n - 1) * 3 + 1];
  const x1 = p[(n - 2) * 3], y1 = p[(n - 2) * 3 + 1];
  const ang = Math.atan2(y2 - y1, x2 - x1);
  const len = Math.max(12, s.w * 4.2);
  const spread = Math.PI / 7;
  return [
    [x2, y2],
    [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)],
    [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)]
  ];
}

// ---------- Especificación de dibujo (común a canvas y PDF) ----------

const specCache = new WeakMap();

/**
 * Describe cómo pintar un trazo: lista de operaciones { kind: 'fill'|'stroke', path2d, svg, color, alpha, width }.
 */
export function strokeSpec(s) {
  let spec = specCache.get(s);
  if (spec) return spec;
  const ops = [];
  if (s.t === 'shape') {
    const fillAlpha = s.fill === 'semi' ? 0.3 : s.fill === 'solid' ? 1 : 0;
    if (s.closed && fillAlpha > 0) {
      ops.push({ kind: 'fill', path2d: shapePath(s), svg: () => shapeSvg(s), color: s.fc || s.c, alpha: fillAlpha * (s.a ?? 1) });
    }
    if (!s.ns) {
      ops.push({ kind: 'stroke', path2d: shapePath(s), svg: () => shapeSvg(s), color: s.c, alpha: s.a ?? 1, width: s.w });
      if (s.sh === 'arrow') {
        const head = arrowHead(s);
        if (head) {
          const hp = new Path2D();
          hp.moveTo(head[0][0], head[0][1]);
          hp.lineTo(head[1][0], head[1][1]);
          hp.lineTo(head[2][0], head[2][1]);
          hp.closePath();
          const f = v => (Math.round(v * 100) / 100).toString();
          const hs = `M${f(head[0][0])} ${f(head[0][1])}L${f(head[1][0])} ${f(head[1][1])}L${f(head[2][0])} ${f(head[2][1])}Z`;
          ops.push({ kind: 'fill', path2d: hp, svg: () => hs, color: s.c, alpha: s.a ?? 1 });
        }
      }
    }
  } else if (s.lg) {
    const n = s.pts.length / 3;
    let width = s.w;
    let alpha = 1;
    if (s.t === 'highlighter') { width = s.w * 3.2; alpha = 0.45; }
    else if (s.t === 'pencil') alpha = 0.65;
    else if (s.t === 'fountain') width = s.w * 1.25;
    if (n === 1) {
      const path = new Path2D();
      path.arc(s.pts[0], s.pts[1], Math.max(0.5, width / 2), 0, Math.PI * 2);
      const f = v => (Math.round(v * 100) / 100).toString();
      const r = Math.max(0.5, width / 2);
      const x = s.pts[0], y = s.pts[1];
      const svg = `M${f(x - r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x + r)} ${f(y)}A${f(r)} ${f(r)} 0 1 0 ${f(x - r)} ${f(y)}Z`;
      ops.push({ kind: 'fill', path2d: path, svg: () => svg, color: s.c, alpha });
    } else {
      ops.push({ kind: 'stroke', path2d: legacyPolyline(s.pts), svg: () => legacySvg(s.pts), color: s.c, alpha, width });
    }
  } else {
    const b = BRUSHES[s.t] || BRUSHES.pen;
    let outline = null;
    const getOutline = () => {
      if (!outline) outline = strokeOutline(s, true);
      return outline;
    };
    ops.push({ kind: 'fill', path2d: outlineToPath2D(getOutline()), svg: () => outlineToSvg(getOutline()), color: s.c, alpha: b.alpha * (s.a ?? 1) });
  }
  spec = { ops, highlighter: s.t === 'highlighter' };
  specCache.set(s, spec);
  return spec;
}

/** Libera la geometría cacheada de un trazo (p. ej. tras modificarlo in situ; normalmente no hace falta). */
export function invalidateStroke(s) {
  specCache.delete(s);
}

export function drawStroke(ctx, s) {
  const spec = strokeSpec(s);
  for (const op of spec.ops) {
    ctx.globalAlpha = op.alpha;
    if (op.kind === 'fill') {
      ctx.fillStyle = op.color;
      ctx.fill(op.path2d);
    } else {
      ctx.strokeStyle = op.color;
      ctx.lineWidth = op.width;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.stroke(op.path2d);
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * Dibuja una lista de trazos: primero los subrayadores (quedan por debajo de la tinta) y luego el resto.
 * `clip` (opcional, en coordenadas de página) descarta los trazos que no lo tocan.
 * `skip` (Set opcional de ids) omite trazos (p. ej. los seleccionados que se están arrastrando).
 */
export function drawStrokes(ctx, strokes, clip = null, skip = null) {
  ctx.save();
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < strokes.length; i++) {
      const s = strokes[i];
      const isHl = s.t === 'highlighter';
      if ((pass === 0) !== isHl) continue;
      if (skip && skip.has(s.id)) continue;
      if (clip && !rectsIntersect(strokeBBox(s), clip)) continue;
      drawStroke(ctx, s);
    }
  }
  ctx.restore();
}

/** Dibuja un trazo "en vivo" (aún sin terminar) a partir de puntos planos; no usa caché. */
export function drawLiveStroke(ctx, s) {
  if (s.t === 'shape') {
    drawStroke(ctx, s);
    specCache.delete(s);
    return;
  }
  const b = BRUSHES[s.t] || BRUSHES.pen;
  const outline = getStroke(toInput(s.pts, s.np), freehandOptions(s, false));
  if (outline.length < 3) return;
  ctx.globalAlpha = b.alpha * (s.a ?? 1);
  ctx.fillStyle = s.c;
  ctx.fill(outlineToPath2D(outline));
  ctx.globalAlpha = 1;
}
