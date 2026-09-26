// Sesión de documento abierto: modelo en memoria, historial (deshacer/rehacer) y guardado incremental.
//
// Guardado: cada cambio marca su página como "sucia"; tras 400 ms sin cambios (o como máximo cada 2 s
// escribiendo sin parar) se escriben SOLO las páginas modificadas en una transacción. Si falla, se
// reintenta y se avisa al usuario; nunca se descarta un cambio pendiente.

import { Emitter } from '../core/events.js';
import * as repo from '../core/repo.js';
import { uid, debounce, cleanName } from '../core/util.js';
import { normalizeStroke, normalizeImage, strokeBBox, imageBBox, unionRect } from './stroke.js';
import { normalizeBg } from './paper.js';

const SAVE_DELAY = 400;
const SAVE_MAX_WAIT = 2000;
const HISTORY_LIMIT = 300;
export const SNAPSHOT_INTERVAL = 10 * 60 * 1000;

const sessions = new Map();

function itemBBox(key, o) {
  return key === 'images' ? imageBBox(o) : strokeBBox(o);
}

export function normalizePageRecord(rec, ref, docId) {
  const page = {
    id: rec.id,
    docId: rec.docId || docId,
    w: Number.isFinite(rec.w) ? rec.w : ref ? ref.w : 794,
    h: Number.isFinite(rec.h) ? rec.h : ref ? ref.h : 1123,
    bg: normalizeBg(rec.bg),
    pdf: rec.pdf && rec.pdf.blobId ? { rotation: 0, x: 0, y: 0, ...rec.pdf } : null,
    strokes: [],
    images: [],
    rev: rec.rev || 0,
    updatedAt: rec.updatedAt || 0
  };
  let dropped = 0;
  for (const s of rec.strokes || []) {
    const n = normalizeStroke(s);
    if (n) page.strokes.push(n);
    else dropped++;
  }
  for (const i of rec.images || []) {
    const n = normalizeImage(i);
    if (n) page.images.push(n);
    else dropped++;
  }
  if (dropped) console.warn(`Página ${rec.id}: ${dropped} elementos dañados se ignoraron al cargar.`);
  return page;
}

export class DocSession extends Emitter {
  constructor(node) {
    super();
    this.id = node.id;
    this.node = node;
    this.pages = new Map(); // pageId -> registro en memoria
    this.loading = new Map(); // pageId -> Promise
    this.dirtyPages = new Set();
    this.deletedPages = new Set();
    this.nodeDirty = false;
    this.undoStack = [];
    this.redoStack = [];
    this.refs = 0;
    this.saveState = 'saved'; // 'saved' | 'pending' | 'saving' | 'error'
    this.lastError = null;
    this.changesSinceSnapshot = false;
    this.lastSnapshotAt = Date.now();
    this.readOnly = false;
    this._retryTimer = null;
    this._retryDelay = 2000;
    this._saving = null;
    this._scheduleSave = debounce(() => this.flush(), SAVE_DELAY, { maxWait: SAVE_MAX_WAIT });
    this._snapshotTimer = setInterval(() => this.maybeSnapshot('Automática').catch(() => {}), 60 * 1000);
    this._lockRelease = null;
  }

  // ---------------- Carga ----------------

  get pageRefs() {
    return this.node.pages;
  }

  pageIndex(pageId) {
    return this.node.pages.findIndex(p => p.id === pageId);
  }

  getPageSync(pageId) {
    return this.pages.get(pageId) || null;
  }

  async getPage(pageId) {
    const cached = this.pages.get(pageId);
    if (cached) return cached;
    if (this.loading.has(pageId)) return this.loading.get(pageId);
    const ref = this.node.pages.find(p => p.id === pageId);
    const p = repo.loadPage(pageId).then(rec => {
      this.loading.delete(pageId);
      if (this.pages.has(pageId)) return this.pages.get(pageId);
      let page;
      if (!rec) {
        // Página sin registro (no debería ocurrir): se crea vacía para no bloquear el documento.
        console.warn('Página sin datos, se crea en blanco:', pageId);
        page = normalizePageRecord({ id: pageId, bg: this.node.paper || null }, ref, this.id);
        this.dirtyPages.add(pageId);
        this._markChanged();
      } else {
        page = normalizePageRecord(rec, ref, this.id);
      }
      if (ref && (ref.w !== page.w || ref.h !== page.h)) {
        ref.w = page.w;
        ref.h = page.h;
        this.nodeDirty = true;
        this.emit('layout', {});
      }
      this._pinBlobs(page);
      this.pages.set(pageId, page);
      return page;
    }, err => {
      this.loading.delete(pageId);
      throw err;
    });
    this.loading.set(pageId, p);
    return p;
  }

