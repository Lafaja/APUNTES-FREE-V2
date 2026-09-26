// Migración desde la versión anterior (Tablet Studio v1: IndexedDB "TabletStudioAppDB" + localStorage)
// y desde sus copias de seguridad .json.
//
// GARANTÍAS:
//  - Solo LEE la base de datos antigua; nunca la modifica ni la borra.
//  - Es repetible: lo que ya se migró (mismo id) se omite.
//  - Los trazos antiguos conservan su aspecto exacto (se dibujan con el motor anterior: marca "lg").

import * as repo from './repo.js';
import { uid, base64ToBytes, cleanName, isPdfBytes } from './util.js';
import { normalizeBg } from '../model/paper.js';
import { settings } from './settings.js';

const LEGACY_DB = 'TabletStudioAppDB';
const PX_PER_PT = 4 / 3;

// Tamaños de papel de la versión anterior (en sus píxeles).
const OLD_PAPER = {
  a0: [3178, 4494], a1: [2245, 3178], a2: [1587, 2245], a3: [1122, 1587], a4: [840, 1188], a5: [595, 840],
  letter: [816, 1056], legal: [816, 1344], infinite: [2500, 2500]
};

// ---------------------------------------------------------------------------
// Lectura de la base de datos antigua (solo lectura)
// ---------------------------------------------------------------------------

async function legacyDbExists() {
  if (typeof indexedDB.databases === 'function') {
    try {
      const list = await indexedDB.databases();
      return list.some(d => d.name === LEGACY_DB);
    } catch {
      // Si falla, se intenta abrir directamente.
    }
  }
  return null; // desconocido
}

