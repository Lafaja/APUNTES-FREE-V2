// Modelo de trazos e imágenes: creación, geometría, pruebas de impacto y transformaciones.
// Los trazos se tratan como valores inmutables: cualquier cambio crea un objeto nuevo
// (así las cachés por objeto se invalidan solas y el historial guarda referencias baratas).

import { uid } from '../core/util.js';

export const PEN_TYPES = ['pen', 'fountain', 'brush', 'pencil', 'highlighter'];

/** Crea un trazo nuevo a partir de un array plano [x,y,p, ...]. */
export function makeStroke({ t, c, w, pts, np = false, extra = null }) {
  const s = {
    id: uid('s'),
    t,
    c,
    w,
    pts: pts instanceof Float32Array ? pts : Float32Array.from(pts)
  };
  if (np) s.np = 1;
  if (extra) Object.assign(s, extra);
  return s;
}

/** Valida y repara un trazo leído de almacenamiento. Devuelve null si es irrecuperable. */
export function normalizeStroke(o) {
  if (!o || typeof o !== 'object') return null;
  let pts = o.pts;
  if (Array.isArray(pts)) pts = Float32Array.from(pts);
  else if (pts && !(pts instanceof Float32Array) && ArrayBuffer.isView(pts)) pts = new Float32Array(pts.buffer.slice(pts.byteOffset, pts.byteOffset + pts.byteLength));
  else if (pts && !(pts instanceof Float32Array) && typeof pts === 'object') pts = Float32Array.from(Object.values(pts));
  if (!(pts instanceof Float32Array) || pts.length < 3) return null;
  if (pts.length % 3 !== 0) pts = pts.slice(0, pts.length - (pts.length % 3));
  for (let i = 0; i < pts.length; i++) {
    if (!Number.isFinite(pts[i])) pts[i] = 0;
  }
  const s = { ...o, pts };
  if (!s.id) s.id = uid('s');
  if (!s.t) s.t = 'pen';
  if (typeof s.c !== 'string') s.c = '#111827';
  if (!Number.isFinite(s.w) || s.w <= 0) s.w = 2;
  return s;
}

export function normalizeImage(o) {
  if (!o || typeof o !== 'object' || !o.blobId) return null;
  const img = {
    id: o.id || uid('i'),
    blobId: o.blobId,
    x: Number.isFinite(o.x) ? o.x : 0,
    y: Number.isFinite(o.y) ? o.y : 0,
    w: Number.isFinite(o.w) && o.w > 0 ? o.w : 200,
    h: Number.isFinite(o.h) && o.h > 0 ? o.h : 150,
    rot: Number.isFinite(o.rot) ? o.rot : 0
  };
  if (o.crop && Number.isFinite(o.crop.w)) img.crop = { ...o.crop };
  return img;
}

// ---------- Geometría ----------

const bboxCache = new WeakMap();

/** Radio máximo que puede ocupar la tinta del trazo alrededor de sus puntos. */
export function strokeRadius(s) {
  if (s.lg) {
    if (s.t === 'highlighter') return (s.w * 3.2) / 2;
    if (s.t === 'fountain') return (s.w * 1.25) / 2;
    return s.w / 2;
  }
  switch (s.t) {
    case 'fountain': return s.w * 0.9;
    case 'brush': return s.w * 1.1;
    case 'highlighter': return s.w / 2;
    case 'shape': return s.w / 2;
    default: return s.w * 0.6;
  }
}

export function strokeBBox(s) {
  let b = bboxCache.get(s);
  if (b) return b;
  const p = s.pts;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const r = strokeRadius(s) + 1;
  if (s.sh === 'arrow') {
    // La punta de flecha sobresale del segmento base.
    const extra = Math.max(12, s.w * 4);
    minX -= extra; minY -= extra; maxX += extra; maxY += extra;
  }
  b = { minX: minX - r, minY: minY - r, maxX: maxX + r, maxY: maxY + r };
  bboxCache.set(s, b);
  return b;
}

export function imageCorners(img) {
  const cx = img.x + img.w / 2;
  const cy = img.y + img.h / 2;
  const a = ((img.rot || 0) * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const hw = img.w / 2, hh = img.h / 2;
  return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([dx, dy]) => [cx + dx * cos - dy * sin, cy + dx * sin + dy * cos]);
}

export function imageBBox(img) {
  const c = imageCorners(img);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of c) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

export function rectsIntersect(a, b) {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;
}

export function unionRect(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY)
  };
}

export function expandRect(r, d) {
  return { minX: r.minX - d, minY: r.minY - d, maxX: r.maxX + d, maxY: r.maxY + d };
}

