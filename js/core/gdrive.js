// Copia de seguridad en Google Drive.
//
// - Inicio de sesión con Google Identity Services (se carga solo al usarlo).
// - Permiso mínimo «drive.file»: la app solo ve los archivos que ella misma crea; nunca el resto de tu Drive.
// - Las copias (.zip, el mismo formato que «Crear copia») van a la carpeta «Tablet Studio - copias».
// - Rotación: se conservan las más recientes; las antiguas se envían a la PAPELERA de Drive (recuperables).
// - Una web sin servidor no puede guardar un permiso permanente: la sesión de Google dura ~1 hora.
//   Mientras dura, la copia automática se hace sola; si caducó, la app avisa y basta un toque.

import * as repo from './repo.js';
import { ZipWriter, blobSink } from './zip.js';
import { writeBackup } from './backup.js';
import { flushAllSessions } from '../model/session.js';

const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const FOLDER_NAME = 'Tablet Studio - copias';
const FILE_PREFIX = 'Tablet Studio - copia ';
const API = 'https://www.googleapis.com/drive/v3/';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
const CHUNK = 8 * 1024 * 1024; // múltiplo de 256 KiB, como exige Google

export const CLIENT_ID_RE = /^[0-9]+-[a-z0-9]+\.apps\.googleusercontent\.com$/i;

let token = null; // { value, expiresAt } — solo en memoria, nunca se guarda
let gisPromise = null;

// ---------------------------------------------------------------------------
// Configuración (en la base de datos de la app, sin datos secretos)
// ---------------------------------------------------------------------------

export async function getDriveConfig() {
  return { clientId: '', auto: true, everyHours: 24, keep: 10, folderId: null, connected: false, lastAt: 0, lastSize: 0, lastError: null, ...((await repo.getMeta('gdrive', null)) || {}) };
}

export async function setDriveConfig(patch) {
  const cfg = { ...(await getDriveConfig()), ...patch };
  await repo.setMeta('gdrive', cfg);
  return cfg;
}

// ---------------------------------------------------------------------------
// Sesión de Google
// ---------------------------------------------------------------------------

/** Carga la librería de inicio de sesión de Google (una vez). */
export function loadGoogleIdentity() {
  if (globalThis.google && google.accounts && google.accounts.oauth2) return Promise.resolve();
  if (!gisPromise) {
    gisPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://accounts.google.com/gsi/client';
      s.async = true;
      s.onload = () => resolve();
      s.onerror = () => {
        gisPromise = null;
        s.remove();
        reject(new Error('No se pudo cargar el inicio de sesión de Google. ¿Hay conexión a internet?'));
      };
      document.head.appendChild(s);
    });
  }
  return gisPromise;
}

export function hasValidToken() {
  return !!(token && Date.now() < token.expiresAt);
}

/**
 * Pide permiso a Google (abre su ventana). Debe llamarse justo después de un toque del usuario,
 * o el navegador bloqueará la ventana emergente.
 */
export async function connectDrive(clientId, { consent = false } = {}) {
  if (!CLIENT_ID_RE.test(clientId || '')) throw new Error('El ID de cliente no tiene el formato correcto (termina en .apps.googleusercontent.com).');
  await loadGoogleIdentity();
  const value = await new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: resp => {
        if (!resp || resp.error) {
          reject(new Error(resp && (resp.error_description || resp.error) || 'Google no concedió el permiso'));
          return;
        }
        token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000 - 60000 };
        resolve(token.value);
      },
      error_callback: err => {
        const type = err && err.type;
        reject(new Error(type === 'popup_closed' ? 'Se cerró la ventana de Google sin terminar' : type === 'popup_failed_to_open' ? 'El navegador bloqueó la ventana de Google. Vuelve a tocar el botón.' : (err && err.message) || 'No se pudo iniciar sesión con Google'));
      }
    });
    client.requestAccessToken({ prompt: consent ? 'consent' : '' });
  });
  return value;
}

export function disconnectDrive() {
  try {
    if (token && globalThis.google && google.accounts && google.accounts.oauth2) google.accounts.oauth2.revoke(token.value, () => {});
  } catch {}
  token = null;
}

// ---------------------------------------------------------------------------
// API de Drive
// ---------------------------------------------------------------------------

async function api(url, { method = 'GET', headers = {}, body, query } = {}) {
  if (!hasValidToken()) throw Object.assign(new Error('Hay que volver a conectar con Google'), { code: 'AUTH' });
  const u = new URL(url.startsWith('http') ? url : API + url);
  if (query) for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  const res = await fetch(u, { method, headers: { Authorization: `Bearer ${token.value}`, ...headers }, body });
  if (res.status === 401) {
    token = null;
    throw Object.assign(new Error('La sesión de Google ha caducado'), { code: 'AUTH' });
  }
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try {
      const j = await res.json();
      if (j && j.error && j.error.message) msg = j.error.message;
    } catch {}
    throw new Error(`Google Drive: ${msg}`);
  }
  return res;
}