function openLegacyDb() {
  return new Promise(resolve => {
    let req;
    try {
      req = indexedDB.open(LEGACY_DB);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      // No existía: cancelar para NO crear una base vacía con ese nombre.
      try { req.transaction.abort(); } catch {}
    };
    req.onsuccess = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('items') && !d.objectStoreNames.contains('folders')) {
        d.close();
        resolve(null);
        return;
      }
      resolve(d);
    };
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function idbReq(store, method, arg) {
  return new Promise((resolve, reject) => {
    const r = arg === undefined ? store[method]() : store[method](arg);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function readLegacyDb() {
  const exists = await legacyDbExists();
  if (exists === false) return null;
  const d = await openLegacyDb();
  if (!d) return null;
  const has = n => d.objectStoreNames.contains(n);
  const folders = has('folders') ? await idbReq(d.transaction('folders').objectStore('folders'), 'getAll') : [];
  const itemKeys = has('items') ? await idbReq(d.transaction('items').objectStore('items'), 'getAllKeys') : [];
  return {
    db: d,
    folders: folders || [],
    itemKeys: itemKeys || [],
    getItem: key => idbReq(d.transaction('items').objectStore('items'), 'get', key),
    close: () => d.close()
  };
}

function readLegacyLocalStorage() {
  const read = key => {
    try {
      const raw = localStorage.getItem(key);
      const v = raw ? JSON.parse(raw) : null;
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  };
  return { folders: read('tablet_folders'), items: read('tablet_items') };
}

function itemKind(it) {
  if (!it || typeof it !== 'object') return null;
  if (it.type === 'split_session') return 'split';
  if (it.type === 'pdf' || it.pdfData) return 'pdf';
  if (it.type === 'note' || it.type === 'notebook' || Array.isArray(it.strokes)) return 'note';
  return null;
}

/** Resumen de lo que hay para migrar (sin cambiar nada). */
export async function detectLegacyData() {
  const out = { folders: 0, notes: 0, pdfs: 0, splits: 0, total: 0, sources: [] };
  const seen = new Set();
  const existing = new Set((await repo.loadAllNodes()).map(n => n.id));
  const legacy = await readLegacyDb();
  if (legacy) {
    out.sources.push('indexeddb');
    for (const f of legacy.folders) {
      if (f && f.id && !seen.has(f.id)) {
        seen.add(f.id);
        if (!existing.has(f.id)) out.folders++;
      }
    }
    for (const key of legacy.itemKeys) {
      if (seen.has(key)) continue;
      seen.add(key);
      if (existing.has(key)) continue;
      try {
        const it = await legacy.getItem(key);
        const k = itemKind(it);
        if (k === 'note') out.notes++;
        else if (k === 'pdf') out.pdfs++;
        else if (k === 'split') out.splits++;
      } catch {}
    }
    legacy.close();
  }
  const ls = readLegacyLocalStorage();
  if (ls.folders.length || ls.items.length) out.sources.push('localstorage');
  for (const f of ls.folders) {
    if (f && f.id && !seen.has(f.id)) {
      seen.add(f.id);
      if (!existing.has(f.id)) out.folders++;
    }
  }
  for (const it of ls.items) {
    if (!it || !it.id || seen.has(it.id)) continue;
    seen.add(it.id);
    if (existing.has(it.id)) continue;
    const k = itemKind(it);
    if (k === 'note') out.notes++;
    else if (k === 'pdf') out.pdfs++;
    else if (k === 'split') out.splits++;
  }
  out.total = out.folders + out.notes + out.pdfs;
  return out;
}

// ---------------------------------------------------------------------------
// Conversión de trazos
// ---------------------------------------------------------------------------

function flatPoints(points, tx) {
  const out = [];
  for (const p of points || []) {
    if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) continue;
    const [x, y] = tx ? tx(p.x, p.y) : [p.x, p.y];
    out.push(x, y, Number.isFinite(p.pressure) && p.pressure > 0 ? Math.min(1, p.pressure) : 0.5);
  }
  return out;
}

const OLD_CLOSED = new Set(['rectangle', 'circle', 'triangle', 'star', 'hexagon']);

/** Convierte un trazo antiguo (sin imágenes). Devuelve null si no se puede dibujar. */
function convertStroke(s, tx = null, sizeScale = 1) {
  if (!s || s.isImage) return null;
  if (s.tool === 'eraser') return null;
  let pts = flatPoints(s.points, tx);
  if (pts.length < 3) return null;
  const color = typeof s.color === 'string' ? s.color : '#000000';
  if (s.isFill) {
    return { id: uid('s'), t: 'shape', c: s.fillColor || color, w: 1, pts: Float32Array.from(pts), sh: 'polygon', closed: 1, fill: 'solid', fc: s.fillColor || color, ns: 1, a: Number.isFinite(s.fillOpacity) ? s.fillOpacity : 1 };
  }
  if (s.isShape) {
    const closed = OLD_CLOSED.has(s.shapeType);
    if (closed && pts.length >= 6) {
      const n = pts.length;
      if (Math.abs(pts[0] - pts[n - 3]) < 0.01 && Math.abs(pts[1] - pts[n - 2]) < 0.01) pts = pts.slice(0, n - 3);
    }
    const out = { id: uid('s'), t: 'shape', c: color, w: Math.max(0.3, (s.size || 3) * sizeScale), pts: Float32Array.from(pts), sh: 'polyline' };
    if (closed) out.closed = 1;
    if (closed && (s.fillMode === 'semi' || s.fillMode === 'solid')) {
      out.fill = s.fillMode;
      out.fc = s.fillColor || color;
    }
    return out;
  }
  const brush = s.brushType || s.tool;
  let t = 'pen';
  if (brush === 'highlighter' || s.tool === 'highlighter') t = 'highlighter';
  else if (brush === 'pencil') t = 'pencil';
  else if (brush === 'fountain') t = 'fountain';
  return { id: uid('s'), t, c: color, w: Math.max(0.3, (Number.isFinite(s.size) ? s.size : 3) * sizeScale), pts: Float32Array.from(pts), np: 1, lg: 1 };
}

/** Parte un trazo en los tramos que caen en cada página (páginas apiladas de altura pageH). */
function splitByPages(stroke, pageH, pageCount) {
  const p = stroke.pts;
  const n = p.length / 3;
  const pageOf = y => Math.max(0, Math.min(pageCount - 1, Math.floor(y / pageH)));
  if (stroke.t === 'shape') {
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < p.length; i += 3) {
      minY = Math.min(minY, p[i]);
      maxY = Math.max(maxY, p[i]);
    }
    const pi = pageOf((minY + maxY) / 2);
    const out = new Float32Array(p);
    for (let i = 1; i < out.length; i += 3) out[i] -= pi * pageH;
    return [{ page: pi, stroke: { ...stroke, pts: out } }];
  }
  const parts = [];
  let cur = [];
  let curPage = pageOf(p[1]);
  const push = () => {
    if (cur.length >= 3) {
      const arr = Float32Array.from(cur);
      for (let i = 1; i < arr.length; i += 3) arr[i] -= curPage * pageH;
      parts.push({ page: curPage, stroke: { ...stroke, id: parts.length ? uid('s') : stroke.id, pts: arr } });
    }
  };
  for (let i = 0; i < n; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], pr = p[i * 3 + 2];
    const pg = pageOf(y);
    if (i > 0 && pg !== curPage) {
      // Punto de corte interpolado en el borde de la página.
      const px = p[(i - 1) * 3], py = p[(i - 1) * 3 + 1];
      const boundary = (pg > curPage ? curPage + 1 : curPage) * pageH;
      const t = (boundary - py) / ((y - py) || 1e-9);
      const bx = px + (x - px) * Math.max(0, Math.min(1, t));
      cur.push(bx, boundary, pr);
      push();
      cur = [bx, boundary, pr];
      curPage = pg;
    }
    cur.push(x, y, pr);
  }
  push();
  return parts;
}

// ---------------------------------------------------------------------------
// Imágenes
// ---------------------------------------------------------------------------

async function imageToBlob(img) {
  const src = img && (img.src || img.dataUrl);
  if (!src || typeof src !== 'string' || !src.startsWith('data:')) return null;
  const m = /^data:([^;,]+)/.exec(src);
  const bytes = base64ToBytes(src);
  if (!bytes || !bytes.length) return null;
  return repo.putBlob(bytes, (m && m[1]) || 'image/png');
}

async function convertImage(img, tx = null, scale = 1) {
  const blobId = await imageToBlob(img);
  if (!blobId) return null;
  let x = Number.isFinite(img.x) ? img.x : img.points && img.points[0] ? img.points[0].x : 0;
  let y = Number.isFinite(img.y) ? img.y : img.points && img.points[0] ? img.points[0].y : 0;
  if (tx) [x, y] = tx(x, y);
  const w = (Number.isFinite(img.width) ? img.width : 200) * scale;
  const hh = (Number.isFinite(img.height) ? img.height : 150) * scale;
  return { id: uid('i'), blobId, x, y, w, h: hh, rot: 0 };
}

// ---------------------------------------------------------------------------
// Conversión de documentos
// ---------------------------------------------------------------------------

async function convertNote(it, report) {
  const now = Date.now();
  const sizeKey = OLD_PAPER[it.paperSize] ? it.paperSize : 'a4';
  const infinite = it.noteMode === 'infinite' || it.paperSize === 'infinite';
  let [pw, ph] = OLD_PAPER[sizeKey];
  if (it.orientation === 'landscape' && !infinite) [pw, ph] = [ph, pw];
  const width = Number.isFinite(it.canvasWidth) && it.canvasWidth > 50 ? it.canvasWidth : pw;
  const pageH = Number.isFinite(it.pageHeight) && it.pageHeight > 50 ? it.pageHeight : ph;
  const canvasH = Number.isFinite(it.canvasHeight) && it.canvasHeight > 50 ? it.canvasHeight : pageH;
  const bg = normalizeBg({
    template: ['grid', 'lines', 'dots', 'blank'].includes(it.patternType) ? it.patternType : 'grid',
    color: /^#[0-9a-f]{6}$/i.test(it.bgColor || '') ? it.bgColor : '#fdf6e2',
    spacing: Number.isFinite(it.gridSize) ? it.gridSize : 28
  });
  const strokes = [];
  for (const s of it.strokes || []) {
    const c = convertStroke(s);
    if (c) strokes.push(c);
    else if (s && !s.isImage && s.tool !== 'eraser') report.skippedStrokes++;
  }
  const oldImages = [...(it.images || []), ...(it.strokes || []).filter(s => s && s.isImage)];
  const images = [];
  const seenImg = new Set();
  for (const im of oldImages) {
    if (im.id && seenImg.has(im.id)) continue;
    if (im.id) seenImg.add(im.id);
    try {
      const c = await convertImage(im);
      if (c) images.push(c);
      else report.skippedImages++;
    } catch {
      report.skippedImages++;
    }
  }

  let pages;
  if (infinite) {
    let maxX = width, maxY = canvasH;
    for (const s of strokes) for (let i = 0; i < s.pts.length; i += 3) {
      maxX = Math.max(maxX, s.pts[i] + 40);
      maxY = Math.max(maxY, s.pts[i + 1] + 40);
    }
    pages = [{ id: uid('p'), w: Math.ceil(maxX), h: Math.ceil(maxY), bg, pdf: null, strokes, images }];
  } else {
    let maxY = 0;
    for (const s of strokes) for (let i = 1; i < s.pts.length; i += 3) maxY = Math.max(maxY, s.pts[i]);
    for (const im of images) maxY = Math.max(maxY, im.y + im.h / 2);
    const originalPages = Math.max(1, Math.ceil(canvasH / pageH));
    const lastContent = strokes.length || images.length ? Math.floor(maxY / pageH) : 0;
    // Se conservan las páginas con contenido y una en blanco más si existía (las vacías del final sobraban).
    const count = Math.max(1, Math.max(lastContent + 1, Math.min(originalPages, lastContent + 2)));
    pages = [];
    for (let i = 0; i < count; i++) pages.push({ id: uid('p'), w: width, h: pageH, bg, pdf: null, strokes: [], images: [] });
    for (const s of strokes) {
      for (const part of splitByPages(s, pageH, count)) pages[part.page].strokes.push(part.stroke);
    }
    for (const im of images) {
      const pi = Math.max(0, Math.min(count - 1, Math.floor((im.y + im.h / 2) / pageH)));
      pages[pi].images.push({ ...im, y: im.y - pi * pageH });
    }
  }
  const docId = it.id;
  const pageRecords = pages.map(p => ({ ...p, docId, rev: 1, updatedAt: it.updatedAt || now }));
  const node = {
    id: docId,
    kind: 'doc',
    source: 'note',
    name: cleanName(it.name || it.title),
    parentId: it.parentId || null,
    createdAt: it.createdAt || now,
    updatedAt: it.updatedAt || now,
    openedAt: 0,
    deletedAt: 0,
    trashedFrom: null,
    paper: { size: infinite ? 'infinite' : sizeKey, orientation: it.orientation || 'portrait', template: bg.template, color: bg.color, spacing: bg.spacing },
    pdf: null,
    autoAddPages: !infinite,
    pages: pageRecords.map(p => ({ id: p.id, w: p.w, h: p.h })),
    view: null,
    rev: 1,
    thumbRev: 0,
    migratedFrom: 'v1'
  };
  report.strokes += strokes.length;
  report.images += images.length;
  return { node, pages: pageRecords };
}

function legacyPdfBytes(pdfData) {
  if (!pdfData) return null;
  const cands = [pdfData.arrayBuffer, pdfData.data, pdfData.bytes, pdfData.buffer];
  for (const c of cands) {
    if (c instanceof ArrayBuffer && c.byteLength) return new Uint8Array(c);
    if (ArrayBuffer.isView(c) && c.byteLength) return new Uint8Array(c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength));
  }
  if (typeof pdfData.base64 === 'string' && pdfData.base64.length > 20) return base64ToBytes(pdfData.base64);
  if (typeof pdfData.data === 'string') return base64ToBytes(pdfData.data);
  return null;
}

async function convertPdf(it, report) {
  const { openPdfBytes, pdfPageSizes, closePdf } = await import('../render/pdf.js');
  const now = Date.now();
  const pd = it.pdfData || {};
  const bytes = legacyPdfBytes(pd);
  if (!bytes || !isPdfBytes(bytes)) {
    report.warnings.push(`«${it.name || it.title || 'PDF'}»: el PDF original no estaba guardado en la versión anterior; no se pudo migrar.`);
    return null;
  }
  const rotation = [0, 90, 180, 270].includes(pd.rotation) ? pd.rotation : 0;
  const doc = await openPdfBytes(new Uint8Array(bytes));
  let sizes;
  try {
    sizes = await pdfPageSizes(doc, rotation);
  } finally {
    closePdf(doc);
  }
  const blobId = await repo.putBlob(bytes, 'application/pdf');
  const side = pd.sideCanvas || {};
  const pos = ['left', 'right', 'both'].includes(side.position) ? side.position : 'none';
  const sideW = pos !== 'none' ? (Number.isFinite(side.width) ? side.width : 350) : 0;
  const leftPt = pos === 'left' || pos === 'both' ? sideW : 0;
  const rightPt = pos === 'right' || pos === 'both' ? sideW : 0;
  // Escala con la que la versión anterior guardaba las anotaciones (píxeles de pantalla por punto PDF).
  const firstW = sizes[0] ? sizes[0].w : 595;
  const S = Math.max(0.7, Math.min(1.8, 900 / Math.max(firstW, leftPt + firstW + rightPt)));
  const k = PX_PER_PT / S;
  const tx = (x, y) => [x * k, y * k];
  const bg = normalizeBg({ template: pos === 'none' ? 'blank' : ['grid', 'lines', 'dots', 'blank'].includes(side.pattern) ? side.pattern : 'grid', color: /^#[0-9a-f]{6}$/i.test(side.bgColor || '') ? side.bgColor : '#ffffff', spacing: (Number.isFinite(side.gridSize) ? side.gridSize : 28) * PX_PER_PT });
  const ann = pd.annotations || {};
  const docId = it.id;
  const pages = [];
  for (let i = 0; i < sizes.length; i++) {
    const pw = Math.round(sizes[i].w * PX_PER_PT * 100) / 100;
    const ph = Math.round(sizes[i].h * PX_PER_PT * 100) / 100;
    const left = leftPt * PX_PER_PT;
    const right = rightPt * PX_PER_PT;
    const list = ann[i + 1] || ann[String(i + 1)] || [];
    const strokes = [];
    const images = [];
    for (const s of list) {
      if (s && s.isImage) {
        try {
          const im = await convertImage(s, tx, k);
          if (im) images.push(im);
          else report.skippedImages++;
        } catch {
          report.skippedImages++;
        }
        continue;
      }
      const c = convertStroke(s, tx, k);
      if (c) strokes.push(c);
    }
    report.strokes += strokes.length;
    report.images += images.length;
    pages.push({
      id: uid('p'),
      docId,
      w: left + pw + right,
      h: ph,
      bg,
      pdf: { blobId, index: i, rotation, x: left, y: 0, w: pw, h: ph },
      strokes,
      images,
      rev: 1,
      updatedAt: it.updatedAt || now
    });
  }
  const node = {
    id: docId,
    kind: 'doc',
    source: 'pdf',
    name: cleanName(it.name || it.title, 'Documento PDF'),
    parentId: it.parentId || null,
    createdAt: it.createdAt || now,
    updatedAt: it.updatedAt || now,
    openedAt: 0,
    deletedAt: 0,
    trashedFrom: null,
    paper: { size: 'a4', orientation: 'portrait', template: bg.template === 'blank' ? 'grid' : bg.template, color: bg.color, spacing: 28 },
    pdf: { blobId, fileName: pd.fileName || `${it.name || 'documento'}.pdf`, pageCount: sizes.length },
    autoAddPages: false,
    pages: pages.map(p => ({ id: p.id, w: p.w, h: p.h })),
    view: null,
    rev: 1,
    thumbRev: 0,
    migratedFrom: 'v1'
  };
  return { node, pages };
}

// ---------------------------------------------------------------------------
// Migración
// ---------------------------------------------------------------------------

function newReport() {
  return { folders: 0, notes: 0, pdfs: 0, pages: 0, strokes: 0, images: 0, skipped: 0, skippedStrokes: 0, skippedImages: 0, splits: 0, warnings: [], errors: [] };
}

/**
 * Importa carpetas y documentos antiguos (de la base de datos, del localStorage o de una copia .json).
 * `ctx.processed` evita contar dos veces lo que aparece en varias fuentes; si una copia falla,
 * se intenta con la de otra fuente y el error solo se informa si ninguna funciona.
 */
async function importLegacySet({ folders, items, getItem = null, itemKeys = null }, report, onProgress, ctx = { processed: new Set(), preexisting: null, errorsById: new Map() }) {
  const existing = new Set((await repo.loadAllNodes()).map(n => n.id));
  if (!ctx.preexisting) ctx.preexisting = new Set(existing);
  const folderIds = new Set(folders.filter(f => f && f.id).map(f => f.id));
  // Carpetas
  for (const f of folders) {
    if (!f || !f.id) continue;
    if (existing.has(f.id)) {
      if (ctx.preexisting.has(f.id) && !ctx.processed.has(f.id)) report.skipped++;
      ctx.processed.add(f.id);
      continue;
    }
    const now = Date.now();
    await repo.putNode({
      id: f.id,
      kind: 'folder',
      name: cleanName(f.name, 'Carpeta'),
      color: /^#[0-9a-f]{6}$/i.test(f.color || '') ? f.color : '#3b82f6',
      parentId: f.parentId && folderIds.has(f.parentId) ? f.parentId : f.parentId && existing.has(f.parentId) ? f.parentId : null,
      createdAt: f.createdAt || now,
      updatedAt: f.updatedAt || f.createdAt || now,
      deletedAt: 0,
      trashedFrom: null,
      migratedFrom: 'v1'
    }, { durability: 'strict' });
    existing.add(f.id);
    ctx.processed.add(f.id);
    report.folders++;
  }
  // Documentos (de uno en uno para no cargar todos los PDF en memoria a la vez)
  const keys = itemKeys || items.map(it => it && it.id).filter(Boolean);
  let i = 0;
  for (const key of keys) {
    i++;
    if (onProgress) onProgress(i, keys.length);
    if (ctx.processed.has(key)) continue; // ya tratado en esta migración (desde otra fuente)
    if (existing.has(key)) {
      if (ctx.preexisting.has(key)) report.skipped++;
      ctx.processed.add(key);
      continue;
    }
    let it;
    try {
      it = getItem ? await getItem(key) : items.find(x => x && x.id === key);
    } catch (err) {
      ctx.errorsById.set(key, `No se pudo leer un elemento: ${err.message}`);
      continue;
    }
    const kind = itemKind(it);
    if (!kind) continue;
    if (kind === 'split') {
      report.splits++;
      ctx.processed.add(key);
      continue;
    }
    try {
      const warningsBefore = report.warnings.length;
      const conv = kind === 'pdf' ? await convertPdf(it, report) : await convertNote(it, report);
      if (!conv) {
        // Sin datos recuperables en esta copia: se deja la advertencia por si la otra fuente tampoco sirve.
        const w = report.warnings.splice(warningsBefore);
        if (w.length) ctx.errorsById.set(key, w.join(' '));
        continue;
      }
      if (conv.node.parentId && !existing.has(conv.node.parentId)) conv.node.parentId = null;
      await repo.putDocumentRaw(conv.node, conv.pages);
      existing.add(conv.node.id);
      ctx.processed.add(key);
      ctx.errorsById.delete(key);
      report.pages += conv.pages.length;
      if (kind === 'pdf') report.pdfs++;
      else report.notes++;
    } catch (err) {
      console.error('Error migrando', key, err);
      ctx.errorsById.set(key, `«${(it && (it.name || it.title)) || key}»: ${err.message || err}`);
    }
  }
}

function finishReport(report, ctx) {
  for (const msg of ctx.errorsById.values()) report.errors.push(msg);
  return report;
}

/** Migra todo lo que haya de la versión anterior. */
export async function migrateLegacy(onProgress) {
  const report = newReport();
  const ctx = { processed: new Set(), preexisting: null, errorsById: new Map() };
  const legacy = await readLegacyDb();
  if (legacy) {
    try {
      await importLegacySet({ folders: legacy.folders, items: [], getItem: legacy.getItem, itemKeys: legacy.itemKeys }, report, onProgress, ctx);
    } finally {
      legacy.close();
    }
  }
  const ls = readLegacyLocalStorage();
  if (ls.folders.length || ls.items.length) {
    await importLegacySet({ folders: ls.folders, items: ls.items }, report, onProgress, ctx);
  }
  finishReport(report, ctx);
  migrateLegacyPreferences();
  await repo.setMeta('migration', { at: Date.now(), report });
  return report;
}

/** Importa una copia de seguridad .json de la versión anterior. */
export async function importLegacyBackupJson(text, onProgress) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('El archivo .json no se puede leer.');
  }
  if (!data || (!Array.isArray(data.items) && !Array.isArray(data.folders))) throw new Error('El archivo no es una copia de Tablet Studio.');
  const report = newReport();
  const ctx = { processed: new Set(), preexisting: null, errorsById: new Map() };
  await importLegacySet({ folders: data.folders || [], items: data.items || [] }, report, onProgress, ctx);
  return finishReport(report, ctx);
}

/** Colores favoritos y plumas personalizadas de la versión anterior (si no se han tocado aún). */
function migrateLegacyPreferences() {
  try {
    const favs = JSON.parse(localStorage.getItem('tablet_studio_fav_colors') || '[]');
    if (Array.isArray(favs) && !settings.get('favColors').length) {
      settings.set('favColors', favs.filter(c => /^#[0-9a-f]{6}$/i.test(c)).map(c => c.toLowerCase()).slice(0, 16));
    }
    const old = JSON.parse(localStorage.getItem('tablet_studio_settings') || '{}');
    if (old && typeof old.stylusOnly === 'boolean' && settings.get('fingerMode') === 'auto') {
      settings.set('fingerMode', old.stylusOnly ? 'pan' : 'draw');
    }
    if (old && (old.theme === 'dark' || old.theme === 'light') && settings.get('theme') === 'auto') {
      settings.set('theme', old.theme);
    }
  } catch {}
}
