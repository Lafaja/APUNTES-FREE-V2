// Recuperar una configuración de herramientas anterior: del historial de esta tablet o de las versiones
// que Google Drive guarda del archivo de ajustes de la cuenta.

import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { formatDateTime, timeAgo } from '../core/util.js';
import { toolHistory, applyTools, TOOL_KEYS } from '../core/toolhistory.js';

function summary(d) {
  if (!d) return '';
  const parts = [d.toolbarMode === 'kit' ? 'Por herramientas' : 'Bolis guardados'];
  if (Array.isArray(d.presets)) parts.push(`${d.presets.length} bolis guardados`);
  if (d.kit && d.kit.tool) {
    const k = d.kit[d.kit.tool];
    if (k && Array.isArray(k.colors)) parts.push(`${k.colors.length} colores`);
  }
  if (d.layouts && d.layouts.toolbar) {
    const mode = d.toolbarMode === 'kit' ? 'kit' : 'presets';
    const list = d.layouts.toolbar[mode] || [];
    const off = list.filter(x => !x.on).length;
    if (off) parts.push(`${off} oculto${off > 1 ? 's' : ''} en la barra`);
  }
  return parts.join(' · ');
}

function swatches(d) {
  const wrap = h('span.hist-swatches');
  const k = d && d.kit && d.kit[d.kit.tool];
  const colors = d && d.toolbarMode === 'kit' && k ? k.colors : (d && Array.isArray(d.presets) ? d.presets.map(p => p.c) : []);
  for (const c of (colors || []).slice(0, 6)) wrap.appendChild(h('i', { style: { background: c } }));
  return wrap;
}

export async function openToolHistoryDialog() {
  const local = await toolHistory();
  const gd = await import('../core/gdrive.js');
  const cfg = await gd.getDriveConfig();
  const listLocal = h('div.layout-list');
  const listCloud = h('div.layout-list', { hidden: true });
  let m;

  const restore = async (data, when, origin) => {
    const ok = await confirmDialog(`Tu configuración de herramientas volverá a la del ${formatDateTime(when)}. La de ahora se guarda en el historial, por si quieres volver.`, { title: '¿Recuperar esta configuración?', confirmLabel: 'Recuperar' });
    if (!ok) return;
    await applyTools(data, origin);
    toast('Configuración de herramientas recuperada', { type: 'success' });
    m.close(true);
  };

  const entryRow = (when, reason, data, origin) => {
    const b = h('button.btn.btn-sm.btn-outline', { type: 'button' }, 'Recuperar');
    b.addEventListener('click', () => restore(data, when, origin));
    return h('div.layout-row',
      h('span.layout-icon', iconEl(origin === 'cuenta' ? 'drive' : 'history')),
      h('div.row-text', h('div.row-title', `${formatDateTime(when)} · ${timeAgo(when)}`), h('div.row-sub', [reason, summary(data)].filter(Boolean).join(' — '))),
      swatches(data), b);
  };

  if (!local.length) listLocal.appendChild(h('p.panel-hint', { style: { padding: '10px' } }, 'Todavía no hay nada guardado en esta tablet. A partir de ahora se guarda solo cada vez que cambies algo.'));
  local.forEach((e, i) => listLocal.appendChild(entryRow(e.at, i === 0 ? `${e.reason} (la actual)` : e.reason, e.data, 'tablet')));

  // Versiones que Drive guarda del archivo de ajustes de la cuenta (unos 30 días).
  const cloudBtn = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('drive'), 'Buscar en Google Drive');
  const cloudHint = h('p.panel-hint');
  cloudBtn.disabled = !(cfg.clientId && cfg.connected);
  cloudHint.textContent = cloudBtn.disabled
    ? 'Para buscar en tu cuenta, entra con Google en «Datos y cuenta».'
    : 'Drive guarda versiones anteriores del archivo de ajustes que sube la app (normalmente de los últimos 30 días).';
  cloudBtn.addEventListener('click', async () => {
    cloudBtn.disabled = true;
    try {
      // La ventana de Google tiene que abrirse dentro del toque: sin esperas antes.
      if (!gd.hasValidToken()) await gd.connectDrive(cfg.clientId, { consent: false });
      const { SETTINGS_FILE } = await import('../core/sync.js');
      const revs = await gd.listAppJsonRevisions(SETTINGS_FILE);
      clear(listCloud);
      listCloud.hidden = false;
      if (!revs.length) listCloud.appendChild(h('p.panel-hint', { style: { padding: '10px' } }, 'No hay versiones guardadas en tu cuenta.'));
      for (const rev of revs.slice(0, 40)) {
        const b = h('button.btn.btn-sm.btn-outline', { type: 'button' }, 'Ver');
        const rowEl = h('div.layout-row',
          h('span.layout-icon', iconEl('drive')),
          h('div.row-text', h('div.row-title', `${formatDateTime(rev.at)} · ${timeAgo(rev.at)}`), h('div.row-sub', 'Versión guardada en tu cuenta')),
          b);
        b.addEventListener('click', async () => {
          b.disabled = true;
          const json = await gd.readAppJsonRevision(rev).catch(() => null);
          const vals = json && json.values;
          if (!vals || !TOOL_KEYS.some(k => k in vals)) {
            toast('Esa versión no tiene configuración de herramientas', { type: 'warn' });
            b.disabled = false;
            return;
          }
          rowEl.replaceWith(entryRow(rev.at, 'Versión guardada en tu cuenta', vals, 'cuenta'));
        });
        listCloud.appendChild(rowEl);
      }
    } catch (err) {
      console.error(err);
      toast(`No se pudo buscar en Google Drive: ${err.message || err}`, { type: 'error', duration: 7000 });
    } finally {
      cloudBtn.disabled = false;
    }
  });

  const body = h('div',
    h('p.panel-hint', 'La app guarda tu configuración de herramientas (método, bolis, grosores, colores, barra y menú) cada vez que la cambias. Elige una para volver a ella.'),
    h('div.field', { style: { marginTop: '10px' } }, h('span', 'En esta tablet')),
    listLocal,
    h('div.field', { style: { marginTop: '18px' } }, h('span', 'En tu cuenta de Google')),
    h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' } }, cloudBtn, cloudHint),
    listCloud);

  m = openModal({ title: 'Recuperar configuración de herramientas', body, wide: true, buttons: [{ label: 'Cerrar', value: null, variant: 'btn-primary' }] });
  return m.promise;
}
