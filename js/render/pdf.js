// Motor PDF: carga perezosa de pdf.js, caché de documentos y cola de renderizado con prioridad.

import * as repo from '../core/repo.js';

const LIB_BASE = new URL('../../libs/pdfjs/', import.meta.url).href;
let libPromise = null;

export function loadPdfJs() {
  if (!libPromise) {
    libPromise = import('../../libs/pdfjs/pdf.min.mjs')
      .then(lib => {
        lib.GlobalWorkerOptions.workerSrc = LIB_BASE + 'pdf.worker.min.mjs';
        return lib;
      })
      .catch(err => {
        libPromise = null;
        throw err;
      });
  }
  return libPromise;
}

function docOptions(data) {
  return {
    data,
    cMapUrl: LIB_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: LIB_BASE + 'standard_fonts/',
    wasmUrl: LIB_BASE + 'wasm/',
    iccUrl: LIB_BASE + 'iccs/',
    isEvalSupported: false,
    enableXfa: false
  };
}

/** Cierra un documento de pdf.js y libera su worker (en pdf.js 6 se hace a través de loadingTask). */
export function closePdf(doc) {
  try {
    if (!doc) return;
    const task = doc.loadingTask;
    if (task && typeof task.destroy === 'function') {
      task.destroy().catch(() => {});
      return;
    }
    if (typeof doc.destroy === 'function') {
      const r = doc.destroy();
      if (r && typeof r.catch === 'function') r.catch(() => {});
    }
  } catch {
    // Cerrar nunca debe romper el flujo que lo llama.
  }
}

/** Abre un PDF a partir de bytes. OJO: pdf.js se queda con el buffer (lo transfiere al worker). */
export async function openPdfBytes(bytes, { password } = {}) {
  const lib = await loadPdfJs();
  const opts = docOptions(bytes);
  if (password) opts.password = password;
  return lib.getDocument(opts).promise;
}

const docs = new Map(); // blobId -> { promise, refs, timer }

export function acquirePdf(blobId) {
  let e = docs.get(blobId);
  if (!e) {
    e = { refs: 0, timer: null, promise: null };
    e.promise = (async () => {
      const blob = await repo.getBlob(blobId);
      if (!blob || !blob.data) throw new Error('El archivo PDF original no se encuentra en el almacenamiento.');
      return openPdfBytes(new Uint8Array(blob.data));
    })();
    e.promise.catch(() => {
      if (docs.get(blobId) === e) docs.delete(blobId);
    });
    docs.set(blobId, e);
  }
  e.refs++;
  clearTimeout(e.timer);
  return e.promise;
}

export function releasePdf(blobId) {
  const e = docs.get(blobId);
  if (!e) return;
  e.refs = Math.max(0, e.refs - 1);
  if (e.refs === 0) {
    clearTimeout(e.timer);
    e.timer = setTimeout(async () => {
      if (e.refs > 0 || docs.get(blobId) !== e) return;
      docs.delete(blobId);
      try {
        closePdf(await e.promise);
      } catch {}
    }, 45000);
  }
}

/**
 * Renderiza una página (o una región) a un canvas nuevo.
 * targetWidth: ancho en píxeles de dispositivo que ocuparía la página completa.
 * region: { x, y, w, h } en esos mismos píxeles (opcional).
 */
export async function renderPdfPage({ blobId, index, rotation = 0, targetWidth, region = null, signal = null }) {
  const doc = await acquirePdf(blobId);
  try {
    if (signal && signal.aborted) throw new DOMException('cancelado', 'AbortError');
    const page = await doc.getPage(index + 1);
    const rot = (((page.rotate || 0) + (rotation || 0)) % 360 + 360) % 360;
    const base = page.getViewport({ scale: 1, rotation: rot });
    const scale = targetWidth / base.width;
    const vp = page.getViewport({ scale, rotation: rot });
    const r = region || { x: 0, y: 0, w: Math.ceil(vp.width), h: Math.ceil(vp.height) };
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(r.w));
    canvas.height = Math.max(1, Math.round(r.h));
    if (signal && signal.aborted) throw new DOMException('cancelado', 'AbortError');
    const task = page.render({
      canvas,
      viewport: vp,
      transform: r.x || r.y ? [1, 0, 0, 1, -r.x, -r.y] : undefined,
      background: '#ffffff'
    });
    const onAbort = () => {
      try { task.cancel(); } catch {}
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    try {
      await task.promise;
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
    return canvas;
  } finally {
    releasePdf(blobId);
  }
}

/** Tamaños de todas las páginas (en puntos, con la rotación aplicada). */
export async function pdfPageSizes(doc, rotation = 0, onProgress) {
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const rot = (((page.rotate || 0) + rotation) % 360 + 360) % 360;
    const vp = page.getViewport({ scale: 1, rotation: rot });
    sizes.push({ w: vp.width, h: vp.height });
    page.cleanup();
    if (onProgress && i % 10 === 0) onProgress(i, doc.numPages);
  }
  return sizes;
}

// ---------------------------------------------------------------------------
// Cola de renderizado: una tarea a la vez, siempre la de mayor prioridad.
// Las vistas pueden reemplazar su petición pendiente o cancelarla.
// ---------------------------------------------------------------------------

class RenderQueue {
  constructor() {
    this.pending = new Map(); // owner -> { priority: () => number, run: (signal) => Promise }
    this.running = null; // { owner, controller }
    this.paused = false;
  }

  request(owner, job) {
    this.pending.set(owner, job);
    if (this.running && this.running.owner === owner) this.running.controller.abort();
    this._pump();
  }

  cancel(owner) {
    this.pending.delete(owner);
    if (this.running && this.running.owner === owner) this.running.controller.abort();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this._pump();
  }

  _pump() {
    if (this.running || this.paused || !this.pending.size) return;
    let best = null;
    let bestP = Infinity;
    for (const [owner, job] of this.pending) {
      let p = 0;
      try { p = job.priority ? job.priority() : 0; } catch { p = 1e9; }
      if (p < bestP) {
        bestP = p;
        best = owner;
      }
    }
    const job = this.pending.get(best);
    this.pending.delete(best);
    const controller = new AbortController();
    this.running = { owner: best, controller };
    Promise.resolve()
      .then(() => job.run(controller.signal))
      .catch(err => {
        if (err && (err.name === 'AbortError' || err.name === 'RenderingCancelledException')) return;
        console.warn('Error al renderizar PDF', err);
        if (job.onError) job.onError(err);
      })
      .finally(() => {
        this.running = null;
        // Ceder un frame entre tareas para no bloquear gestos.
        (globalThis.requestAnimationFrame || setTimeout)(() => this._pump());
      });
  }
}

export const pdfQueue = new RenderQueue();
