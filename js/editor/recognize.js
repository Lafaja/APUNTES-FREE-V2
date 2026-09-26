// Reconocimiento de formas dibujadas a mano: al terminar un trazo manteniendo el lápiz quieto,
// la línea, círculo, elipse, triángulo, rectángulo o polígono se sustituye por su versión perfecta.
//
// Todo trabaja en coordenadas de página. recognizeShape() devuelve
// { type, pts: [x0, y0, x1, y1, ...], closed } o null si el trazo no parece ninguna forma.

const DEG = Math.PI / 180;

function toPoints(flat) {
  const out = [];
  for (let i = 0; i + 1 < flat.length; i += 3) {
    const x = flat[i];
    const y = flat[i + 1];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    const last = out[out.length - 1];
    if (!last || Math.hypot(x - last.x, y - last.y) > 0.01) out.push({ x, y });
  }
  return out;
}

function pathLength(P) {
  let L = 0;
  for (let i = 1; i < P.length; i++) L += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  return L;
}

function bbox(P) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of P) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** n puntos a la misma distancia a lo largo del trazo (quita el efecto de la velocidad al dibujar). */
function resample(P, n) {
  const I = pathLength(P) / (n - 1);
  if (!(I > 0)) return null;
  const pts = P.map(p => ({ x: p.x, y: p.y }));
  const out = [pts[0]];
  let D = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (d > 0 && D + d >= I) {
      const t = (I - D) / d;
      const q = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
      out.push(q);
      pts.splice(i, 0, q);
      D = 0;
    } else {
      D += d;
    }
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out.slice(0, n);
}

