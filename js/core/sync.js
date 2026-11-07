// Cuenta de Google: sincroniza ajustes y bolis guardados entre dispositivos a través de tu Drive.
//
// - Un archivo JSON en la carpeta de la app en Drive con los valores y cuándo cambió cada uno.
// - Fusión por ajuste: gana el cambio más reciente, venga de donde venga. Nada se borra.
// - Sin sesión de Google activa (dura ~1 hora) los cambios quedan pendientes y se suben al reconectar.
// - Los apuntes no viajan aquí (siguen en la copia de Drive); ver gdrive.js.

import { settings } from './settings.js';
import * as gdrive from './gdrive.js';

export const SETTINGS_FILE = 'Apunteo - ajustes.json';
const FILE = SETTINGS_FILE;
const UPLOAD_DELAY = 4000;

let timer = null;
let running = null;
const listeners = new Set();

/** Avisa a la interfaz (Ajustes) de cambios en el estado de la sincronización. */
export function onSyncState(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify() {
  for (const fn of listeners) {
    try { fn(); } catch {}
  }
}

export async function syncEnabled() {
  const cfg = await gdrive.getDriveConfig();
  return !!(cfg.clientId && cfg.connected && cfg.syncSettings !== false);
}

/**
 * Sincroniza ahora (necesita sesión de Google activa). Devuelve { adopted, uploaded }.
 * Lanza err.code === 'AUTH' si hay que volver a entrar.
 */
export function syncSettingsNow() {
  if (!running) running = doSync().finally(() => { running = null; });
  return running;
}

async function doSync() {
  clearTimeout(timer);
  const remote = await gdrive.readAppJson(FILE);
  const local = settings.syncSnapshot();
  const rValues = (remote && remote.values) || {};
  const rStamps = (remote && remote.stamps) || {};
  const adoptV = {};
  const adoptS = {};
  let needUpload = !remote;
  for (const k of Object.keys(local.values)) {
    const rt = Number(rStamps[k]) || 0;
    const lt = local.stamps[k];
    if (k in rValues && rt > lt) {
      adoptV[k] = rValues[k];
      adoptS[k] = rt;
    } else if (!(k in rValues) || lt > rt) {
      needUpload = true;
    }
  }
  const adopted = Object.keys(adoptV);
  if (adopted.length) {
    settings.adoptSynced(adoptV, adoptS);
    import('./toolhistory.js').then(m => m.logSettings(`Sincronizar: traído de la cuenta ${adopted.join(', ')}`)).catch(() => {});
  }
  if (needUpload) {
    // Ajustes sin fecha (de antes de las cuentas): marca 1 = «muy antiguos». Así cualquier cambio real
    // de otro dispositivo gana, pero un dispositivo recién estrenado (marca 0) sí los adopta.
    const unstamped = Object.keys(local.values).filter(k => !(k in adoptV) && !local.stamps[k]);
    if (unstamped.length) settings.stamp(unstamped, 1);
    const now = settings.syncSnapshot();
    await gdrive.writeAppJson(FILE, { app: 'apunteo', v: 1, savedAt: Date.now(), values: now.values, stamps: now.stamps });
  }
  await gdrive.setDriveConfig({ settingsSyncedAt: Date.now(), settingsPending: false, settingsError: null });
  notify();
  return { adopted: adopted.length, uploaded: needUpload };
}

/** Sincroniza si hay sesión; si no, deja el cambio pendiente para la próxima vez. */
export async function syncIfPossible() {
  if (!(await syncEnabled())) return null;
  if (!gdrive.hasValidToken()) {
    await gdrive.setDriveConfig({ settingsPending: true });
    notify();
    return null;
  }
  try {
    return await syncSettingsNow();
  } catch (err) {
    console.warn('No se pudieron sincronizar los ajustes', err);
    await gdrive.setDriveConfig(err.code === 'AUTH' ? { settingsPending: true } : { settingsPending: true, settingsError: String(err.message || err) }).catch(() => {});
    notify();
    return null;
  }
}

/** Arranca la sincronización automática: sube los cambios locales y trae los de otros dispositivos al volver a la app. */
export function startSettingsSync() {
  settings.on('change', e => {
    if (!e || e.synced || e.key === 'penDetected' || e.key === 'openTabs') return;
    clearTimeout(timer);
    timer = setTimeout(() => syncIfPossible(), UPLOAD_DELAY);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && gdrive.hasValidToken()) syncIfPossible();
  });
}