/** Carpeta de copias (creada por la app; con drive.file solo se ven las carpetas propias). */
async function ensureFolder(cfg) {
  if (cfg.folderId) {
    try {
      const r = await api(`files/${encodeURIComponent(cfg.folderId)}`, { query: { fields: 'id,trashed' } });
      const j = await r.json();
      if (j && j.id && !j.trashed) return j.id;
    } catch (err) {
      if (err.code === 'AUTH') throw err;
    }
  }
  const q = `mimeType='application/vnd.google-apps.folder' and name='${FOLDER_NAME}' and trashed=false`;
  const r = await api('files', { query: { q, fields: 'files(id,name)', spaces: 'drive', pageSize: '10' } });
  const found = (await r.json()).files || [];
  if (found.length) return found[0].id;
  const c = await api('files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    query: { fields: 'id' },
    body: JSON.stringify({ name: FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' })
  });
  return (await c.json()).id;
}

/** Subida reanudable por trozos (sirve para copias grandes y conexiones inestables). */
async function upload(blob, name, folderId, onProgress) {
  const init = await api(UPLOAD, {
    method: 'POST',
    query: { uploadType: 'resumable', fields: 'id,name,size,createdTime' },
    headers: {
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': 'application/zip',
      'X-Upload-Content-Length': String(blob.size)
    },
    body: JSON.stringify({ name, parents: [folderId], mimeType: 'application/zip', description: 'Copia de seguridad de Tablet Studio (se restaura desde Ajustes → Copias de seguridad).' })
  });
  const session = init.headers.get('Location');
  if (!session) throw new Error('Google Drive no devolvió la dirección de subida');
  let offset = 0;
  let retries = 0;
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK);
    let res;
    try {
      res = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes ${offset}-${end - 1}/${blob.size}` }, body: blob.slice(offset, end) });
    } catch (err) {
      // Corte de red: se pregunta a Google cuánto recibió y se sigue desde ahí.
      if (++retries > 5) throw new Error('Se perdió la conexión durante la subida');
      await new Promise(r => setTimeout(r, 1500 * retries));
      const probe = await fetch(session, { method: 'PUT', headers: { 'Content-Range': `bytes */${blob.size}` } }).catch(() => null);
      if (probe && probe.status === 308) {
        const range = probe.headers.get('Range');
        offset = range ? Number(range.split('-')[1]) + 1 : offset;
      } else if (probe && probe.ok) {
        return probe.json();
      }
      continue;
    }
    if (res.status === 308) {
      const range = res.headers.get('Range');
      offset = range ? Number(range.split('-')[1]) + 1 : end;
      retries = 0;
      if (onProgress) onProgress(offset, blob.size);
    } else if (res.ok) {
      if (onProgress) onProgress(blob.size, blob.size);
      return res.json();
    } else if (res.status >= 500 && ++retries <= 5) {
      await new Promise(r => setTimeout(r, 1500 * retries));
    } else {
      throw new Error(`Google Drive rechazó la subida (${res.status})`);
    }
  }
  throw new Error('La subida no terminó correctamente');
}

/** Copias de la app en Drive, de la más reciente a la más antigua. */
export async function listDriveBackups() {
  const cfg = await getDriveConfig();
  const folderId = await ensureFolder(cfg);
  if (folderId !== cfg.folderId) await setDriveConfig({ folderId });
  const q = `'${folderId}' in parents and trashed=false`;
  const r = await api('files', { query: { q, orderBy: 'createdTime desc', fields: 'files(id,name,size,createdTime)', pageSize: '100', spaces: 'drive' } });
  return ((await r.json()).files || []).filter(f => f.name && f.name.startsWith(FILE_PREFIX));
}

/** Descarga una copia de Drive como archivo, lista para restaurar. */
export async function downloadDriveBackup(file) {
  const r = await api(`files/${encodeURIComponent(file.id)}`, { query: { alt: 'media' } });
  const blob = await r.blob();
  return new File([blob], file.name, { type: 'application/zip' });
}

/** Envía a la papelera de Drive las copias que sobran (se pueden recuperar allí durante 30 días). */
async function rotate(keep) {
  const files = await listDriveBackups();
  for (const f of files.slice(Math.max(2, keep))) {
    try {
      await api(`files/${encodeURIComponent(f.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ trashed: true }) });
    } catch (err) {
      if (err.code === 'AUTH') throw err;
    }
  }
}

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

/**
 * Hace una copia completa y la sube a Drive. Devuelve { name, size } o lanza un error
 * (err.code === 'AUTH' si hay que volver a conectar).
 */
export async function backupToDrive({ onProgress } = {}) {
  const cfg = await getDriveConfig();
  if (!hasValidToken()) throw Object.assign(new Error('Hay que conectar con Google'), { code: 'AUTH' });
  try {
    await flushAllSessions().catch(() => false);
    const sink = blobSink();
    await writeBackup(new ZipWriter(sink), { onProgress: (a, b, what) => onProgress && onProgress({ phase: what === 'blobs' ? 'files' : 'docs', done: a, total: b }) });
    const blob = sink.toBlob();
    const folderId = await ensureFolder(cfg);
    const name = `${FILE_PREFIX}${stamp()}.zip`;
    await upload(blob, name, folderId, (done, total) => onProgress && onProgress({ phase: 'upload', done, total }));
    await setDriveConfig({ connected: true, folderId, lastAt: Date.now(), lastSize: blob.size, lastError: null });
    const meta = await repo.getMeta('backup', {});
    await repo.setMeta('backup', { ...meta, lastAt: Date.now() });
    try {
      await rotate(cfg.keep || 10);
    } catch (err) {
      console.warn('No se pudieron retirar copias antiguas de Drive', err);
    }
    return { name, size: blob.size };
  } catch (err) {
    await setDriveConfig({ lastError: String(err && err.message || err) }).catch(() => {});
    throw err;
  }
}

/** ¿Toca copia automática? (activada, pasó el intervalo y hubo cambios desde la última). */
export async function driveBackupDue() {
  const cfg = await getDriveConfig();
  if (!cfg.clientId || !cfg.auto || !cfg.connected) return false;
  if (cfg.lastAt && Date.now() - cfg.lastAt < (cfg.everyHours || 24) * 3600000) return false;
  const nodes = await repo.loadAllNodes();
  if (!nodes.some(n => n.kind === 'doc')) return false;
  const lastChange = Math.max(0, ...nodes.map(n => n.updatedAt || 0));
  return !cfg.lastAt || lastChange > cfg.lastAt;
}
