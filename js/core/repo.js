// Repositorio: todas las operaciones de persistencia pasan por aquí.
// Principios:
//  - Borrar = mover a la papelera (deletedAt). El borrado definitivo solo ocurre desde la papelera.
//  - Cada guardado escribe únicamente las páginas modificadas (nada de re-serializar el documento entero).
//  - Los binarios (PDF, imágenes) se guardan una sola vez, identificados por su hash SHA-256.
//  - Las versiones (historial) comparten las páginas que no han cambiado entre instantáneas.

import { run, getAll, getOne, getAllByIndex, S } from './db.js';
import { uid, sha256Hex, cleanName } from './util.js';

export const MAX_VERSIONS_PER_DOC = 15;

/** Blobs referenciados por sesiones abiertas (historial de deshacer); el GC nunca los borra. */
export const pinnedBlobs = new Set();

// ---------------------------------------------------------------------------
// Nodos (carpetas y documentos)
// ---------------------------------------------------------------------------

export function loadAllNodes() {
  return getAll(S.nodes);
}

export function getNode(id) {
  return getOne(S.nodes, id);
}

export function putNode(node, opts) {
  return run(S.nodes, 'readwrite', st => {
    st.nodes.put(node);
    return node;
  }, opts);
}

export async function createFolder({ name, color = '#3b82f6', parentId = null }) {
  const now = Date.now();
  const folder = {
    id: uid('f'),
    kind: 'folder',
    name: cleanName(name, 'Carpeta'),
    color,
    parentId: parentId || null,
    createdAt: now,
    updatedAt: now,
    deletedAt: 0,
    trashedFrom: null
  };
  await putNode(folder, { durability: 'strict' });
  return folder;
}

/**
 * Crea un documento con sus páginas en una única transacción.
 * pages: registros completos { id, w, h, bg, pdf, strokes, images }.
 */
export async function createDocument({ name, parentId = null, source = 'note', paper = null, pages = [], pdf = null, autoAddPages = source === 'note' }) {
  const now = Date.now();
  const docId = uid('d');
  const pageRecords = pages.map(p => ({
    id: p.id || uid('p'),
    docId,
    w: p.w,
    h: p.h,
    bg: p.bg,
    pdf: p.pdf || null,
    strokes: p.strokes || [],
    images: p.images || [],
    rev: 1,
    updatedAt: now
  }));
  const node = {
    id: docId,
    kind: 'doc',
    source,
    name: cleanName(name),
    parentId: parentId || null,
    createdAt: now,
    updatedAt: now,
    openedAt: 0,
    deletedAt: 0,
    trashedFrom: null,
    paper: paper || null,
    pdf: pdf || null,
    autoAddPages: !!autoAddPages,
    pages: pageRecords.map(p => ({ id: p.id, w: p.w, h: p.h })),
    view: null,
    rev: 1,
    thumbRev: 0
  };
  await run([S.nodes, S.pages], 'readwrite', st => {
    st.nodes.put(node);
    for (const p of pageRecords) st.pages.put(p);
  }, { durability: 'strict' });
  return { node, pages: pageRecords };
}

/** Actualiza campos de un nodo leyendo la versión guardada dentro de la misma transacción. */
export function patchNode(id, patch, opts = { durability: 'strict' }) {
  return run(S.nodes, 'readwrite', st => {
    let out = null;
    const req = st.nodes.get(id);
    req.onsuccess = () => {
      const cur = req.result;
      if (!cur) return;
      out = { ...cur, ...(typeof patch === 'function' ? patch(cur) : patch) };
      st.nodes.put(out);
    };
    return () => out;
  }, opts);
}

/** Marca o desmarca documentos y carpetas como favoritos. */
export function setFavorite(ids, value) {
  return run(S.nodes, 'readwrite', st => {
    for (const id of ids) {
      const req = st.nodes.get(id);
      req.onsuccess = () => {
        const n = req.result;
        if (n && !!n.favorite !== !!value) st.nodes.put({ ...n, favorite: !!value });
      };
    }
  }, { durability: 'strict' });
}

