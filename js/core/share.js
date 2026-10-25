// Apuntes compartidos entre tablets: archivo .tstudio (por dentro, el mismo .zip que las copias de
// seguridad, solo con los documentos elegidos y sus PDF/imágenes). Quien lo recibe lo importa como una
// copia nueva y suya, editable como si lo hubiera creado él; nunca sustituye nada que ya tenga.

import * as repo from './repo.js';
import { writeBackup, restoreBackup, inspectBackup } from './backup.js';
import { ZipWriter, blobSink } from './zip.js';
import { sanitizeFileName } from './util.js';
import { flushAllSessions } from '../model/session.js';

export const SHARE_EXT = '.tstudio';
export const SHARE_MIME = 'application/x-tstudio';

export function isShareFileName(name) {
  return /\.tstudio$/i.test(name || '');
}

/** Crea el archivo .tstudio con esos documentos. Devuelve { blob, name, docs }. */
export async function buildShareFile(docIds, { onProgress = null } = {}) {
  await flushAllSessions().catch(() => false);
  let name = `Apuntes compartidos${SHARE_EXT}`;
  if (docIds.length === 1) {
    const n = await repo.getNode(docIds[0]);
    if (n) name = `${sanitizeFileName(n.name) || 'Apunte'}${SHARE_EXT}`;
  }
  const sink = blobSink(SHARE_MIME);
  const result = await writeBackup(new ZipWriter(sink), { docIds, onProgress, share: true });
  if (result.missing) throw new Error(`faltan ${result.missing} archivos (PDF o imágenes) de este documento en el dispositivo`);
  return { blob: sink.toBlob(), name, docs: result.docs };
}

/** ¿Es un archivo de Tablet Studio (apunte compartido o copia)? Mira el contenido, no el nombre. */
export async function looksLikeShareFile(file) {
  try {
    await inspectBackup(file);
    return true;
  } catch {
    return false;
  }
}

/** Importa un .tstudio dentro de la carpeta `parentId` (null = raíz). Devuelve el informe de restoreBackup. */
export async function importShareFile(file, parentId = null) {
  return restoreBackup(file, { mode: 'copy', into: parentId });
}