/** Distancia al cuadrado del punto P al segmento AB. */
export function distSqPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const cx = ax + t * dx - px, cy = ay + t * dy - py;
  return cx * cx + cy * cy;
}

function segSegDistSq(ax, ay, bx, by, cx, cy, dx, dy) {
  // Si se cruzan, distancia 0.
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  return Math.min(
    distSqPointSeg(ax, ay, cx, cy, dx, dy),
    distSqPointSeg(bx, by, cx, cy, dx, dy),
    distSqPointSeg(cx, cy, ax, ay, bx, by),
    distSqPointSeg(dx, dy, ax, ay, bx, by)
  );
}

export function pointInPolygon(x, y, poly) {
  // poly: array plano [x0,y0,x1,y1,...]
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2], yi = poly[i * 2 + 1];
    const xj = poly[j * 2], yj = poly[j * 2 + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-12) + xi) inside = !inside;
  }
  return inside;
}

function strokePolygonFlat(s) {
  const out = new Float64Array((s.pts.length / 3) * 2);
  for (let i = 0, j = 0; i < s.pts.length; i += 3, j += 2) {
    out[j] = s.pts[i];
    out[j + 1] = s.pts[i + 1];
  }
  return out;
}

/** ¿El borrador (cápsula del segmento AB con radio r) toca el trazo? */
export function strokeHitByEraser(s, ax, ay, bx, by, r) {
  const b = strokeBBox(s);
  const minX = Math.min(ax, bx) - r, maxX = Math.max(ax, bx) + r;
  const minY = Math.min(ay, by) - r, maxY = Math.max(ay, by) + r;
  if (b.maxX < minX || b.minX > maxX || b.maxY < minY || b.minY > maxY) return false;
  const rr = r + strokeRadius(s) * 0.85;
  const rr2 = rr * rr;
  const p = s.pts;
  const n = p.length / 3;
  if (n === 1) return distSqPointSeg(p[0], p[1], ax, ay, bx, by) <= rr2;
  for (let i = 0; i < n - 1; i++) {
    const i3 = i * 3;
    if (segSegDistSq(p[i3], p[i3 + 1], p[i3 + 3], p[i3 + 4], ax, ay, bx, by) <= rr2) return true;
  }
  if (s.closed && s.fill && s.fill !== 'none') {
    const poly = strokePolygonFlat(s);
    if (pointInPolygon(bx, by, poly)) return true;
  }
  return false;
}

export function imageHitByPoint(img, x, y, pad = 0) {
  // Transformar el punto al sistema local de la imagen (sin rotación).
  const cx = img.x + img.w / 2, cy = img.y + img.h / 2;
  const a = (-(img.rot || 0) * Math.PI) / 180;
  const dx = x - cx, dy = y - cy;
  const lx = dx * Math.cos(a) - dy * Math.sin(a);
  const ly = dx * Math.sin(a) + dy * Math.cos(a);
  return Math.abs(lx) <= img.w / 2 + pad && Math.abs(ly) <= img.h / 2 + pad;
}

/**
 * Borrado de precisión: elimina las partes del trazo dentro de la cápsula AB/r.
 * Devuelve null si no hay impacto, o un array (posiblemente vacío) de fragmentos nuevos.
 */
export function splitStrokeByEraser(s, ax, ay, bx, by, r) {
  if (!strokeHitByEraser(s, ax, ay, bx, by, r)) return null;
  if (s.t === 'shape') return []; // las formas se borran completas
  const src = s.pts;
  const n = src.length / 3;
  const step = Math.max(0.75, r / 3);
  // Re-muestreo para que el corte sea preciso aunque los puntos estén separados.
  const dense = [];
  for (let i = 0; i < n; i++) {
    const i3 = i * 3;
    const x = src[i3], y = src[i3 + 1], p = src[i3 + 2];
    if (i > 0) {
      const px = src[i3 - 3], py = src[i3 - 2], pp = src[i3 - 1];
      const dist = Math.hypot(x - px, y - py);
      const k = Math.floor(dist / step);
      for (let j = 1; j <= k; j++) {
        const t = j / (k + 1);
        dense.push(px + (x - px) * t, py + (y - py) * t, pp + (p - pp) * t);
      }
    }
    dense.push(x, y, p);
  }
  const cut = r + strokeRadius(s) * 0.5;
  const cut2 = cut * cut;
  const fragments = [];
  let run = [];
  for (let i = 0; i < dense.length; i += 3) {
    const inside = distSqPointSeg(dense[i], dense[i + 1], ax, ay, bx, by) <= cut2;
    if (inside) {
      if (run.length >= 6) fragments.push(run);
      run = [];
    } else {
      run.push(dense[i], dense[i + 1], dense[i + 2]);
    }
  }
  if (run.length >= 6) fragments.push(run);
  return fragments.map(pts => {
    const frag = { ...s, id: uid('s'), pts: Float32Array.from(pts) };
    return frag;
  });
}