  async loadAllPages() {
    const recs = await repo.loadPages(this.id);
    for (const rec of recs) {
      if (this.pages.has(rec.id)) continue;
      const ref = this.node.pages.find(p => p.id === rec.id);
      if (!ref) continue;
      const page = normalizePageRecord(rec, ref, this.id);
      this._pinBlobs(page);
      this.pages.set(rec.id, page);
    }
    // Las que no tengan registro se crean con getPage.
    await Promise.all(this.node.pages.map(r => this.getPage(r.id)));
    return this.node.pages.map(r => this.pages.get(r.id));
  }

  _pinBlobs(page) {
    if (page.pdf && page.pdf.blobId) repo.pinnedBlobs.add(page.pdf.blobId);
    for (const img of page.images) repo.pinnedBlobs.add(img.blobId);
  }

  // ---------------- Cambios de contenido (operaciones "splice") ----------------

  /**
   * Aplica operaciones sobre los arrays de una página.
   * op = { key: 'strokes'|'images', index, removed: [], added: [] }
   * Devuelve el rectángulo afectado (coordenadas de página).
   */
  _applyOps(page, ops, reverse = false) {
    let rect = null;
    const list = reverse ? [...ops].reverse() : ops;
    for (const op of list) {
      const arr = page[op.key];
      const removeCount = reverse ? op.added.length : op.removed.length;
      const insert = reverse ? op.removed : op.added;
      const out = arr.splice(op.index, removeCount, ...insert);
      for (const o of out) rect = unionRect(rect, itemBBox(op.key, o));
      for (const o of insert) rect = unionRect(rect, itemBBox(op.key, o));
      if (op.key === 'images') for (const o of insert) repo.pinnedBlobs.add(o.blobId);
    }
    return rect;
  }

  _touchPage(pageId) {
    this.dirtyPages.add(pageId);
    this._markChanged();
  }

  _markChanged() {
    this.changesSinceSnapshot = true;
    if (this.saveState !== 'saving') this._setSaveState('pending');
    this._scheduleSave();
  }

  _setSaveState(state, error = null) {
    this.saveState = state;
    this.lastError = error;
    this.emit('save-state', { state, error });
  }

  _pushHistory(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
    this.emit('history', this.historyState());
  }

  historyState() {
    return { canUndo: this.undoStack.length > 0, canRedo: this.redoStack.length > 0 };
  }

  /**
   * Punto de entrada general para modificar el contenido de una página con historial.
   * `ops` se aplica tal cual; `info` se reenvía a las vistas (origin, fastAdd, label).
   */
  commit(pageId, ops, info = {}) {
    if (this.readOnly || !ops.length) return;
    const page = this.pages.get(pageId);
    if (!page) throw new Error('Página no cargada');
    const rect = this._applyOps(page, ops, false);
    this._touchPage(pageId);
    if (info.record !== false) this._pushHistory({ type: 'ops', pageId, ops, label: info.label || '' });
    this.emit('page-change', { pageId, rect, origin: info.origin || null, fastAdd: info.fastAdd || null });
  }

  /** Registra en el historial operaciones ya aplicadas con commit(..., { record: false }). */
  recordOps(pageId, ops, label = '') {
    if (!ops.length) return;
    this._pushHistory({ type: 'ops', pageId, ops: [...ops], label });
  }

  /** Añade trazos al final de la página. */
  addStrokes(pageId, strokes, info = {}) {
    const page = this.pages.get(pageId);
    if (!page || !strokes.length) return;
    const allOnTop = strokes.every(s => s.t !== 'highlighter');
    this.commit(pageId, [{ key: 'strokes', index: page.strokes.length, removed: [], added: strokes }], {
      ...info,
      fastAdd: allOnTop ? strokes : null
    });
  }

  addImages(pageId, images, info = {}) {
    const page = this.pages.get(pageId);
    if (!page || !images.length) return;
    this.commit(pageId, [{ key: 'images', index: page.images.length, removed: [], added: images }], info);
  }

  /** Construye operaciones para quitar elementos por id (en orden descendente de índice). */
  opsForRemoval(page, key, ids) {
    const set = ids instanceof Set ? ids : new Set(ids);
    const ops = [];
    for (let i = page[key].length - 1; i >= 0; i--) {
      if (set.has(page[key][i].id)) ops.push({ key, index: i, removed: [page[key][i]], added: [] });
    }
    return ops;
  }