export function renameNode(id, name) {
  return patchNode(id, { name: cleanName(name), updatedAt: Date.now() });
}

function descendantsOf(rootIds, nodes) {
  const byParent = new Map();
  for (const n of nodes) {
    const k = n.parentId || '__root__';
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(n);
  }
  const out = new Set();
  const stack = [...rootIds];
  while (stack.length) {
    const id = stack.pop();
    if (out.has(id)) continue;
    out.add(id);
    for (const child of byParent.get(id) || []) stack.push(child.id);
  }
  return out;
}

/** Mueve nodos a otra carpeta. Rechaza mover una carpeta dentro de sí misma o de sus hijas. */
export async function moveNodes(ids, targetParentId) {
  const target = targetParentId || null;
  return run(S.nodes, 'readwrite', (st, tx, fail) => {
    let moved = 0;
    const req = st.nodes.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const byId = new Map(all.map(n => [n.id, n]));
      if (target && (!byId.has(target) || byId.get(target).kind !== 'folder')) {
        fail(new Error('La carpeta de destino no existe'));
        return;
      }
      const forbidden = descendantsOf(ids.filter(id => byId.get(id)?.kind === 'folder'), all);
      if (target && forbidden.has(target)) {
        fail(Object.assign(new Error('No se puede mover una carpeta dentro de sí misma.'), { code: 'CYCLE' }));
        return;
      }
      const now = Date.now();
      for (const id of ids) {
        const n = byId.get(id);
        if (!n || n.parentId === target) continue;
        st.nodes.put({ ...n, parentId: target, updatedAt: now });
        moved++;
      }
    };
    return () => moved;
  }, { durability: 'strict' });
}

/** Envía a la papelera (reversible). Los hijos de una carpeta se quedan dentro de ella. */
export function trashNodes(ids) {
  return run(S.nodes, 'readwrite', st => {
    const now = Date.now();
    for (const id of ids) {
      const req = st.nodes.get(id);
      req.onsuccess = () => {
        const n = req.result;
        if (!n || n.deletedAt) return;
        st.nodes.put({ ...n, deletedAt: now, trashedFrom: n.parentId || null });
      };
    }
  }, { durability: 'strict' });
}

/** Restaura desde la papelera. Si la carpeta original ya no está disponible, va a la raíz. */
export function restoreNodes(ids) {
  return run(S.nodes, 'readwrite', st => {
    const req = st.nodes.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const byId = new Map(all.map(n => [n.id, n]));
      const isAlive = id => {
        let cur = id ? byId.get(id) : null;
        const seen = new Set();
        while (cur) {
          if (seen.has(cur.id)) return false;
          seen.add(cur.id);
          if (cur.deletedAt) return false;
          cur = cur.parentId ? byId.get(cur.parentId) : null;
          if (cur === undefined) return false;
        }
        return true;
      };
      for (const id of ids) {
        const n = byId.get(id);
        if (!n) continue;
        const parent = n.trashedFrom !== undefined ? n.trashedFrom : n.parentId;
        const parentOk = !parent || (byId.has(parent) && isAlive(parent));
        st.nodes.put({ ...n, deletedAt: 0, trashedFrom: null, parentId: parentOk ? parent || null : null, updatedAt: Date.now() });
      }
    };
  }, { durability: 'strict' });
}

/** Borrado definitivo (solo desde la papelera). Elimina también páginas, miniaturas y versiones. */
export async function deleteForever(ids) {
  await run([S.nodes, S.pages, S.thumbs, S.versions, S.pageSnaps], 'readwrite', st => {
    const req = st.nodes.getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      const doomed = descendantsOf(ids, all);
      for (const id of doomed) {
        const n = all.find(x => x.id === id);
        st.nodes.delete(id);
        if (n && n.kind === 'doc') {
          st.thumbs.delete(id);
          const pk = st.pages.index('docId').getAllKeys(id);
          pk.onsuccess = () => { for (const k of pk.result || []) st.pages.delete(k); };
          const vk = st.versions.index('docId').getAllKeys(id);
          vk.onsuccess = () => { for (const k of vk.result || []) st.versions.delete(k); };
          const sk = st.pageSnaps.index('docId').getAllKeys(id);
          sk.onsuccess = () => { for (const k of sk.result || []) st.pageSnaps.delete(k); };
        }
      }
    };
  }, { durability: 'strict' });
  await gcBlobs();
}

