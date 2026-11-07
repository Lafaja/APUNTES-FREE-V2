// Historial de la configuración de herramientas: método de la barra, bolis, grosores, colores, qué sale en
// la barra y en el menú circular… Se guarda en la base de datos de la app (no en localStorage) para poder
// recuperarla si algún día se pierde o se sobrescribe. También anota cuándo y por qué cambia (diagnóstico).

import { settings } from './settings.js';
import * as repo from './repo.js';

export const TOOL_KEYS = ['toolbarMode', 'kit', 'layouts', 'presets', 'activePresetId', 'favColors', 'shape', 'eraser'];
const HISTORY = 'toolHistory';
const LOG = 'settingsLog';
const MAX = 20;
const MAX_LOG = 40;
let timer = null;
let reasonNext = null;

export function snapshotTools() {
  const o = {};
  for (const k of TOOL_KEYS) o[k] = JSON.parse(JSON.stringify(settings.get(k) ?? null));
  return o;
}

const differing = (a, b) => TOOL_KEYS.filter(k => JSON.stringify(a ? a[k] : null) !== JSON.stringify(b ? b[k] : null));

/** Apunta un suceso en el registro de ajustes (se adjunta al «Copiar diagnóstico»). */
export async function logSettings(text) {
  try {
    const list = (await repo.getMeta(LOG, [])) || [];
    list.push(`${new Date().toISOString()} ${text}`);
    await repo.setMeta(LOG, list.slice(-MAX_LOG));
  } catch {}
}

export async function settingsLog() {
  return (await repo.getMeta(LOG, [])) || [];
}

/** Guarda la configuración actual si es distinta de la última guardada. */
export async function recordTools(reason) {
  try {
    const list = (await repo.getMeta(HISTORY, [])) || [];
    const snap = snapshotTools();
    const last = list[list.length - 1];
    if (last && !differing(last.data, snap).length) return;
    list.push({ at: Date.now(), reason, data: snap });
    await repo.setMeta(HISTORY, list.slice(-MAX));
  } catch (err) {
    console.warn('No se pudo guardar el historial de herramientas', err);
  }
}

/** Historial, del más reciente al más antiguo. */
export async function toolHistory() {
  return ((await repo.getMeta(HISTORY, [])) || []).slice().reverse();
}

/** Vuelve a una configuración guardada (lo de ahora queda antes en el historial). */
export async function applyTools(data, reason) {
  await recordTools('antes de recuperar');
  const o = {};
  for (const k of TOOL_KEYS) if (data && k in data && data[k] !== null) o[k] = data[k];
  settings.applyPartial(o);
  await logSettings(`Recuperada la configuración de herramientas (${reason}): ${Object.keys(o).join(', ')}`);
  reasonNext = 'recuperada';
  await recordTools('recuperada');
}

/**
 * Arranque: si la configuración de herramientas no es la última que se guardó desde la app (algo la cambió
 * o la borró por fuera), se vuelve a poner sola. Devuelve { restored: [claves] } para avisar al usuario.
 * Después, cada cambio se guarda enseguida (y al salir de la app).
 */
export async function startToolHistory() {
  let restored = [];
  try {
    const list = (await repo.getMeta(HISTORY, [])) || [];
    const last = list[list.length - 1];
    const diff = last ? differing(last.data, snapshotTools()) : [];
    if (diff.length) {
      const o = {};
      for (const k of diff) if (last.data[k] !== null && last.data[k] !== undefined) o[k] = last.data[k];
      restored = Object.keys(o);
      if (restored.length) settings.applyPartial(o);
      await logSettings(`Al abrir, la configuración de herramientas era distinta de la última guardada (${diff.join(', ')}); se ha vuelto a poner: ${restored.join(', ') || 'nada'}`);
    } else {
      await recordTools(list.length ? 'al abrir la app' : 'primera vez');
    }
  } catch (err) {
    console.warn('Historial de herramientas no disponible', err);
  }
  let reason = 'cambio en este dispositivo';
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    recordTools(reason);
  };
  settings.on('change', e => {
    if (!e || !(TOOL_KEYS.includes(e.key) || e.key === '*')) return;
    reason = reasonNext || (e.synced ? 'de tu cuenta de Google' : 'cambio en este dispositivo');
    if (e.synced) logSettings(`Traído de la cuenta de Google: ${e.key}`);
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      reasonNext = null;
      recordTools(reason);
    }, 400);
  });
  // Al cerrar, recargar o cambiar de app: guardar ya lo pendiente.
  globalThis.addEventListener?.('pagehide', flush);
  globalThis.document?.addEventListener?.('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });
  return { restored };
}