  /** Construye operaciones para reemplazar elementos (mismo índice) por versiones nuevas. */
  opsForReplace(page, key, replacements) {
    const ops = [];
    const map = replacements instanceof Map ? replacements : new Map(replacements.map(o => [o.id, o]));
    for (let i = 0; i < page[key].length; i++) {
      const cur = page[key][i];
      const next = map.get(cur.id);
      if (next && next !== cur) ops.push({ key, index: i, removed: [cur], added: [next] });
    }
    return ops;
  }

  // ---------------- Deshacer / rehacer ----------------

  async undo() {
    if (this.readOnly) return;
    const entry = this.undoStack.pop();
    if (!entry) return;
    await this._applyHistory(entry, true);
    this.redoStack.push(entry);
    this.emit('history', this.historyState());
  }

  async redo() {
    if (this.readOnly) return;
    const entry = this.redoStack.pop();
    if (!entry) return;
    await this._applyHistory(entry, false);
    this.undoStack.push(entry);
    this.emit('history', this.historyState());
  }

  async _applyHistory(entry, reverse) {
    if (entry.type === 'ops') {
      const page = await this.getPage(entry.pageId);
      if (!page || this.pageIndex(entry.pageId) === -1) return;
      const rect = this._applyOps(page, entry.ops, reverse);
      this._touchPage(entry.pageId);
      this.emit('page-change', { pageId: entry.pageId, rect, origin: null, fastAdd: null, reveal: true });
    } else if (entry.type === 'custom') {
      await (reverse ? entry.undo() : entry.redo());
    }
  }

  // ---------------- Páginas ----------------

  /** Inserta una página nueva (registro completo) en `index`. */
  insertPage(index, pageData, { record = true } = {}) {
    if (this.readOnly) return null;
    const page = normalizePageRecord({ ...pageData, id: pageData.id || uid('p'), docId: this.id }, null, this.id);
    this._insertPageRaw(index, page);
    if (record) {
      this._pushHistory({
        type: 'custom',
        label: 'Añadir página',
        undo: () => this._removePageRaw(page.id),
        redo: () => this._insertPageRaw(index, page)
      });
    }
    return page;
  }

  _insertPageRaw(index, page) {
    const i = Math.max(0, Math.min(index, this.node.pages.length));
    this.node.pages.splice(i, 0, { id: page.id, w: page.w, h: page.h });
    this.pages.set(page.id, page);
    this.deletedPages.delete(page.id);
    this.dirtyPages.add(page.id);
    this._pinBlobs(page);
    this.nodeDirty = true;
    this._markChanged();
    this.emit('layout', { inserted: page.id });
  }

  _removePageRaw(pageId) {
    const i = this.pageIndex(pageId);
    if (i === -1) return;
    this.node.pages.splice(i, 1);
    this.dirtyPages.delete(pageId);
    this.deletedPages.add(pageId);
    this.nodeDirty = true;
    this._markChanged();
    this.emit('layout', { removed: pageId });
  }

  /** Borra una página (se puede deshacer; además queda una versión de seguridad). */
  async deletePage(pageId) {
    if (this.readOnly || this.node.pages.length <= 1) return false;
    const index = this.pageIndex(pageId);
    if (index === -1) return false;
    const page = await this.getPage(pageId);
    await this.snapshotNow('Antes de borrar una página');
    this._removePageRaw(pageId);
    this._pushHistory({
      type: 'custom',
      label: 'Borrar página',
      undo: () => this._insertPageRaw(index, page),
      redo: () => this._removePageRaw(pageId)
    });
    return true;
  }

  movePage(from, to) {
    if (this.readOnly) return;
    const n = this.node.pages.length;
    if (from < 0 || from >= n || to < 0 || to >= n || from === to) return;
    const apply = (a, b) => {
      const [ref] = this.node.pages.splice(a, 1);
      this.node.pages.splice(b, 0, ref);
      this.nodeDirty = true;
      this._markChanged();
      this.emit('layout', { moved: ref.id });
    };
    apply(from, to);
    this._pushHistory({ type: 'custom', label: 'Mover página', undo: () => apply(to, from), redo: () => apply(from, to) });
  }

  async duplicatePage(pageId) {
    const page = await this.getPage(pageId);
    const index = this.pageIndex(pageId);
    const copy = {
      w: page.w,
      h: page.h,
      bg: { ...page.bg },
      pdf: page.pdf ? { ...page.pdf } : null,
      strokes: page.strokes.map(s => ({ ...s, id: uid('s'), pts: new Float32Array(s.pts) })),
      images: page.images.map(i => ({ ...i, id: uid('i') }))
    };
    return this.insertPage(index + 1, copy);
  }

