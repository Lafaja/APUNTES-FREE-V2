// Índice de texto de los PDF: extracción con pdf.js, almacenamiento y búsqueda
// (sin distinguir mayúsculas ni acentos). Es un dato derivado: si se pierde, se vuelve a generar.

import { run, getOne, S } from './db.js';
import { acquirePdf, releasePdf } from '../render/pdf.js';
import { Emitter } from './events.js';

export const TEXT_INDEX_VERSION = 1;
export const textIndexEvents = new Emitter();

const mem = new Map(); // blobId -> { pages: string[], norm: (string|null)[], hasText, size } (LRU)
const MEM_MAX_CHARS = 8_000_000; // tope aproximado de texto en memoria (se relee de la base de datos si hace falta)
const jobs = new Map(); // blobId -> { promise, foreground, listeners } (lecturas/extracciones en curso)
const posCache = new Map(); // "blob|índice|rotación" -> Promise<posiciones>
const queue = [];
let queueBusy = false;

const charMap = new Map(); // carácter no ASCII -> carácter normalizado (siempre 1 carácter)

function mapChar(c) {
  let m = charMap.get(c);
  if (m === undefined) {
    if (/\s/.test(c)) m = ' ';
    else {
      const n = c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      if (n.length === 1) m = n;
      else {
        const l = c.toLowerCase();
        m = l.length === 1 ? l : c;
      }
    }
    charMap.set(c, m);
  }
  return m;
}

/**
 * Minúsculas, sin acentos y con cualquier espacio convertido en ' ', conservando exactamente
 * un carácter por cada carácter original (las posiciones sirven para el texto original).
 */
export function normalizeText(str) {
  return String(str)
    .replace(/[A-Z]+/g, x => x.toLowerCase())
    .replace(/[\t\n\r\v\f]/g, ' ')
    .replace(/[^\x00-\x7f]/g, mapChar);
}

export function normalizeQuery(q) {
  return normalizeText(String(q || '').replace(/\s+/g, ' ').trim());
}

function joinItems(items) {
  let s = '';
  for (const it of items) {
    if (typeof it.str !== 'string') continue;
    s += it.str;
    if (it.hasEOL) s += '\n';
  }
  return s;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function extract(blobId, job) {
  // Un indexado en segundo plano espera mientras se usa el editor (salvo que alguien lo necesite ya).
  while (paused && !job.foreground) await sleep(150);
  const doc = await acquirePdf(blobId);
  try {
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      while (paused && !job.foreground) await sleep(150);
      const page = await doc.getPage(i);
      try {
        const tc = await page.getTextContent();
        pages.push(joinItems(tc.items));
      } catch {
        pages.push('');
      }
      page.cleanup();
      for (const fn of job.listeners) {
        try {
          fn(i, doc.numPages);
        } catch {}
      }
    }
    return pages;
  } finally {
    releasePdf(blobId);
  }
}

/**
 * Texto de todas las páginas de un PDF (lo extrae y guarda la primera vez).
 * `background` = indexado de la cola (cede el paso mientras se usa el editor).
 */
export function getPdfText(blobId, { onProgress, background = false } = {}) {
  const m = touch(blobId);
  if (m) return Promise.resolve(m);
  let job = jobs.get(blobId);
  if (job) {
    if (!background) job.foreground = true;
    if (onProgress) job.listeners.add(onProgress);
    return job.promise;
  }
  job = { foreground: !background, listeners: new Set(onProgress ? [onProgress] : []), promise: null };
  job.promise = (async () => {
    let row = await getOne(S.pdfText, blobId).catch(() => null);
    if (!row || row.v !== TEXT_INDEX_VERSION || !Array.isArray(row.pages)) {
      const pages = await extract(blobId, job);
      row = { id: blobId, v: TEXT_INDEX_VERSION, pages, at: Date.now() };
      try {
        await run(S.pdfText, 'readwrite', st => { st.pdfText.put(row); });
      } catch (err) {
        console.warn('No se pudo guardar el índice de texto', err);
      }
    }
    const entry = remember(blobId, row.pages);
    failed.delete(blobId);
    textIndexEvents.emit('indexed', { blobId });
    return entry;
  })();
  jobs.set(blobId, job);
  job.promise.finally(() => jobs.delete(blobId)).catch(() => {});
  return job.promise;
}

export function peekPdfText(blobId) {
  return touch(blobId);
}