export async function emptyTrash() {
  const nodes = await loadAllNodes();
  const ids = nodes.filter(n => n.deletedAt).map(n => n.id);
  if (ids.length) await deleteForever(ids);
  return ids.length;
}

// ---------------------------------------------------------------------------
// Páginas
// ---------------------------------------------------------------------------

export async function loadPages(docId) {
  return getAllByIndex(S.pages, 'docId', docId);
}

export function loadPage(pageId) {
  return getOne(S.pages, pageId);
}

/**
 * Guarda en una sola transacción: nodo actualizado + páginas modificadas + páginas eliminadas.
 * Las páginas eliminadas quedan protegidas en el historial de versiones (se crea versión antes).
 */
export function saveDocument({ node, pages = [], deletedPageIds = [] }, { durability = 'relaxed' } = {}) {
  return run([S.nodes, S.pages], 'readwrite', st => {
    if (node) {
      const req = st.nodes.get(node.id);
      req.onsuccess = () => st.nodes.put(mergeLibraryFields(node, req.result));
    }
    for (const p of pages) st.pages.put(p);
    for (const id of deletedPageIds) st.pages.delete(id);
  }, { durability });
}

/**
 * Campos que gestiona la biblioteca (carpeta, papelera, favorito, miniatura). Un documento abierto
 * guarda su nodo entero, pero nunca debe pisar estos campos con su copia en memoria: podrían
 * haberse cambiado desde la biblioteca de otra pestaña mientras tanto.
 */
const LIBRARY_FIELDS = ['parentId', 'deletedAt', 'trashedFrom', 'favorite'];

function mergeLibraryFields(node, stored) {
  if (!stored) return node; // no existe (p. ej. se borró en otra pestaña): mejor recrearlo que perder cambios
  for (const k of LIBRARY_FIELDS) {
    if (k in stored) node[k] = stored[k];
    else delete node[k];
  }
  node.thumbRev = Math.max(stored.thumbRev || 0, node.thumbRev || 0);
  return node;
}

// ---------------------------------------------------------------------------
// Binarios
// ---------------------------------------------------------------------------

/** Guarda un binario inmutable. Devuelve su id (derivado del hash: sin duplicados). */
export async function putBlob(data, type) {
  let buffer;
  if (data instanceof ArrayBuffer) buffer = data;
  else if (ArrayBuffer.isView(data)) buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  else if (data && typeof data.arrayBuffer === 'function') buffer = await data.arrayBuffer();
  else throw new Error('Datos binarios no válidos');
  const hash = await sha256Hex(buffer);
  const id = hash ? `b_${hash.slice(0, 40)}` : uid('b');
  await run(S.blobs, 'readwrite', st => {
    const req = st.blobs.getKey(id);
    req.onsuccess = () => {
      if (req.result === undefined) {
        st.blobs.put({ id, type: type || 'application/octet-stream', size: buffer.byteLength, data: buffer, createdAt: Date.now() });
      }
    };
  }, { durability: 'strict' });
  return id;
}

export function getBlob(id) {
  return getOne(S.blobs, id);
}

/** Guarda un binario conservando su id (restauraciones). No sobrescribe si ya existe. */
export function putBlobWithId(id, data, type) {
  const buffer = data instanceof ArrayBuffer ? data : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return run(S.blobs, 'readwrite', st => {
    const req = st.blobs.getKey(id);
    req.onsuccess = () => {
      if (req.result === undefined) st.blobs.put({ id, type: type || 'application/octet-stream', size: buffer.byteLength, data: buffer, createdAt: Date.now() });
    };
  }, { durability: 'strict' });
}

