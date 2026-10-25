// Errores y sugerencias que escriben los usuarios. Se guardan en una bandeja de salida local y se
// envían solos a FEEDBACK_ENDPOINT (POST JSON) cuando hay conexión; el usuario no manda ningún correo.
// Mientras FEEDBACK_ENDPOINT esté vacío, los mensajes esperan guardados en el dispositivo.

import * as repo from './repo.js';
import { settings } from './settings.js';
import { formatBytes } from './util.js';
import { APP_VERSION } from './version.js';

// POR DEFINIR: servicio que reenvía los mensajes al correo del autor (p. ej. un formulario de Formspree).
export const FEEDBACK_ENDPOINT = '';

const OUTBOX_KEY = 'tablet_studio_feedback_outbox';
const MAX_OUTBOX = 50;
const recentErrors = [];

/** Guarda los últimos errores no controlados para adjuntarlos a un informe de error. */
export function recordError(err) {
  const msg = (err && (err.stack || err.message || err.name)) || String(err);
  recentErrors.push(`${new Date().toISOString()} ${String(msg).slice(0, 600)}`);
  if (recentErrors.length > 10) recentErrors.shift();
}

export function getRecentErrors() {
  return recentErrors.slice();
}

export async function diagnosticText(app) {
  const counts = await repo.counts().catch(() => ({}));
  let est = {};
  try { est = await navigator.storage.estimate(); } catch {}
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  return [
    `Tablet Studio ${APP_VERSION}`,
    `Fecha: ${new Date().toISOString()}`,
    `Navegador: ${navigator.userAgent}`,
    `Pantalla: ${screen.width}x${screen.height} @${devicePixelRatio}x · ventana ${innerWidth}x${innerHeight}`,
    `Táctil: ${navigator.maxTouchPoints || 0} puntos · lápiz detectado: ${settings.get('penDetected')}`,
    `Instalada: ${standalone}`,
    `Persistente: ${app.persisted}`,
    `Uso: ${formatBytes(est.usage || 0)} / ${formatBytes(est.quota || 0)}`,
    `Datos: ${JSON.stringify(counts)}`
  ].join('\n');
}

function readOutbox() {
  try {
    const list = JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeOutbox(list) {
  try {
    localStorage.setItem(OUTBOX_KEY, JSON.stringify(list.slice(-MAX_OUTBOX)));
    return true;
  } catch {
    return false;
  }
}

export function pendingFeedback() {
  return readOutbox().length;
}

/** Añade un mensaje a la bandeja e intenta enviarlo. Devuelve 'sent', 'queued' o 'failed'. */
export async function submitFeedback({ kind, message, contact = '', diagnostic = '' }) {
  const item = {
    id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    kind,
    message,
    contact,
    diagnostic,
    version: APP_VERSION,
    date: new Date().toISOString()
  };
  if (!writeOutbox([...readOutbox(), item])) return 'failed';
  await flushFeedback();
  return readOutbox().some(x => x.id === item.id) ? 'queued' : 'sent';
}

let flushing = false;

/** Envía lo pendiente; lo que falle se queda en la bandeja para el siguiente intento. */
export async function flushFeedback() {
  if (!FEEDBACK_ENDPOINT || flushing || !navigator.onLine) return;
  flushing = true;
  try {
    for (const item of readOutbox()) {
      let ok = false;
      try {
        const res = await fetch(FEEDBACK_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({
            _subject: `[APUNTES-FREE] ${item.kind === 'bug' ? 'Error' : 'Sugerencia'} (${item.version})`,
            ...item
          })
        });
        ok = res.ok;
      } catch {}
      if (!ok) break;
      writeOutbox(readOutbox().filter(x => x.id !== item.id));
    }
  } finally {
    flushing = false;
  }
}
