// Tamaños de papel, plantillas de fondo y utilidades de color.
// Unidad de página: píxel CSS a 96 ppp (1 px = 0,75 pt en PDF).

export const PX_PER_MM = 96 / 25.4;
export const PT_PER_PX = 0.75;

const mm = v => Math.round(v * PX_PER_MM);

export const PAPER_SIZES = {
  a4: { name: 'A4', w: mm(210), h: mm(297) },
  a5: { name: 'A5', w: mm(148), h: mm(210) },
  a3: { name: 'A3', w: mm(297), h: mm(420) },
  a6: { name: 'A6', w: mm(105), h: mm(148) },
  letter: { name: 'Carta', w: 816, h: 1056 },
  legal: { name: 'Oficio', w: 816, h: 1344 },
  square: { name: 'Cuadrado', w: mm(210), h: mm(210) },
  infinite: { name: 'Pizarra infinita', w: 1800, h: 1400 }
};

export const TEMPLATES = [
  { id: 'blank', name: 'Liso' },
  { id: 'lines', name: 'Rayado' },
  { id: 'grid', name: 'Cuadrícula' },
  { id: 'dots', name: 'Puntos' },
  { id: 'cornell', name: 'Cornell' }
];

export const PAPER_COLORS = [
  { id: '#ffffff', name: 'Blanco' },
  { id: '#fdf6e2', name: 'Crema' },
  { id: '#fef9c3', name: 'Amarillo' },
  { id: '#eef2f7', name: 'Gris' },
  { id: '#e8f4ea', name: 'Verde' },
  { id: '#1e293b', name: 'Pizarra' },
  { id: '#111111', name: 'Negro' }
];

export const DEFAULT_PAPER = Object.freeze({
  size: 'a4',
  orientation: 'portrait',
  template: 'grid',
  color: '#fdf6e2',
  spacing: 28
});

export function pageSizeFor(sizeKey, orientation) {
  const p = PAPER_SIZES[sizeKey] || PAPER_SIZES.a4;
  if (sizeKey === 'infinite') return { w: p.w, h: p.h };
  return orientation === 'landscape' ? { w: p.h, h: p.w } : { w: p.w, h: p.h };
}

export function normalizeBg(bg) {
  const b = bg || {};
  const template = TEMPLATES.some(t => t.id === b.template) ? b.template : 'blank';
  const color = /^#[0-9a-f]{6}$/i.test(b.color || '') ? b.color.toLowerCase() : '#ffffff';
  const spacing = Number.isFinite(b.spacing) ? Math.min(80, Math.max(4, Math.round(b.spacing * 10) / 10)) : 28;
  return { template, color, spacing };
}