export function hasBlob(id) {
  return run(S.blobs, 'readonly', st => {
    const req = st.blobs.getKey(id);
    return () => req.result !== undefined;
  });
}

/** Escribe un documento completo (nodo + páginas) tal cual, en una transacción (restauraciones). */
export function putDocumentRaw(node, pages) {
  return run([S.nodes, S.pages], 'readwrite', st => {
    st.nodes.put(node);
    for (const p of pages) st.pages.put(p);
  }, { durability: 'strict' });
}

/** Recolector de binarios: borra solo los que no referencia ninguna página, versión ni documento. */
export async function gcBlobs() {
  const referenced = new Set(pinnedBlobs);
  const collect = page => {
    if (!page) return;
    if (page.pdf && page.pdf.blobId) referenced.add(page.pdf.blobId);
    for (const img of page.images || []) if (img && img.blobId) referenced.add(img.blobId);
  };
  let removed = 0;
  await run([S.nodes, S.pages, S.pageSnaps, S.blobs, S.pdfText], 'readwrite', st => {
    const nodesReq = st.nodes.getAll();
    nodesReq.onsuccess = () => {
      for (const n of nodesReq.result || []) if (n.pdf && n.pdf.blobId) referenced.add(n.pdf.blobId);
      const pc = st.pages.openCursor();
      pc.onsuccess = () => {
        const c = pc.result;
        if (c) {
          collect(c.value);
          c.continue();
          return;
        }
        const sc = st.pageSnaps.openCursor();
        sc.onsuccess = () => {
          const c2 = sc.result;
          if (c2) {
            collect(c2.value && c2.value.page);
            c2.continue();
            return;
          }
          const keys = st.blobs.getAllKeys();
          keys.onsuccess = () => {
            for (const k of keys.result || []) {
              if (!referenced.has(k)) {
                st.blobs.delete(k);
                removed++;
              }
            }
          };
          // El texto indexado de PDFs que ya no existen también sobra.
          const tkeys = st.pdfText.getAllKeys();
          tkeys.onsuccess = () => {
            for (const k of tkeys.result || []) if (!referenced.has(k)) st.pdfText.delete(k);
          };
        };
      };
    };
    return () => removed;
  }, { durability: 'strict' });
  return removed;
}

// ---------------------------------------------------------------------------
// Miniaturas
// ---------------------------------------------------------------------------

export function putThumb(docId, data, type, rev) {
  return run([S.thumbs, S.nodes], 'readwrite', st => {
    st.thumbs.put({ id: docId, type, data, rev, updatedAt: Date.now() });
    const req = st.nodes.get(docId);
    req.onsuccess = () => {
      const n = req.result;
      if (n) st.nodes.put({ ...n, thumbRev: rev });
    };
  });
}

export function getThumb(docId) {
  return getOne(S.thumbs, docId);
}

// ---------------------------------------------------------------------------
// Versiones (historial de instantáneas)
// ---------------------------------------------------------------------------

/**
 * Crea una instantánea del estado GUARDADO del documento.
 * Las páginas sin cambios desde la versión anterior no se duplican (pageSnaps por id@rev).
 */