function distToSeg(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const L2 = dx * dx + dy * dy;
  let t = L2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Douglas-Peucker sobre una polilínea abierta. */
function simplify(P, eps) {
  if (P.length < 3) return P.slice();
  let maxD = -1;
  let idx = 0;
  const a = P[0];
  const b = P[P.length - 1];
  for (let i = 1; i < P.length - 1; i++) {
    const d = distToSeg(P[i], a, b);
    if (d > maxD) {
      maxD = d;
      idx = i;
    }
  }
  if (maxD > eps) {
    const left = simplify(P.slice(0, idx + 1), eps);
    const right = simplify(P.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

/** Ángulo interior (grados) en el vértice b del camino a-b-c. 180 = recto (sin esquina). */
function cornerAngle(a, b, c) {
  const v1x = a.x - b.x, v1y = a.y - b.y;
  const v2x = c.x - b.x, v2y = c.y - b.y;
  const n = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (!n) return 180;
  return Math.acos(Math.max(-1, Math.min(1, (v1x * v2x + v1y * v2y) / n))) / DEG;
}

/** Vértices de un camino cerrado: Douglas-Peucker entre los dos puntos más alejados y limpieza. */
function closedVertices(R, diag) {
  const n = R.length;
  // Anclas: el punto más alejado del centro y el más alejado de ese (suelen ser esquinas).
  let cx = 0, cy = 0;
  for (const p of R) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let a = 0;
  for (let i = 1; i < n; i++) if (Math.hypot(R[i].x - cx, R[i].y - cy) > Math.hypot(R[a].x - cx, R[a].y - cy)) a = i;
  let b = a;
  for (let i = 0; i < n; i++) if (Math.hypot(R[i].x - R[a].x, R[i].y - R[a].y) > Math.hypot(R[b].x - R[a].x, R[b].y - R[a].y)) b = i;
  const rot = R.slice(a).concat(R.slice(0, a));
  const bi = (b - a + n) % n;
  const eps = Math.max(1.5, 0.055 * diag);
  const h1 = simplify(rot.slice(0, bi + 1), eps);
  const h2 = simplify(rot.slice(bi).concat([rot[0]]), eps);
  let V = h1.slice(0, -1).concat(h2.slice(0, -1));
  return cleanVertices(V, diag, true);
}

/**
 * Quita vértices que no son esquinas de verdad: primero el más "plano" (ángulo casi llano),
 * luego une los que están casi pegados. Se repite hasta que no cambia nada.
 */
function cleanVertices(V, diag, closed) {
  V = V.slice();
  const minEdge = 0.12 * diag;
  const angleAt = i => {
    const n = V.length;
    if (!closed && (i === 0 || i === n - 1)) return 0; // los extremos de un trazo abierto se quedan
    return cornerAngle(V[(i - 1 + n) % n], V[i], V[(i + 1) % n]);
  };
  for (let guard = 0; guard < 200 && V.length > (closed ? 3 : 2); guard++) {
    let flat = -1;
    let flatAng = 150;
    for (let i = 0; i < V.length; i++) {
      const a = angleAt(i);
      if (a > flatAng) {
        flatAng = a;
        flat = i;
      }
    }
    if (flat !== -1) {
      V.splice(flat, 1);
      continue;
    }
    let merged = false;
    const m = closed ? V.length : V.length - 1;
    for (let i = 0; i < m; i++) {
      const j = (i + 1) % V.length;
      if (Math.hypot(V[i].x - V[j].x, V[i].y - V[j].y) < minEdge) {
        if (!closed && (i === 0 || j === V.length - 1)) {
          V.splice(i === 0 ? j : i, 1); // se conserva el extremo
        } else {
          V[i] = { x: (V[i].x + V[j].x) / 2, y: (V[i].y + V[j].y) / 2 };
          V.splice(j, 1);
        }
        merged = true;
        break;
      }
    }
    if (!merged) break;
  }
  return V;
}

/** Si el final del trazo vuelve a pasar por el principio, se corta ahí (quita lo que "se pasa"). */
function trimClosure(P) {
  const n = P.length;
  const s0 = P[0];
  let best = n - 1;
  let bestD = Infinity;
  for (let i = Math.floor(n * 0.6); i < n; i++) {
    const d = Math.hypot(P[i].x - s0.x, P[i].y - s0.y);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return P.slice(0, best + 1);
}

/** Error de ajuste de los puntos a un polígono (cerrado o abierto): { mean, max }. */
function polyError(R, V, closed) {
  let sum = 0;
  let max = 0;
  const m = closed ? V.length : V.length - 1;
  for (const p of R) {
    let best = Infinity;
    for (let i = 0; i < m; i++) best = Math.min(best, distToSeg(p, V[i], V[(i + 1) % V.length]));
    sum += best;
    if (best > max) max = best;
  }
  return { mean: sum / R.length, max };
}

/** Mejor elipse (alineada o girada según los ejes principales del trazo). */
function fitEllipse(R) {
  const n = R.length;
  let cx = 0, cy = 0;
  for (const p of R) {
    cx += p.x;
    cy += p.y;
  }
  cx /= n;
  cy /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of R) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    sxx += dx * dx;
    syy += dy * dy;
    sxy += dx * dy;
  }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let best = null;
  for (const th of [0, theta]) {
    const c = Math.cos(th);
    const s = Math.sin(th);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const p of R) {
      const u = (p.x - cx) * c + (p.y - cy) * s;
      const v = -(p.x - cx) * s + (p.y - cy) * c;
      if (u < minU) minU = u;
      if (u > maxU) maxU = u;
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const rx = (maxU - minU) / 2;
    const ry = (maxV - minV) / 2;
    if (rx < 0.5 || ry < 0.5) continue;
    const uc = (maxU + minU) / 2;
    const vc = (maxV + minV) / 2;
    let err = 0;
    for (const p of R) {
      const u = (p.x - cx) * c + (p.y - cy) * s - uc;
      const v = -(p.x - cx) * s + (p.y - cy) * c - vc;
      err += Math.abs(Math.hypot(u / rx, v / ry) - 1);
    }
    err /= n;
    const e = { err, cx: cx + uc * c - vc * s, cy: cy + uc * s + vc * c, rx, ry, rot: th };
    if (!best || err < best.err - 0.004) best = e;
  }
  return best;
}

function ellipsePoints(e) {
  let { rx, ry, rot } = e;
  // Casi un círculo: círculo exacto. Casi recta: sin giro.
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.12) {
    rx = ry = (rx + ry) / 2;
    rot = 0;
  }
  const r = ((rot % Math.PI) + Math.PI) % Math.PI;
  if (Math.min(r, Math.PI - r) < 6 * DEG) rot = 0;
  else if (Math.abs(r - Math.PI / 2) < 6 * DEG) {
    rot = 0;
    [rx, ry] = [ry, rx];
  }
  const n = Math.max(40, Math.min(120, Math.round((rx + ry) / 3)));
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const u = rx * Math.cos(t);
    const v = ry * Math.sin(t);
    pts.push(e.cx + u * c - v * s, e.cy + u * s + v * c);
  }
  return { type: rx === ry ? 'circle' : 'ellipse', pts, closed: true };
}

/** Polígono (casi) regular: ángulos y lados parecidos (un pentágono o un hexágono, no un corazón). */
function isRegular(V) {
  const n = V.length;
  const angles = [];
  const sides = [];
  for (let i = 0; i < n; i++) {
    angles.push(cornerAngle(V[(i - 1 + n) % n], V[i], V[(i + 1) % n]));
    sides.push(Math.hypot(V[(i + 1) % n].x - V[i].x, V[(i + 1) % n].y - V[i].y));
  }
  const ideal = 180 - 360 / n;
  const avgSide = sides.reduce((a, b) => a + b, 0) / n;
  return angles.every(a => Math.abs(a - ideal) < 18) && sides.every(l => Math.abs(l - avgSide) < 0.35 * avgSide);
}

/** Si los 4 vértices forman casi ángulos rectos, rectángulo exacto (alineado si está casi recto). */
function rectangleFrom(V) {
  for (let i = 0; i < 4; i++) {
    const ang = cornerAngle(V[(i + 3) % 4], V[i], V[(i + 1) % 4]);
    if (ang < 72 || ang > 108) return null;
  }
  // Orientación media de los lados (módulo 90°).
  let sx = 0, sy = 0;
  for (let i = 0; i < 4; i++) {
    const a = V[i];
    const b = V[(i + 1) % 4];
    const ang = Math.atan2(b.y - a.y, b.x - a.x) * 4;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    sx += Math.cos(ang) * len;
    sy += Math.sin(ang) * len;
  }
  let phi = Math.atan2(sy, sx) / 4;
  if (Math.abs(phi) < 7 * DEG) phi = 0;
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of V) {
    const u = p.x * c + p.y * s;
    const v = -p.x * s + p.y * c;
    minU = Math.min(minU, u);
    maxU = Math.max(maxU, u);
    minV = Math.min(minV, v);
    maxV = Math.max(maxV, v);
  }
  const corners = [[minU, minV], [maxU, minV], [maxU, maxV], [minU, maxV]];
  const pts = [];
  for (const [u, v] of corners) pts.push(u * c - v * s, u * s + v * c);
  return { type: 'rect', pts, closed: true };
}