export function hexToRgb(hex) {
  let c = String(hex || '#000000').replace('#', '');
  if (c.length === 3) c = c.split('').map(x => x + x).join('');
  const n = parseInt(c, 16);
  if (!Number.isFinite(n)) return { r: 0, g: 0, b: 0 };
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex(r, g, b) {
  const f = v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

export function isDarkColor(hex) {
  const { r, g, b } = hexToRgb(hex);
  return r * 0.299 + g * 0.587 + b * 0.114 < 140;
}

/** Colores de las líneas de la plantilla según el color del papel. */
export function templateInk(bgColor) {
  const dark = isDarkColor(bgColor);
  return {
    line: dark ? 'rgba(255,255,255,0.20)' : 'rgba(30,41,59,0.16)',
    lineStrong: dark ? 'rgba(255,255,255,0.32)' : 'rgba(30,41,59,0.26)',
    margin: dark ? 'rgba(248,113,113,0.45)' : 'rgba(220,38,38,0.35)',
    dot: dark ? 'rgba(255,255,255,0.35)' : 'rgba(30,41,59,0.30)',
    lineRgb: dark ? [1, 1, 1] : [0.118, 0.161, 0.231],
    lineAlpha: dark ? 0.2 : 0.16,
    marginRgb: dark ? [0.973, 0.443, 0.443] : [0.863, 0.149, 0.149],
    marginAlpha: dark ? 0.45 : 0.35,
    dotAlpha: dark ? 0.35 : 0.3
  };
}

/**
 * Primitivas geométricas de una plantilla sobre un rectángulo (x, y, w, h).
 * Devuelve { lines: [[x1,y1,x2,y2,kind]], dots: [[x,y]] } con kind 'line' | 'strong' | 'margin'.
 */
export function templatePrimitives(template, spacing, rect) {
  const { x, y, w, h } = rect;
  const s = Math.max(8, spacing || 28);
  const lines = [];
  const dots = [];
  if (template === 'grid') {
    for (let gx = x + s; gx < x + w - 0.5; gx += s) lines.push([gx, y, gx, y + h, 'line']);
    for (let gy = y + s; gy < y + h - 0.5; gy += s) lines.push([x, gy, x + w, gy, 'line']);
  } else if (template === 'lines') {
    const top = y + Math.max(s * 2, 56);
    for (let gy = top; gy < y + h - s * 0.5; gy += s) lines.push([x, gy, x + w, gy, 'line']);
  } else if (template === 'dots') {
    for (let gx = x + s; gx < x + w - 0.5; gx += s) {
      for (let gy = y + s; gy < y + h - 0.5; gy += s) dots.push([gx, gy]);
    }
  } else if (template === 'cornell') {
    const header = Math.max(s * 3, 90);
    const cue = Math.round(w * 0.28);
    const summary = Math.round(h * 0.2);
    for (let gy = y + header + s; gy < y + h - summary - s * 0.5; gy += s) lines.push([x + cue, gy, x + w, gy, 'line']);
    lines.push([x, y + header, x + w, y + header, 'strong']);
    lines.push([x + cue, y + header, x + cue, y + h - summary, 'margin']);
    lines.push([x, y + h - summary, x + w, y + h - summary, 'strong']);
  }
  return { lines, dots };
}

/** Dibuja el fondo (color + plantilla) en un contexto 2D, en coordenadas de página. */
export function drawPaper(ctx, bg, rect, clip) {
  const b = normalizeBg(bg);
  const ink = templateInk(b.color);
  ctx.save();
  ctx.fillStyle = b.color;
  const area = clip || rect;
  ctx.fillRect(area.x, area.y, area.w, area.h);
  const prim = templatePrimitives(b.template, b.spacing, rect);
  const lw = Math.max(0.6, 1 / Math.max(0.0001, Math.abs(ctx.getTransform ? ctx.getTransform().a : 1)));
  const byKind = { line: ink.line, strong: ink.lineStrong, margin: ink.margin };
  for (const kind of ['line', 'strong', 'margin']) {
    const subset = prim.lines.filter(l => l[4] === kind);
    if (!subset.length) continue;
    ctx.beginPath();
    for (const [x1, y1, x2, y2] of subset) {
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
    }
    ctx.strokeStyle = byKind[kind];
    ctx.lineWidth = kind === 'line' ? Math.max(lw, 1) : Math.max(lw * 1.5, 1.5);
    ctx.stroke();
  }
  if (prim.dots.length) {
    ctx.fillStyle = ink.dot;
    const r = 1.4;
    ctx.beginPath();
    for (const [dx, dy] of prim.dots) {
      if (clip && (dx < clip.x - 2 || dx > clip.x + clip.w + 2 || dy < clip.y - 2 || dy > clip.y + clip.h + 2)) continue;
      ctx.moveTo(dx + r, dy);
      ctx.arc(dx, dy, r, 0, Math.PI * 2);
    }
    ctx.fill();
  }
  ctx.restore();
}

const svgCache = new Map();

/** SVG de página completa para usar como fondo CSS (nítido a cualquier zoom). */
export function paperSvgDataUri(bg, w, h) {
  const b = normalizeBg(bg);
  const key = `${b.template}|${b.color}|${b.spacing}|${Math.round(w)}|${Math.round(h)}`;
  const cached = svgCache.get(key);
  if (cached) return cached;
  const ink = templateInk(b.color);
  const s = b.spacing;
  let body = '';
  // Los patrones se desplazan medio paso para que líneas y puntos queden en el centro de cada
  // tesela (si no, el recorte de la tesela los parte) y caigan en múltiplos exactos del espaciado.
  const half = s / 2;
  if (b.template === 'grid') {
    body = `<defs><pattern id="p" x="${half}" y="${half}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"><path d="M ${half} 0 V ${s} M 0 ${half} H ${s}" fill="none" stroke="${ink.line}" stroke-width="1"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/>`;
  } else if (b.template === 'dots') {
    // El rectángulo recortado evita medios puntos en los bordes derecho e inferior.
    body = `<defs><pattern id="p" x="${half}" y="${half}" width="${s}" height="${s}" patternUnits="userSpaceOnUse"><circle cx="${half}" cy="${half}" r="1.4" fill="${ink.dot}"/></pattern></defs><rect width="${Math.max(0, w - half)}" height="${Math.max(0, h - half)}" fill="url(#p)"/>`;
  } else if (b.template === 'lines' || b.template === 'cornell') {
    const prim = templatePrimitives(b.template, s, { x: 0, y: 0, w, h });
    const paths = { line: '', strong: '', margin: '' };
    for (const [x1, y1, x2, y2, kind] of prim.lines) {
      paths[kind] += `M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}`;
    }
    if (paths.line) body += `<path d="${paths.line}" stroke="${ink.line}" stroke-width="1" fill="none"/>`;
    if (paths.strong) body += `<path d="${paths.strong}" stroke="${ink.lineStrong}" stroke-width="1.5" fill="none"/>`;
    if (paths.margin) body += `<path d="${paths.margin}" stroke="${ink.margin}" stroke-width="1.5" fill="none"/>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(w)}" height="${Math.round(h)}" viewBox="0 0 ${Math.round(w)} ${Math.round(h)}" preserveAspectRatio="none">${body}</svg>`;
  const uri = `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;
  if (svgCache.size > 60) svgCache.clear();
  svgCache.set(key, uri);
  return uri;
}