export function createVersion(docId, reason = 'Automática', { maxVersions = MAX_VERSIONS_PER_DOC } = {}) {
  return run([S.nodes, S.pages, S.versions, S.pageSnaps], 'readwrite', st => {
    let version = null;
    const nodeReq = st.nodes.get(docId);
    nodeReq.onsuccess = () => {
      const node = nodeReq.result;
      if (!node || node.kind !== 'doc') return;
      const pagesReq = st.pages.index('docId').getAll(docId);
      pagesReq.onsuccess = () => {
        const byId = new Map((pagesReq.result || []).map(p => [p.id, p]));
        const ordered = node.pages.map(ref => byId.get(ref.id)).filter(Boolean);
        const snapKeysReq = st.pageSnaps.index('docId').getAllKeys(docId);
        snapKeysReq.onsuccess = () => {
          const existing = new Set(snapKeysReq.result || []);
          const pageKeys = [];
          let strokes = 0;
          for (const p of ordered) {
            const key = `${p.id}@${p.rev || 0}`;
            pageKeys.push(key);
            strokes += (p.strokes || []).length;
            if (!existing.has(key)) {
              st.pageSnaps.put({ key, docId, page: p });
              existing.add(key);
            }
          }
          const { view, ...nodeCopy } = node;
          version = {
            id: uid('v'),
            docId,
            createdAt: Date.now(),
            reason,
            node: nodeCopy,
            pageKeys,
            pageCount: ordered.length,
            strokeCount: strokes
          };
          st.versions.put(version);
          // Poda: conservar las más recientes y liberar páginas que ya nadie referencia.
          const allV = st.versions.index('docId').getAll(docId);
          allV.onsuccess = () => {
            const list = (allV.result || []).sort((a, b) => b.createdAt - a.createdAt);
            const keep = list.slice(0, maxVersions);
            const drop = list.slice(maxVersions);
            for (const v of drop) st.versions.delete(v.id);
            const stillUsed = new Set();
            for (const v of keep) for (const k of v.pageKeys || []) stillUsed.add(k);
            for (const k of existing) if (!stillUsed.has(k)) st.pageSnaps.delete(k);
          };
        };
      };
    };
    return () => version;
  }, { durability: 'strict' });
}

export async function listVersions(docId) {
  const list = await getAllByIndex(S.versions, 'docId', docId);
  return list.sort((a, b) => b.createdAt - a.createdAt);
}

export function loadVersionPages(version) {
  return run(S.pageSnaps, 'readonly', st => {
    const out = new Array(version.pageKeys.length);
    version.pageKeys.forEach((key, i) => {
      const r = st.pageSnaps.get(key);
      r.onsuccess = () => { out[i] = r.result ? r.result.page : null; };
    });
    return () => out.filter(Boolean);
  });
}

/**
 * Restaura una versión. Antes guarda una instantánea del estado actual ("Antes de restaurar"),
 * de modo que la restauración también se puede deshacer.
 */
export async function restoreVersion(versionId) {
  const version = await getOne(S.versions, versionId);
  if (!version) throw new Error('La versión ya no existe');
  await createVersion(version.docId, 'Antes de restaurar');
  const pages = await loadVersionPages(version);
  const current = await getNode(version.docId);
  if (!current) throw new Error('El documento ya no existe');
  const currentPages = await loadPages(version.docId);
  const curRev = new Map(currentPages.map(p => [p.id, p.rev || 0]));
  const now = Date.now();
  // La revisión restaurada debe ser nueva para que su instantánea no se confunda con otra existente.
  const restoredPages = pages.map(p => ({ ...p, rev: Math.max(curRev.get(p.id) || 0, p.rev || 0) + 1, updatedAt: now }));
  const keepIds = new Set(restoredPages.map(p => p.id));
  const toDelete = current.pages.map(p => p.id).filter(id => !keepIds.has(id));
  const node = {
    ...current,
    name: version.node.name || current.name,
    // Marcadores tal como estaban en esa versión (si la versión es anterior a los marcadores, los actuales).
    bookmarks: (Array.isArray(version.node.bookmarks) ? version.node.bookmarks : current.bookmarks || []).filter(id => keepIds.has(id)),
    pages: restoredPages.map(p => ({ id: p.id, w: p.w, h: p.h })),
    updatedAt: now,
    rev: (current.rev || 0) + 1
  };
  await saveDocument({ node, pages: restoredPages, deletedPageIds: toDelete }, { durability: 'strict' });
  return node;
}

export function deleteVersion(id) {
  return run(S.versions, 'readwrite', st => { st.versions.delete(id); }, { durability: 'strict' });
}

// ---------------------------------------------------------------------------
// Duplicar
// ---------------------------------------------------------------------------