/** Línea recta; si está casi horizontal o vertical, exacta. */
function lineFrom(a, b) {
  let x2 = b.x;
  let y2 = b.y;
  const ang = Math.abs(Math.atan2(b.y - a.y, b.x - a.x)) / DEG;
  if (ang < 4 || ang > 176) y2 = a.y;
  else if (Math.abs(ang - 90) < 4) x2 = a.x;
  return { type: 'line', pts: [a.x, a.y, x2, y2], closed: false };
}

/**
 * flat: [x, y, p, x, y, p, ...] en coordenadas de página.
 * minSize: tamaño mínimo (diagonal, en unidades de página) para intentar reconocer algo.
 */
export function recognizeShape(flat, { minSize = 20 } = {}) {
  const P = toPoints(flat);
  if (P.length < 3) return null;
  const bb = bbox(P);
  const diag = Math.hypot(bb.w, bb.h);
  if (diag < minSize) return null;
  const L = pathLength(P);
  const R = resample(P, 96);
  if (!R) return null;
  const first = P[0];
  const last = P[P.length - 1];
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  let closeGap = gap;
  for (let i = Math.floor(P.length * 0.6); i < P.length; i++) {
    closeGap = Math.min(closeGap, Math.hypot(P[i].x - first.x, P[i].y - first.y));
  }
  const closed = closeGap < 0.22 * diag && L > 1.4 * diag;

  if (!closed) {
    // Recta: todos los puntos cerca de la cuerda entre el principio y el final.
    let dev = 0;
    for (const p of R) dev = Math.max(dev, distToSeg(p, first, last));
    if (gap > 0.8 * diag && dev < Math.max(3, 0.07 * gap) && L < 1.25 * gap) return lineFrom(first, last);
    // Polilínea de 2 o 3 tramos rectos (p. ej. una "L" o una "V").
    const V = cleanVertices(simplify(R, Math.max(1.5, 0.05 * diag)), diag, false);
    if (V.length >= 3 && V.length <= 4) {
      const segsOk = V.every((p, i) => i === 0 || Math.hypot(p.x - V[i - 1].x, p.y - V[i - 1].y) > 0.18 * diag);
      const cornersOk = V.slice(1, -1).every((p, i) => cornerAngle(V[i], p, V[i + 2]) < 125);
      const fit = polyError(R, V, false);
      if (segsOk && cornersOk && fit.mean < 0.015 * diag && fit.max < 0.045 * diag) {
        const pts = [];
        for (const p of V) pts.push(p.x, p.y);
        return { type: 'polyline', pts, closed: false };
      }
    }
    return null;
  }

  const C = resample(trimClosure(P), 96) || R;
  const V = closedVertices(C, diag);
  const fit = V.length >= 3 ? polyError(C, V, true) : { mean: Infinity, max: Infinity };
  const ell = fitEllipse(C);
  // Error medio de la elipse en las mismas unidades que el del polígono.
  const ellDist = ell ? ell.err * (ell.rx + ell.ry) / 2 : Infinity;
  // Polígono: esquinas claras, lados rectos y claramente mejor que una elipse.
  if (V.length >= 3 && V.length <= 8 && (V.length <= 4 || isRegular(V)) && fit.mean < 0.03 * diag && fit.max < 0.085 * diag && fit.mean < 0.6 * ellDist) {
    if (V.length === 4) {
      const rect = rectangleFrom(V);
      if (rect) return rect;
    }
    const pts = [];
    for (const p of V) pts.push(p.x, p.y);
    return { type: V.length === 3 ? 'triangle' : V.length === 4 ? 'quad' : 'polygon', pts, closed: true };
  }
  if (ell && ell.err < 0.1) return ellipsePoints(ell);
  return null;
}