/** Fracción de puntos del trazo dentro del lazo (poly plano). */
export function strokeInsideLasso(s, poly, lassoBox) {
  const b = strokeBBox(s);
  if (lassoBox && !rectsIntersect(b, lassoBox)) return false;
  const p = s.pts;
  const n = p.length / 3;
  let inside = 0;
  const stride = n > 60 ? Math.ceil(n / 60) : 1;
  let checked = 0;
  for (let i = 0; i < n; i += stride) {
    checked++;
    if (pointInPolygon(p[i * 3], p[i * 3 + 1], poly)) inside++;
  }
  if (checked === 0) return false;
  if (s.t === 'shape' || n <= 3) return inside / checked >= 0.5;
  return inside / checked >= 0.55;
}

export function imageInsideLasso(img, poly) {
  const corners = imageCorners(img);
  const cx = img.x + img.w / 2, cy = img.y + img.h / 2;
  let count = pointInPolygon(cx, cy, poly) ? 2 : 0;
  for (const [x, y] of corners) if (pointInPolygon(x, y, poly)) count++;
  return count >= 3;
}

// ---------- Transformaciones (matriz afín [a,b,c,d,e,f]: x' = a*x + c*y + e, y' = b*x + d*y + f) ----------

export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function translation(dx, dy) {
  return [1, 0, 0, 1, dx, dy];
}

export function scalingAbout(sx, sy, ox, oy) {
  return [sx, 0, 0, sy, ox - sx * ox, oy - sy * oy];
}

export function rotationAbout(rad, ox, oy) {
  const c = Math.cos(rad), s = Math.sin(rad);
  return [c, s, -s, c, ox - c * ox + s * oy, oy - s * ox - c * oy];
}

export function applyMat(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function transformStroke(s, m) {
  const p = s.pts;
  const out = new Float32Array(p.length);
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1];
    out[i] = m[0] * x + m[2] * y + m[4];
    out[i + 1] = m[1] * x + m[3] * y + m[5];
    out[i + 2] = p[i + 2];
  }
  const det = Math.abs(m[0] * m[3] - m[1] * m[2]);
  const scale = Math.sqrt(det) || 1;
  const w = Math.abs(scale - 1) < 1e-6 ? s.w : Math.max(0.3, Math.round(s.w * scale * 100) / 100);
  return { ...s, pts: out, w };
}

export function transformImage(img, m) {
  const cx = img.x + img.w / 2, cy = img.y + img.h / 2;
  const [ncx, ncy] = applyMat(m, cx, cy);
  // Escala y rotación a partir de la matriz (sin cizalla).
  const sx = Math.hypot(m[0], m[1]);
  const sy = Math.hypot(m[2], m[3]);
  const rotDelta = (Math.atan2(m[1], m[0]) * 180) / Math.PI;
  const w = Math.max(8, img.w * sx);
  const h = Math.max(8, img.h * sy);
  let rot = ((img.rot || 0) + rotDelta) % 360;
  if (rot < 0) rot += 360;
  if (Math.abs(rot) < 0.01 || Math.abs(rot - 360) < 0.01) rot = 0;
  return { ...img, x: ncx - w / 2, y: ncy - h / 2, w, h, rot };
}

export function recolorStroke(s, color) {
  const out = { ...s, c: color };
  if (s.fc && s.fill && s.fill !== 'none') out.fc = color;
  return out;
}

// ---------- Serialización portátil (copias de seguridad JSON) ----------

export function strokeToJSON(s) {
  const pts = new Array(s.pts.length);
  for (let i = 0; i < s.pts.length; i++) pts[i] = Math.round(s.pts[i] * 100) / 100;
  return { ...s, pts };
}

export function strokeFromJSON(o) {
  return normalizeStroke(o);
}

export function cloneStroke(s, withNewId = false) {
  return { ...s, id: withNewId ? uid('s') : s.id, pts: new Float32Array(s.pts) };
}

export function cloneImage(img, withNewId = false) {
  return { ...img, id: withNewId ? uid('i') : img.id, crop: img.crop ? { ...img.crop } : undefined };
}

export function pointsFromArray(arr) {
  return Float32Array.from(arr);
}
