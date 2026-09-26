// Copias de seguridad: exportar / restaurar (.zip) y copia automática en una carpeta del dispositivo.
//
// Formato del .zip (se puede abrir con cualquier programa):
//   manifest.json   información de la copia
//   nodes.json      carpetas y documentos
//   pages/<id>.json páginas de cada documento (trazos, imágenes, fondo)
//   blobs/…         PDF originales e imágenes, sin modificar
//   indice.txt      lista legible de documentos y dónde está cada PDF

import * as repo from './repo.js';
import { settings } from './settings.js';
import { ZipWriter, ZipReader, blobSink } from './zip.js';
import { strokeToJSON, normalizeStroke, normalizeImage } from '../model/stroke.js';
import { normalizeBg } from '../model/paper.js';
import { uid, cleanName, sanitizeFileName } from './util.js';
import { flushAllSessions, allSessions } from '../model/session.js';
import { downloadBlob } from '../export/save.js';
import { toast } from '../ui/toast.js';
import { alertDialog } from '../ui/modal.js';

export const BACKUP_FORMAT = 'tablet-studio-backup';
const EXT = { 'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif' };

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function pageToJSON(p) {
  return {
    id: p.id,
    docId: p.docId,
    w: p.w,
    h: p.h,
    bg: p.bg,
    pdf: p.pdf || null,
    strokes: (p.strokes || []).map(strokeToJSON),
    images: (p.images || []).map(i => ({ ...i })),
    rev: p.rev || 0,
    updatedAt: p.updatedAt || 0
  };
}

/**
 * Escribe una copia en `writer`. Si hay sesiones abiertas se usa su estado en memoria
 * (lo más reciente, incluso si el guardado en disco hubiera fallado).
 */
export async function writeBackup(writer, { docIds = null, onProgress = null } = {}) {
  const allNodes = await repo.loadAllNodes();
  const byId = new Map(allNodes.map(n => [n.id, n]));
  let nodes = allNodes;
  if (docIds) {
    const keep = new Set();
    for (const id of docIds) {
      let cur = byId.get(id);
      while (cur && !keep.has(cur.id)) {
        keep.add(cur.id);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
    }
    nodes = allNodes.filter(n => keep.has(n.id));
  }
  const sessions = new Map(allSessions().map(s => [s.id, s]));
  const docs = nodes.filter(n => n.kind === 'doc');
  const blobIds = new Set();
  const nodesOut = [];
  const index = [];
  let done = 0;
  const total = docs.length;
  for (const d of docs) {
    let node = d;
    let pages;
    const s = sessions.get(d.id);
    if (s) {
      pages = await s.loadAllPages();
      node = { ...s.node };
    } else {
      const recs = await repo.loadPages(d.id);
      const map = new Map(recs.map(p => [p.id, p]));
      pages = node.pages.map(r => map.get(r.id)).filter(Boolean);
    }
    for (const p of pages) {
      if (p.pdf && p.pdf.blobId) blobIds.add(p.pdf.blobId);
      for (const img of p.images || []) if (img.blobId) blobIds.add(img.blobId);
    }
    if (node.pdf && node.pdf.blobId) blobIds.add(node.pdf.blobId);
    await writer.add(`pages/${d.id}.json`, JSON.stringify(pages.map(pageToJSON)));
    const { view, ...clean } = node;
    nodesOut.push(clean);
    index.push({ node, pages: pages.length });
    done++;
    if (onProgress) onProgress(done, total, 'docs');
  }
  for (const n of nodes) if (n.kind === 'folder') nodesOut.push(n);
  const blobIndex = [];
  const missing = [];
  let bdone = 0;
  for (const id of blobIds) {
    const b = await repo.getBlob(id);
    bdone++;
    if (onProgress) onProgress(bdone, blobIds.size, 'blobs');
    if (!b || !b.data) {
      missing.push(id);
      continue;
    }
    const file = `blobs/${id}.${EXT[b.type] || 'bin'}`;
    await writer.add(file, new Uint8Array(b.data), { compress: !/^image\/(jpeg|png|webp)|pdf/.test(b.type || '') });
    blobIndex.push({ id, type: b.type, size: b.size, file });
  }
  await writer.add('nodes.json', JSON.stringify(nodesOut));
  await writer.add('blobs.json', JSON.stringify(blobIndex));
  await writer.add('settings.json', JSON.stringify(settings.exportable()));
  // Índice legible para humanos.
  const pathOf = n => {
    const parts = [];
    let cur = n.parentId ? byId.get(n.parentId) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : null;
    }
    return parts.join(' / ');
  };
  const lines = ['COPIA DE SEGURIDAD DE TABLET STUDIO', `Fecha: ${new Date().toLocaleString('es-ES')}`, '',
    'Para restaurarla: abre la app → Ajustes → Copias de seguridad → Restaurar copia.', '',
    'DOCUMENTOS:'];
  for (const { node, pages } of index) {
    const pdf = node.pdf && node.pdf.blobId ? blobIndex.find(b => b.id === node.pdf.blobId) : null;
    lines.push(`- ${pathOf(node) ? pathOf(node) + ' / ' : ''}${node.name} (${pages} pág.)${node.deletedAt ? ' [en la papelera]' : ''}${pdf ? ` → PDF original: ${pdf.file}` : ''}`);
  }
  await writer.add('indice.txt', lines.join('\r\n'));
  await writer.add('manifest.json', JSON.stringify({
    format: BACKUP_FORMAT,
    version: 1,
    app: 'Tablet Studio',
    createdAt: Date.now(),
    partial: !!docIds,
    counts: { docs: docs.length, folders: nodesOut.length - docs.length, blobs: blobIndex.length },
    missingBlobs: missing
  }, null, 2));
  await writer.finish();
  return { docs: docs.length, blobs: blobIndex.length, missing: missing.length };
}

