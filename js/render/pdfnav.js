// Navegación de los PDF: índice (el que trae el propio PDF) y enlaces de sus páginas.
// Se calcula bajo demanda con pdf.js y se guarda solo en memoria (es rápido de obtener).

import { acquirePdf, releasePdf } from './pdf.js';

const outlineCache = new Map(); // blobId -> Promise<entradas[]>
const linkCache = new Map(); // "blob|índice|rotación" -> Promise<{ baseW, baseH, links }>
const MAX_OUTLINE_ITEMS = 3000;

/** Solo se abren enlaces web o de correo (nunca javascript:, file:, etc.). */
export function safeUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const u = new URL(url);
    return ['http:', 'https:', 'mailto:'].includes(u.protocol) ? u.href : null;
  } catch {
    return null;
  }
}

function cleanTitle(t) {
  const s = String(t || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > 300 ? `${s.slice(0, 300)}…` : s || 'Sin título';
}

function normRot(page, rotation) {
  return ((((page.rotate || 0) + (rotation || 0)) % 360) + 360) % 360;
}

/**
 * Traduce un destino de pdf.js a { pageIndex, left, top } (left/top en unidades del PDF; pueden ser null).
 * Admite destinos con nombre y explícitos.
 */
async function resolveDest(doc, dest) {
  try {
    let explicit = dest;
    if (typeof dest === 'string') explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || !explicit.length) return null;
    const ref = explicit[0];
    let pageIndex = null;
    if (ref && typeof ref === 'object') pageIndex = await doc.getPageIndex(ref);
    else if (Number.isInteger(ref)) pageIndex = ref;
    if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= doc.numPages) return null;
    const kind = explicit[1] && explicit[1].name;
    let left = null;
    let top = null;
    if (kind === 'XYZ') {
      left = explicit[2];
      top = explicit[3];
    } else if (kind === 'FitH' || kind === 'FitBH') {
      top = explicit[2];
    } else if (kind === 'FitV' || kind === 'FitBV') {
      left = explicit[2];
    } else if (kind === 'FitR') {
      left = explicit[2];
      top = explicit[5];
    }
    return { pageIndex, left: Number.isFinite(left) ? left : null, top: Number.isFinite(top) ? top : null };
  } catch {
    return null;
  }
}

/** Índice del PDF: [{ title, bold, italic, depth, dest, url, items }]. Vacío si no tiene. */
export function getOutline(blobId) {
  if (outlineCache.has(blobId)) return outlineCache.get(blobId);
  const p = (async () => {
    const doc = await acquirePdf(blobId);
    try {
      const raw = await doc.getOutline();
      if (!raw || !raw.length) return [];
      let count = 0;
      const convert = async (items, depth) => {
        const slice = [];
        for (const it of items) {
          if (count >= MAX_OUTLINE_ITEMS) break;
          count++;
          slice.push(it);
        }
        return Promise.all(slice.map(async it => ({
          title: cleanTitle(it.title),
          bold: !!it.bold,
          italic: !!it.italic,
          depth,
          dest: it.dest ? await resolveDest(doc, it.dest) : null,
          url: safeUrl(it.url || it.unsafeUrl),
          items: it.items && it.items.length ? await convert(it.items, depth + 1) : []
        })));
      };
      return await convert(raw, 0);
    } finally {
      releasePdf(blobId);
    }
  })();
  outlineCache.set(blobId, p);
  p.catch(() => outlineCache.delete(blobId));
  return p;
}

/**
 * Enlaces de una página del PDF en coordenadas del "viewport base" (puntos con la rotación aplicada):
 * { baseW, baseH, links: [{ x, y, w, h, dest, url, named }] }.
 */
export function getPageLinks(blobId, index, rotation = 0) {
  const key = `${blobId}|${index}|${rotation}`;
  if (linkCache.has(key)) {
    const hit = linkCache.get(key);
    linkCache.delete(key);
    linkCache.set(key, hit);
    return hit;
  }
  const p = (async () => {
    const doc = await acquirePdf(blobId);
    try {
      const page = await doc.getPage(index + 1);
      const vp = page.getViewport({ scale: 1, rotation: normRot(page, rotation) });
      const annots = await page.getAnnotations({ intent: 'display' });
      const links = [];
      for (const a of annots || []) {
        if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
        const url = safeUrl(a.url || a.unsafeUrl);
        const dest = !url && a.dest ? await resolveDest(doc, a.dest) : null;
        const named = !url && !dest && ['NextPage', 'PrevPage', 'FirstPage', 'LastPage'].includes(a.action) ? a.action : null;
        if (!url && !dest && !named) continue;
        const [x1, y1] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
        const [x2, y2] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
        links.push({ x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1), dest, url, named });
      }
      return { baseW: vp.width, baseH: vp.height, links };
    } finally {
      releasePdf(blobId);
    }
  })();
  linkCache.set(key, p);
  p.catch(() => linkCache.delete(key));
  while (linkCache.size > 60) linkCache.delete(linkCache.keys().next().value);
  return p;
}

/**
 * Punto de un destino (unidades PDF) convertido al viewport base de su página:
 * { x, y, baseW, baseH } (x/y null si el destino no los indica).
 */
export async function destPoint(blobId, dest, rotation = 0) {
  const doc = await acquirePdf(blobId);
  try {
    const page = await doc.getPage(dest.pageIndex + 1);
    const vp = page.getViewport({ scale: 1, rotation: normRot(page, rotation) });
    const l = dest.left ?? 0;
    const t = dest.top ?? 0;
    const [x, y] = vp.convertToViewportPoint(l, t);
    // Con la página girada, la "y" de pantalla depende de la coordenada horizontal del PDF (y viceversa).
    const [, yIfTop] = vp.convertToViewportPoint(l, t + 1);
    const yFromTop = Math.abs(yIfTop - y) > 0.5;
    const yKnown = yFromTop ? dest.top !== null : dest.left !== null;
    const xKnown = yFromTop ? dest.left !== null : dest.top !== null;
    return { x: xKnown ? x : null, y: yKnown ? y : null, baseW: vp.width, baseH: vp.height };
  } finally {
    releasePdf(blobId);
  }
}