/** Carga desde la base de datos (sin extraer) si ya estaba indexado; si se está indexando, null. */
export async function loadIfIndexed(blobId) {
  if (mem.has(blobId)) return touch(blobId);
  if (jobs.has(blobId)) return null;
  const row = await getOne(S.pdfText, blobId).catch(() => null);
  if (!row || row.v !== TEXT_INDEX_VERSION || !Array.isArray(row.pages)) return null;
  return remember(blobId, row.pages);
}

function remember(blobId, pages) {
  let size = 0;
  for (const t of pages) size += t ? t.length : 0;
  const entry = { pages, norm: new Array(pages.length).fill(null), hasText: pages.some(t => t && t.trim().length > 0), size };
  mem.delete(blobId);
  mem.set(blobId, entry);
  let total = 0;
  for (const e of mem.values()) total += e.size * 2; // texto original + normalizado
  for (const [id, e] of mem) {
    if (total <= MEM_MAX_CHARS || mem.size <= 1) break;
    if (id === blobId) continue;
    mem.delete(id);
    total -= e.size * 2;
  }
  return entry;
}

function touch(blobId) {
  const e = mem.get(blobId);
  if (e) {
    mem.delete(blobId);
    mem.set(blobId, e);
  }
  return e || null;
}

function normPage(entry, i) {
  if (entry.norm[i] === null || entry.norm[i] === undefined) entry.norm[i] = normalizeText(entry.pages[i] || '');
  return entry.norm[i];
}

const reCache = new Map();

/** Expresión para buscar `nq`: cada espacio de la búsqueda admite uno o más espacios/saltos en el PDF. */
function queryRegex(nq) {
  let re = reCache.get(nq);
  if (!re) {
    const parts = nq.split(' ').filter(Boolean).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    re = new RegExp(parts.join(' +'), 'g');
    reCache.set(nq, re);
    if (reCache.size > 20) reCache.delete(reCache.keys().next().value);
  }
  return re;
}

/** Todas las apariciones de `nq` (ya normalizado) en un texto normalizado: [{ s, e }]. */
function findAll(hay, nq) {
  const out = [];
  if (!nq || !hay) return out;
  const re = queryRegex(nq);
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(hay)) !== null) {
    out.push({ s: m.index, e: m.index + m[0].length });
    if (m[0].length === 0) re.lastIndex++;
  }
  return out;
}

/** Apariciones de `nq` en la página i del PDF: [{ s, e }] (posiciones en el texto de la página). */
export function findInPage(entry, i, nq) {
  if (!nq || !entry || i < 0 || i >= entry.pages.length) return [];
  return findAll(normPage(entry, i), nq);
}

/** Fragmento legible alrededor de una coincidencia (de la posición s a la e del texto de la página). */
export function snippetAt(entry, i, s, e, radius = 55) {
  const raw = entry.pages[i] || '';
  const compact = t => t.replace(/\s+/g, ' ');
  const before = compact(raw.slice(Math.max(0, s - radius * 3), s));
  const match = compact(raw.slice(s, e));
  const after = compact(raw.slice(e, e + radius * 3));
  const b = before.length > radius ? before.slice(before.length - radius) : before;
  const a = after.length > radius ? after.slice(0, radius) : after;
  return {
    before: (b.length < before.length || s > radius * 3 ? '…' : '') + b.trimStart(),
    match,
    after: a.trimEnd() + (a.length < after.length || e + radius * 3 < raw.length ? '…' : '')
  };
}

// ---------------------------------------------------------------------------
// Indexado en segundo plano (de uno en uno, para no cargar el dispositivo)
// ---------------------------------------------------------------------------

const failed = new Set(); // PDFs que no se pudieron leer (no se reintentan en esta sesión)
let paused = false;

export function queueIndex(blobIds) {
  for (const id of blobIds) {
    if (!id || mem.has(id) || failed.has(id) || queue.includes(id)) continue;
    queue.push(id);
  }
  pumpQueue();
}

export function queueLength() {
  return queue.length + (queueBusy ? 1 : 0);
}

export function indexFailed(blobId) {
  return failed.has(blobId);
}

/** Mientras se escribe en el editor, el indexado en segundo plano espera (prioridad a la fluidez). */
export function pauseIndexing(flag) {
  paused = !!flag;
  if (!paused) pumpQueue();
}

function pumpQueue() {
  if (paused || queueBusy || !queue.length) return;
  queueBusy = true;
  const id = queue.shift();
  getPdfText(id, { background: true })
    .catch(err => {
      failed.add(id);
      console.warn('No se pudo indexar el PDF', id, err);
      textIndexEvents.emit('failed', { blobId: id });
    })
    .finally(() => {
      queueBusy = false;
      textIndexEvents.emit('queue', { remaining: queue.length });
      setTimeout(pumpQueue, 30);
    });
}