/** Exporta una copia (completa o de algunos documentos) y la guarda donde elija el usuario. */
export async function exportBackup({ docIds = null } = {}) {
  let name = `Tablet Studio - copia ${stamp()}.zip`;
  if (docIds && docIds.length === 1) {
    const n = await repo.getNode(docIds[0]);
    if (n) name = `${sanitizeFileName(n.name)} - copia ${stamp()}.zip`;
  }
  // El selector nativo exige un gesto del usuario: se abre ANTES de cualquier trabajo largo.
  let writable = null;
  if (typeof window.showSaveFilePicker === 'function' && window.self === window.top) {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Copia de seguridad', accept: { 'application/zip': ['.zip'] } }] });
      writable = await handle.createWritable();
    } catch (err) {
      if (err && err.name === 'AbortError') return null;
      writable = null;
    }
  }
  const stop = toast('Preparando copia de seguridad…', { duration: 0 });
  try {
    await flushAllSessions().catch(() => false);
    let result;
    if (writable) {
      const writer = new ZipWriter({ write: c => writable.write(c), close: () => writable.close() });
      try {
        result = await writeBackup(writer, { docIds });
      } catch (err) {
        try { await writable.abort(); } catch {}
        throw err;
      }
    } else {
      const sink = blobSink();
      const writer = new ZipWriter(sink);
      result = await writeBackup(writer, { docIds });
      downloadBlob(sink.toBlob(), name);
    }
    if (!docIds) {
      const meta = await repo.getMeta('backup', {});
      await repo.setMeta('backup', { ...meta, lastAt: Date.now() });
    }
    toast(`Copia creada: ${result.docs} documento${result.docs === 1 ? '' : 's'}${result.missing ? ` (faltan ${result.missing} archivos)` : ''}`, { type: 'success', duration: 4500 });
    return result;
  } catch (err) {
    console.error(err);
    await alertDialog(`No se pudo crear la copia: ${err.message || err}`, 'Error');
    return null;
  } finally {
    stop();
  }
}

// ---------------------------------------------------------------------------
// Restaurar
// ---------------------------------------------------------------------------