  setPageBg(pageId, bg) {
    const page = this.pages.get(pageId);
    if (!page || this.readOnly) return;
    const before = { ...page.bg };
    const after = normalizeBg({ ...page.bg, ...bg });
    const apply = value => {
      page.bg = { ...value };
      this._touchPage(pageId);
      this.emit('page-bg', { pageId });
    };
    apply(after);
    this._pushHistory({ type: 'custom', label: 'Fondo', undo: () => apply(before), redo: () => apply(after) });
  }

  /** Aplica un fondo a todas las páginas (sin PDF) del documento. */
  async setAllPagesBg(bg) {
    if (this.readOnly) return;
    await this.loadAllPages();
    const changes = [];
    for (const ref of this.node.pages) {
      const page = this.pages.get(ref.id);
      if (!page) continue;
      changes.push({ page, before: { ...page.bg }, after: normalizeBg({ ...page.bg, ...bg }) });
    }
    const apply = key => {
      for (const c of changes) {
        c.page.bg = { ...c[key] };
        this._touchPage(c.page.id);
        this.emit('page-bg', { pageId: c.page.id });
      }
    };
    apply('after');
    this.node.paper = { ...(this.node.paper || {}), template: bg.template ?? this.node.paper?.template, color: bg.color ?? this.node.paper?.color, spacing: bg.spacing ?? this.node.paper?.spacing };
    this.nodeDirty = true;
    this._pushHistory({ type: 'custom', label: 'Fondo', undo: () => apply('before'), redo: () => apply('after') });
  }

  /** Cambia el tamaño de una página (pizarra infinita). No entra en el historial. */
  resizePage(pageId, w, h) {
    const page = this.pages.get(pageId);
    const ref = this.node.pages.find(p => p.id === pageId);
    if (!page || !ref) return;
    page.w = w;
    page.h = h;
    ref.w = w;
    ref.h = h;
    this.nodeDirty = true;
    this._touchPage(pageId);
    this.emit('layout', { resized: pageId });
  }

  rename(name) {
    const clean = cleanName(name);
    if (clean === this.node.name) return;
    this.node.name = clean;
    this.nodeDirty = true;
    this._markChanged();
    this.emit('renamed', { name: clean });
  }

  setView(view) {
    this.node.view = view;
    this.nodeDirty = true;
    this._scheduleSave();
  }

  // ---------------- Marcadores de página ----------------

  /** Ids de las páginas marcadas que siguen existiendo, en el orden del documento. */
  bookmarkedPageIds() {
    const set = new Set(Array.isArray(this.node.bookmarks) ? this.node.bookmarks : []);
    return this.node.pages.filter(r => set.has(r.id)).map(r => r.id);
  }

  isBookmarked(pageId) {
    return Array.isArray(this.node.bookmarks) && this.node.bookmarks.includes(pageId);
  }

  /**
   * Marca o desmarca una página (value indefinido = alternar). Devuelve el estado final.
   * Los ids de páginas borradas se conservan: si se deshace el borrado, el marcador vuelve.
   */
  toggleBookmark(pageId, value) {
    const has = this.isBookmarked(pageId);
    if (this.readOnly) return has;
    const on = value === undefined ? !has : !!value;
    if (on === has) return on;
    const list = Array.isArray(this.node.bookmarks) ? this.node.bookmarks : [];
    this.node.bookmarks = on ? [...list, pageId] : list.filter(id => id !== pageId);
    this.nodeDirty = true;
    this._markChanged();
    this.emit('bookmarks', { pageId, on });
    return on;
  }

  // ---------------- Guardado ----------------

  hasPendingChanges() {
    return this.dirtyPages.size > 0 || this.deletedPages.size > 0 || this.nodeDirty || this._scheduleSave.pending();
  }