/** Duplica documentos y carpetas (recursivo). Los binarios se comparten, no se copian. */
export async function duplicateNodes(ids, targetParentId, { suffix = ' (copia)' } = {}) {
  const all = await loadAllNodes();
  const byId = new Map(all.map(n => [n.id, n]));
  const created = [];
  const now = Date.now();

  async function dupDoc(n, parentId, rename) {
    const pages = await loadPages(n.id);
    const byPage = new Map(pages.map(p => [p.id, p]));
    const newDocId = uid('d');
    const newPages = [];
    const idMap = new Map(); // id de página original -> id de la copia (para los marcadores)
    for (const ref of n.pages) {
      const p = byPage.get(ref.id);
      if (!p) continue;
      const newId = uid('p');
      idMap.set(ref.id, newId);
      newPages.push({
        ...p,
        id: newId,
        docId: newDocId,
        strokes: (p.strokes || []).map(s => ({ ...s, pts: new Float32Array(s.pts) })),
        images: (p.images || []).map(i => ({ ...i })),
        rev: 1,
        updatedAt: now
      });
    }
    const node = {
      ...n,
      id: newDocId,
      name: rename ? `${n.name}${suffix}` : n.name,
      parentId,
      createdAt: now,
      updatedAt: now,
      openedAt: 0,
      deletedAt: 0,
      trashedFrom: null,
      favorite: false,
      pages: newPages.map(p => ({ id: p.id, w: p.w, h: p.h })),
      bookmarks: (n.bookmarks || []).map(id => idMap.get(id)).filter(Boolean),
      rev: 1,
      thumbRev: 0
    };
    await run([S.nodes, S.pages], 'readwrite', st => {
      st.nodes.put(node);
      for (const p of newPages) st.pages.put(p);
    }, { durability: 'strict' });
    created.push(node);
    return node;
  }

  async function dupFolder(f, parentId, rename) {
    const folder = { ...f, id: uid('f'), name: rename ? `${f.name}${suffix}` : f.name, parentId, createdAt: now, updatedAt: now, deletedAt: 0, trashedFrom: null, favorite: false };
    await putNode(folder, { durability: 'strict' });
    created.push(folder);
    for (const child of all.filter(x => x.parentId === f.id && !x.deletedAt)) {
      if (child.kind === 'folder') await dupFolder(child, folder.id, false);
      else await dupDoc(child, folder.id, false);
    }
    return folder;
  }

  const results = [];
  for (const id of ids) {
    const n = byId.get(id);
    if (!n) continue;
    const parent = targetParentId !== undefined ? targetParentId : n.parentId;
    results.push(n.kind === 'folder' ? await dupFolder(n, parent || null, true) : await dupDoc(n, parent || null, true));
  }
  return { roots: results, created };
}

// ---------------------------------------------------------------------------
// Meta (ajustes internos)
// ---------------------------------------------------------------------------

export async function getMeta(key, fallback = null) {
  const row = await getOne(S.meta, key);
  return row ? row.value : fallback;
}

export function setMeta(key, value) {
  return run(S.meta, 'readwrite', st => { st.meta.put({ key, value }); }, { durability: 'strict' });
}

export async function counts() {
  return run([S.nodes, S.pages, S.blobs, S.versions], 'readonly', st => {
    const out = {};
    const a = st.nodes.getAll();
    a.onsuccess = () => {
      const nodes = a.result || [];
      out.folders = nodes.filter(n => n.kind === 'folder' && !n.deletedAt).length;
      out.docs = nodes.filter(n => n.kind === 'doc' && !n.deletedAt).length;
      out.trashed = nodes.filter(n => n.deletedAt).length;
    };
    const b = st.pages.count();
    b.onsuccess = () => { out.pages = b.result; };
    const c = st.blobs.count();
    c.onsuccess = () => { out.blobs = c.result; };
    const d = st.versions.count();
    d.onsuccess = () => { out.versions = d.result; };
    return () => out;
  });
}