export async function inspectBackup(file) {
  const zr = new ZipReader(file);
  const manifest = await zr.readJSON('manifest.json');
  if (!manifest || manifest.format !== BACKUP_FORMAT) throw new Error('Este archivo no es una copia de seguridad de Tablet Studio.');
  return { zr, manifest };
}

/**
 * Restaura una copia.
 *  mode 'merge': añade lo que falta; NUNCA sobrescribe documentos existentes.
 *  mode 'copy':  importa todo como copia dentro de una carpeta nueva.
 */
export async function restoreBackup(file, { mode = 'merge', applySettings = false, onProgress = null } = {}) {
  const { zr, manifest } = await inspectBackup(file);
  const nodes = (await zr.readJSON('nodes.json')) || [];
  const blobs = (await zr.readJSON('blobs.json')) || [];
  const existing = new Map((await repo.loadAllNodes()).map(n => [n.id, n]));
  const report = { folders: 0, docs: 0, pages: 0, skipped: 0, blobs: 0, errors: [] };

  // 1) Binarios primero (así ninguna página queda apuntando a algo inexistente).
  let i = 0;
  for (const b of blobs) {
    i++;
    if (onProgress) onProgress(i, blobs.length, 'blobs');
    try {
      if (await repo.hasBlob(b.id)) continue;
      const data = await zr.read(b.file);
      if (data) {
        await repo.putBlobWithId(b.id, data, b.type);
        report.blobs++;
      }
    } catch (err) {
      report.errors.push(`Archivo ${b.file}: ${err.message}`);
    }
  }

  const importNodes = mode === 'copy' ? nodes.filter(n => !n.deletedAt) : nodes;
  const idMap = new Map();
  let rootFolder = null;
  if (mode === 'copy') {
    rootFolder = await repo.createFolder({ name: `Copia restaurada ${new Date(manifest.createdAt || Date.now()).toLocaleDateString('es-ES')}`, color: '#64748b' });
    for (const n of importNodes) idMap.set(n.id, n.kind === 'folder' ? uid('f') : uid('d'));
  }
  const importedIds = new Set(importNodes.map(n => n.id));
  const mapParent = pid => {
    if (mode === 'copy') return pid && idMap.has(pid) ? idMap.get(pid) : rootFolder.id;
    if (!pid) return null;
    return existing.has(pid) || importedIds.has(pid) ? pid : null;
  };

  // 2) Carpetas.
  for (const n of importNodes.filter(x => x.kind === 'folder')) {
    if (mode === 'merge' && existing.has(n.id)) {
      report.skipped++;
      continue;
    }
    const folder = { ...n, id: mode === 'copy' ? idMap.get(n.id) : n.id, name: cleanName(n.name, 'Carpeta'), parentId: mapParent(n.parentId) };
    await repo.putNode(folder, { durability: 'strict' });
    report.folders++;
  }

  // 3) Documentos con sus páginas.
  const docs = importNodes.filter(x => x.kind === 'doc');
  let d = 0;
  for (const n of docs) {
    d++;
    if (onProgress) onProgress(d, docs.length, 'docs');
    if (mode === 'merge' && existing.has(n.id)) {
      report.skipped++;
      continue;
    }
    try {
      const raw = (await zr.readJSON(`pages/${n.id}.json`)) || [];
      const newDocId = mode === 'copy' ? idMap.get(n.id) : n.id;
      const pages = raw.map(p => ({
        id: mode === 'copy' ? uid('p') : p.id,
        docId: newDocId,
        w: p.w,
        h: p.h,
        bg: normalizeBg(p.bg),
        pdf: p.pdf || null,
        strokes: (p.strokes || []).map(normalizeStroke).filter(Boolean),
        images: (p.images || []).map(normalizeImage).filter(Boolean),
        rev: (p.rev || 0) + 1,
        updatedAt: p.updatedAt || Date.now()
      }));
      if (!pages.length) {
        report.errors.push(`«${n.name}» no tenía páginas en la copia`);
        continue;
      }
      const node = {
        ...n,
        id: newDocId,
        name: cleanName(n.name),
        parentId: mapParent(n.parentId),
        pages: pages.map(p => ({ id: p.id, w: p.w, h: p.h })),
        thumbRev: 0,
        rev: (n.rev || 0) + 1
      };
      await repo.putDocumentRaw(node, pages);
      report.docs++;
      report.pages += pages.length;
    } catch (err) {
      report.errors.push(`«${n.name}»: ${err.message}`);
    }
  }
  if (applySettings) {
    const s = await zr.readJSON('settings.json').catch(() => null);
    if (s) settings.importFrom(s);
  }
  return report;
}