// ---------------------------------------------------------------------------
// Posiciones del texto en la página (para resaltar las coincidencias)
// ---------------------------------------------------------------------------

function mul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5]
  ];
}

/**
 * Texto y geometría de cada fragmento de una página PDF, en unidades del "viewport base"
 * (puntos PDF con la rotación aplicada, origen arriba a la izquierda).
 */
export function getPagePositions(blobId, index, rotation = 0) {
  const key = `${blobId}|${index}|${rotation}`;
  if (posCache.has(key)) {
    const p = posCache.get(key);
    posCache.delete(key);
    posCache.set(key, p); // LRU
    return p;
  }
  const p = (async () => {
    const doc = await acquirePdf(blobId);
    try {
      const page = await doc.getPage(index + 1);
      const rot = ((((page.rotate || 0) + (rotation || 0)) % 360) + 360) % 360;
      const vp = page.getViewport({ scale: 1, rotation: rot });
      const tc = await page.getTextContent();
      const styles = tc.styles || {};
      let text = '';
      const items = [];
      for (const it of tc.items) {
        if (typeof it.str !== 'string') continue;
        const s = text.length;
        text += it.str;
        if (it.str.length) {
          const tx = mul(vp.transform, it.transform);
          const fh = Math.hypot(tx[2], tx[3]) || Math.abs(it.height) || 10;
          const angle = Math.atan2(tx[1], tx[0]);
          const w = it.dir === 'ttb' ? Math.abs(it.height) : Math.abs(it.width);
          const st = styles[it.fontName] || {};
          const clamp = (v, lo, hi, def) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
          items.push({
            s, e: text.length, x: tx[4], y: tx[5], w, fh, angle,
            str: it.str,
            family: st.fontFamily || 'sans-serif',
            asc: clamp(st.ascent, 0.6, 1.1, 0.86),
            desc: clamp(Math.abs(st.descent), 0.1, 0.4, 0.24)
          });
        }
        if (it.hasEOL) text += '\n';
      }
      return { text, norm: normalizeText(text), items, baseW: vp.width, baseH: vp.height };
    } finally {
      releasePdf(blobId);
    }
  })();
  posCache.set(key, p);
  p.catch(() => posCache.delete(key));
  while (posCache.size > 80) posCache.delete(posCache.keys().next().value);
  return p;
}

let measureCtx = null;

function textWidth(str, family) {
  if (!measureCtx) {
    const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    measureCtx = c.getContext('2d');
  }
  const font = `100px ${family}`;
  if (measureCtx.font !== font) measureCtx.font = font;
  return measureCtx.measureText(str).width;
}

/** Fracción del ancho del fragmento que ocupan sus primeros n caracteres (midiendo las letras reales). */
function fracAt(it, n) {
  const len = it.e - it.s;
  if (n <= 0) return 0;
  if (n >= len) return 1;
  try {
    const total = textWidth(it.str, it.family);
    if (total > 0) return Math.min(1, Math.max(0, textWidth(it.str.slice(0, n), it.family) / total));
  } catch {}
  return n / len;
}

/**
 * Rectángulos (unidades del viewport base) de cada aparición de `nq` en la página.
 * Devuelve un array de coincidencias; cada una es un array de rectángulos {x, y, w, h}.
 */
export function matchRects(pos, nq) {
  const out = [];
  if (!nq || !pos) return out;
  for (const { s: k, e: end } of findAll(pos.norm, nq)) {
    const rects = [];
    for (const it of pos.items) {
      if (it.e <= k || it.s >= end) continue;
      const f0 = fracAt(it, Math.max(k, it.s) - it.s);
      const f1 = fracAt(it, Math.min(end, it.e) - it.s);
      const cos = Math.cos(it.angle);
      const sin = Math.sin(it.angle);
      const ux = sin;
      const uy = -cos; // "arriba" del texto
      const asc = it.fh * (it.asc || 0.86);
      const desc = it.fh * (it.desc || 0.24);
      const ax = it.x + cos * it.w * f0;
      const ay = it.y + sin * it.w * f0;
      const bx = it.x + cos * it.w * f1;
      const by = it.y + sin * it.w * f1;
      const xs = [ax + ux * asc, bx + ux * asc, ax - ux * desc, bx - ux * desc];
      const ys = [ay + uy * asc, by + uy * asc, ay - uy * desc, by - uy * desc];
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      rects.push({ x: x0, y: y0, w: Math.max(...xs) - x0, h: Math.max(...ys) - y0 });
    }
    out.push(rects); // siempre, para que el número de aparición coincida con findInPage
  }
  return out;
}