  /** Escribe los cambios pendientes. Devuelve true si todo quedó guardado. */
  async flush({ strict = false } = {}) {
    this._scheduleSave.cancel();
    if (this._saving) {
      // Esperar al guardado en curso y volver a comprobar.
      try { await this._saving; } catch {}
    }
    if (!this.dirtyPages.size && !this.deletedPages.size && !this.nodeDirty) {
      if (this.saveState !== 'saved' && this.saveState !== 'error') this._setSaveState('saved');
      return this.saveState !== 'error';
    }
    const now = Date.now();
    const pageIds = [...this.dirtyPages];
    const deleted = [...this.deletedPages];
    const pages = [];
    for (const id of pageIds) {
      const page = this.pages.get(id);
      if (!page || this.pageIndex(id) === -1) continue;
      page.rev = (page.rev || 0) + 1;
      page.updatedAt = now;
      pages.push(page);
    }
    this.dirtyPages.clear();
    this.deletedPages.clear();
    this.nodeDirty = false;
    this.node.updatedAt = now;
    this.node.rev = (this.node.rev || 0) + 1;
    this._setSaveState('saving');
    this._saving = repo.saveDocument({ node: this.node, pages, deletedPageIds: deleted }, { durability: strict ? 'strict' : 'relaxed' });
    try {
      await this._saving;
      this._saving = null;
      this._retryDelay = 2000;
      if (this.dirtyPages.size || this.deletedPages.size || this.nodeDirty) {
        this._setSaveState('pending');
        this._scheduleSave();
      } else {
        this._setSaveState('saved');
      }
      this.emit('saved', { at: now });
      return true;
    } catch (err) {
      this._saving = null;
      // Devolver todo a "sucio" para no perder nada y reintentar.
      for (const id of pageIds) if (this.pageIndex(id) !== -1) this.dirtyPages.add(id);
      for (const id of deleted) if (this.pageIndex(id) === -1) this.deletedPages.add(id);
      this.nodeDirty = true;
      console.error('Error al guardar el documento', err);
      this._setSaveState('error', err);
      clearTimeout(this._retryTimer);
      this._retryTimer = setTimeout(() => this.flush(), this._retryDelay);
      this._retryDelay = Math.min(this._retryDelay * 2, 30000);
      return false;
    }
  }

  /** Crea una versión en el historial si hubo cambios y ha pasado tiempo suficiente. */
  async maybeSnapshot(reason = 'Automática', minInterval = SNAPSHOT_INTERVAL) {
    if (!this.changesSinceSnapshot) return null;
    if (Date.now() - this.lastSnapshotAt < minInterval) return null;
    return this.snapshotNow(reason);
  }

  async snapshotNow(reason) {
    const ok = await this.flush({ strict: true });
    if (!ok) return null;
    const v = await repo.createVersion(this.id, reason);
    this.lastSnapshotAt = Date.now();
    this.changesSinceSnapshot = false;
    this.emit('versions-changed', {});
    return v;
  }

  dispose() {
    clearInterval(this._snapshotTimer);
    clearTimeout(this._retryTimer);
    this._scheduleSave.cancel();
    if (this._lockRelease) this._lockRelease();
  }
}

// ---------------- Registro de sesiones (una por documento, compartida entre paneles) ----------------

async function acquireLock(docId) {
  if (!globalThis.navigator || !navigator.locks || typeof navigator.locks.request !== 'function') return { ok: true, release: () => {} };
  return new Promise(resolve => {
    navigator.locks.request(`tablet-studio-doc-${docId}`, { ifAvailable: true }, lock => {
      if (!lock) {
        resolve({ ok: false, release: () => {} });
        return undefined;
      }
      return new Promise(release => resolve({ ok: true, release }));
    }).catch(() => resolve({ ok: true, release: () => {} }));
  });
}

export async function openSession(docId) {
  let s = sessions.get(docId);
  if (!s) {
    const node = await repo.getNode(docId);
    if (!node || node.kind !== 'doc') throw new Error('El documento no existe');
    s = new DocSession(node);
    sessions.set(docId, s);
    const lock = await acquireLock(docId);
    s._lockRelease = lock.release;
    if (!lock.ok) s.readOnly = true;
  }
  s.refs++;
  return s;
}

export async function releaseSession(session) {
  if (!session) return;
  session.refs--;
  if (session.refs > 0) return;
  try {
    await session.flush({ strict: true });
    await session.maybeSnapshot('Al cerrar', 3 * 60 * 1000);
  } catch (err) {
    console.error('Error al cerrar el documento', err);
  }
  // Si falló el guardado, la sesión se mantiene viva para reintentar (no se pierden cambios).
  if (session.hasPendingChanges() || session.saveState === 'error') {
    session.refs = 0;
    return;
  }
  session.dispose();
  sessions.delete(session.id);
}

export function allSessions() {
  return [...sessions.values()];
}

/** Guarda de forma estricta todas las sesiones abiertas (al ocultar la app o antes de recargar). */
export async function flushAllSessions() {
  const results = await Promise.all([...sessions.values()].map(s => s.flush({ strict: true }).catch(() => false)));
  return results.every(Boolean);
}

export function anyPendingChanges() {
  return [...sessions.values()].some(s => s.hasPendingChanges() || s.saveState === 'saving' || s.saveState === 'error');
}