// ---------------------------------------------------------------------------
// Copia automática en una carpeta del dispositivo (File System Access API)
// ---------------------------------------------------------------------------

export const autoBackupSupported = () => typeof window.showDirectoryPicker === 'function' && window.self === window.top;

export async function getAutoBackup() {
  return (await repo.getMeta('autoBackup', null)) || { enabled: false, keep: 5, everyHours: 6 };
}

export async function chooseAutoBackupFolder() {
  const handle = await window.showDirectoryPicker({ id: 'tablet-studio-backups', mode: 'readwrite', startIn: 'documents' });
  const cfg = await getAutoBackup();
  const next = { ...cfg, enabled: true, dirHandle: handle, dirName: handle.name };
  await repo.setMeta('autoBackup', next);
  return next;
}

export async function disableAutoBackup() {
  const cfg = await getAutoBackup();
  await repo.setMeta('autoBackup', { ...cfg, enabled: false });
}

async function hasPermission(handle, request) {
  if (!handle || typeof handle.queryPermission !== 'function') return false;
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (request && typeof handle.requestPermission === 'function') return (await handle.requestPermission(opts)) === 'granted';
  return false;
}

/**
 * Hace la copia automática si toca. Devuelve 'done' | 'skipped' | 'need-permission' | 'error'.
 * Solo borra copias automáticas antiguas creadas por la propia app (nunca otros archivos).
 */
export async function runAutoBackup({ force = false, userGesture = false } = {}) {
  const cfg = await getAutoBackup();
  if (!cfg.enabled || !cfg.dirHandle) return 'skipped';
  const nodes = await repo.loadAllNodes();
  const lastChange = Math.max(0, ...nodes.map(n => n.updatedAt || 0));
  if (!force) {
    if (cfg.lastAt && Date.now() - cfg.lastAt < (cfg.everyHours || 6) * 3600000) return 'skipped';
    if (cfg.lastAt && lastChange <= cfg.lastAt) return 'skipped';
    if (!nodes.some(n => n.kind === 'doc')) return 'skipped';
  }
  try {
    if (!(await hasPermission(cfg.dirHandle, userGesture))) return 'need-permission';
    await flushAllSessions().catch(() => false);
    const name = `Tablet Studio - copia automática ${stamp()}.zip`;
    const fh = await cfg.dirHandle.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    const writer = new ZipWriter({ write: c => w.write(c), close: () => w.close() });
    try {
      await writeBackup(writer);
    } catch (err) {
      try { await w.abort(); } catch {}
      try { await cfg.dirHandle.removeEntry(name); } catch {}
      throw err;
    }
    // Rotación: conservar las N copias automáticas más recientes.
    const ours = [];
    for await (const entry of cfg.dirHandle.values()) {
      if (entry.kind === 'file' && /^Tablet Studio - copia automática \d{4}-\d{2}-\d{2}_\d{4}\.zip$/.test(entry.name)) ours.push(entry.name);
    }
    ours.sort().reverse();
    for (const old of ours.slice(Math.max(2, cfg.keep || 5))) {
      try { await cfg.dirHandle.removeEntry(old); } catch {}
    }
    await repo.setMeta('autoBackup', { ...cfg, lastAt: Date.now(), lastError: null });
    const meta = await repo.getMeta('backup', {});
    await repo.setMeta('backup', { ...meta, lastAt: Date.now() });
    return 'done';
  } catch (err) {
    console.error('Copia automática fallida', err);
    await repo.setMeta('autoBackup', { ...cfg, lastError: String(err && err.message || err) });
    return 'error';
  }
}
