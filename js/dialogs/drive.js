// Interfaz de la copia en Google Drive: apartado de Ajustes, asistente de configuración,
// copia con progreso y restauración desde Drive.

import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, alertDialog, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { formatBytes, timeAgo, formatDateTime } from '../core/util.js';
import {
  CLIENT_ID_RE, getDriveConfig, setDriveConfig, connectDrive, disconnectDrive, hasValidToken,
  backupToDrive, listDriveBackups, downloadDriveBackup, loadGoogleIdentity
} from '../core/gdrive.js';

function row(title, sub, control) {
  return h('div.settings-row', h('div.row-text', h('div.row-title', title), sub ? h('div.row-sub', sub) : null), control || null);
}

function switchCtl(value, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.switch', input, h('span'));
}

/** Conecta con Google si hace falta. Llamar directamente desde el toque del usuario. */
async function ensureConnected(cfg) {
  if (hasValidToken()) return true;
  await connectDrive(cfg.clientId, { consent: !cfg.connected });
  await setDriveConfig({ connected: true });
  return true;
}

/**
 * Copia a Drive con avisos de progreso. Devuelve true si se hizo.
 * `knownCfg`: configuración ya leída (así la ventana de Google se abre sin esperas y el navegador no la bloquea).
 */
export async function runDriveBackupInteractive(app, knownCfg = null) {
  const cfg = knownCfg || (await getDriveConfig());
  if (!cfg.clientId) {
    await openDriveSetup(app);
    return false;
  }
  try {
    await ensureConnected(cfg);
  } catch (err) {
    toast(err.message || 'No se pudo conectar con Google', { type: 'error', duration: 6000 });
    return false;
  }
  const stop = toast('Preparando la copia para Google Drive…', { duration: 0 });
  try {
    const res = await backupToDrive({
      onProgress: p => {
        if (!stop.update) return;
        if (p.phase === 'upload') stop.update(`Subiendo a Google Drive… ${Math.round((p.done / Math.max(1, p.total)) * 100)} %`);
        else if (p.phase === 'files') stop.update(`Preparando la copia… archivos ${p.done}/${p.total}`);
        else stop.update(`Preparando la copia… documentos ${p.done}/${p.total}`);
      }
    });
    stop();
    toast(`Copia guardada en Google Drive (${formatBytes(res.size)})`, { type: 'success', duration: 4500 });
    if (app) {
      app.drivePending = false;
      app.updateBanners();
    }
    return true;
  } catch (err) {
    stop();
    console.error(err);
    if (err.code === 'AUTH') toast('La sesión de Google caducó. Vuelve a tocar «Copiar ahora».', { type: 'warn', duration: 6000 });
    else await alertDialog(`No se pudo guardar la copia en Google Drive: ${err.message || err}\n\nTus apuntes siguen a salvo en este dispositivo.`, 'Copia en Google Drive');
    return false;
  }
}

/** Asistente: pasos para conseguir el ID de cliente y campo para pegarlo. */
export async function openDriveSetup(app, after) {
  const cfg = await getDriveConfig();
  const origin = location.origin;
  const input = h('input.text-input', { type: 'text', value: cfg.clientId || '', placeholder: '123456789-abc….apps.googleusercontent.com', autocomplete: 'off', spellcheck: 'false', autocapitalize: 'none' });
  const err = h('div.hint', { style: { color: 'var(--danger)' } });
  const steps = h('ol.drive-steps',
    h('li', 'Entra en ', h('a', { href: 'https://console.cloud.google.com/', target: '_blank', rel: 'noopener' }, 'console.cloud.google.com'), ' con tu cuenta de Google y crea un proyecto (por ejemplo, «Tablet Studio»).'),
    h('li', 'En «APIs y servicios → Biblioteca», busca «Google Drive API» y pulsa «Habilitar».'),
    h('li', 'En «Pantalla de consentimiento de OAuth» (o «Google Auth Platform»): tipo «Externo», pon un nombre y tu correo. En «Público → Usuarios de prueba» añade tu propia cuenta de Gmail.'),
    h('li', 'En «Credenciales → Crear credenciales → ID de cliente de OAuth»: tipo «Aplicación web». En «Orígenes de JavaScript autorizados» añade ', h('code', origin), '.'),
    h('li', 'Copia el «ID de cliente» (termina en .apps.googleusercontent.com) y pégalo aquí debajo.'));
  const body = h('div',
    h('p', 'Google pide que cada app tenga su propio identificador. Se crea una sola vez, es gratis y tarda unos minutos:'),
    steps,
    h('label.field', h('span', 'ID de cliente de Google'), input),
    err,
    h('p.hint', 'La app solo tendrá acceso a las copias que ella misma cree en tu Drive (permiso «drive.file»); no puede ver ni tocar el resto de tus archivos. La primera vez Google avisará de que la app «no está verificada»: es normal en apps personales, pulsa «Continuar».'));
  // Cargar ya la librería de Google para que la ventana de permiso se abra sin retraso al pulsar.
  loadGoogleIdentity().catch(() => {});
  const m = openModal({
    title: 'Copia en Google Drive',
    body,
    wide: true,
    cancelValue: null,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: 'Guardar y conectar', variant: 'btn-primary', value: 'ok' }
    ]
  });
  const choice = await m.promise;
  if (choice !== 'ok') return false;
  const id = input.value.trim();
  if (!CLIENT_ID_RE.test(id)) {
    await alertDialog('Ese ID de cliente no parece correcto. Debe terminar en «.apps.googleusercontent.com».', 'Copia en Google Drive');
    return false;
  }
  const changed = id !== cfg.clientId;
  if (changed) disconnectDrive();
  // Primero la ventana de Google (dentro del toque) y después se guarda la configuración.
  let connected = false;
  try {
    await connectDrive(id, { consent: true });
    connected = true;
    toast('Conectado con Google Drive', { type: 'success' });
  } catch (e) {
    toast(e.message || 'No se pudo conectar con Google', { type: 'error', duration: 7000 });
  }
  await setDriveConfig({ clientId: id, connected: connected || (!changed && cfg.connected), ...(changed ? { folderId: null } : {}) });
  if (after) after();
  return true;
}

/** Lista las copias de Drive y restaura la elegida (sin sobrescribir nada existente). */
export async function openDriveRestore(app, after, knownCfg = null) {
  const cfg = knownCfg || (await getDriveConfig());
  if (!cfg.clientId) {
    await openDriveSetup(app, after);
    return;
  }
  try {
    await ensureConnected(cfg);
  } catch (err) {
    toast(err.message || 'No se pudo conectar con Google', { type: 'error', duration: 6000 });
    return;
  }
  const list = h('div.dest-list');
  const status = h('div.text-results-status', h('span.mini-spinner'), 'Buscando tus copias en Google Drive…');
  const m = openModal({ title: 'Restaurar desde Google Drive', body: h('div', status, list), wide: true, cancelValue: null, buttons: [{ label: 'Cancelar', value: null, variant: 'btn-ghost' }] });
  let files = [];
  try {
    files = await listDriveBackups();
  } catch (err) {
    status.replaceChildren(`No se pudieron leer las copias: ${err.message || err}`);
    return;
  }
  if (!files.length) {
    status.replaceChildren('No hay copias de Tablet Studio en tu Google Drive todavía.');
    return;
  }
  status.remove();
  for (const f of files) {
    const b = h('button.dest-row', { type: 'button' },
      h('span.dest-icon', iconEl('drive')),
      h('span', formatDateTime(Date.parse(f.createdTime))),
      h('span.muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, `${formatBytes(Number(f.size) || 0)} · ${timeAgo(Date.parse(f.createdTime))}`));
    b.addEventListener('click', () => m.close(f));
    list.appendChild(b);
  }
  const chosen = await m.promise;
  if (!chosen) return;
  const stop = toast('Descargando la copia de Google Drive…', { duration: 0 });
  let file;
  try {
    file = await downloadDriveBackup(chosen);
  } catch (err) {
    stop();
    await alertDialog(`No se pudo descargar la copia: ${err.message || err}`, 'Google Drive');
    return;
  }
  stop();
  const { restoreFile } = await import('./settings.js');
  await restoreFile(app, file, after);
}

/** Apartado «Copia en Google Drive» de Ajustes. */
export async function renderDriveGroup(app, group) {
  const render = async () => {
    clear(group);
    group.appendChild(h('h3', 'Copia en Google Drive'));
    const cfg = await getDriveConfig();
    if (!cfg.clientId) {
      const setup = h('button.btn.btn-sm.btn-primary', { type: 'button' }, iconEl('drive'), 'Configurar…');
      setup.addEventListener('click', () => openDriveSetup(app, render));
      group.appendChild(row('Guardar copias en tu Google Drive',
        'Copias automáticas en la nube, también en Android y iPad, para no perder nada aunque se rompa o se pierda la tablet. Hay que configurarlo una vez (unos minutos).',
        setup));
      return;
    }
    const now = h('button.btn.btn-sm.btn-primary', { type: 'button' }, iconEl('cloudUp'), 'Copiar ahora');
    now.addEventListener('click', async () => {
      now.disabled = true;
      await runDriveBackupInteractive(app, cfg);
      render();
    });
    const state = cfg.lastAt
      ? `Última copia ${timeAgo(cfg.lastAt)} (${formatDateTime(cfg.lastAt)}, ${formatBytes(cfg.lastSize || 0)}).`
      : 'Aún no se ha hecho ninguna copia en Drive.';
    const session = hasValidToken() ? ' Sesión de Google activa.' : '';
    group.appendChild(row('Copia en Google Drive', `${state}${session}${cfg.lastError ? ` Último error: ${cfg.lastError}` : ''}`, now));
    group.appendChild(row('Copia automática diaria',
      'Si hay cambios, una vez al día. Si la sesión de Google ha caducado, aparecerá un aviso para renovarla con un toque. Se guardan las 10 más recientes; las antiguas pasan a la papelera de Drive.',
      switchCtl(cfg.auto, async v => {
        await setDriveConfig({ auto: v });
      })));
    const restore = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('restore'), 'Restaurar…');
    restore.addEventListener('click', () => openDriveRestore(app, render, cfg));
    group.appendChild(row('Restaurar desde Google Drive', 'Por ejemplo, en una tablet nueva. Nunca sobrescribe lo que ya tienes.', restore));
    const change = h('button.btn.btn-sm.btn-ghost', { type: 'button' }, 'Cambiar');
    change.addEventListener('click', () => openDriveSetup(app, render));
    const off = h('button.btn.btn-sm.btn-danger-ghost', { type: 'button' }, 'Quitar');
    off.addEventListener('click', async () => {
      const ok = await confirmDialog('Se dejarán de hacer copias en Google Drive. Las copias que ya están en tu Drive no se borran.', { title: '¿Quitar Google Drive?', confirmLabel: 'Quitar' });
      if (!ok) return;
      disconnectDrive();
      await setDriveConfig({ clientId: '', connected: false, folderId: null });
      render();
    });
    const short = cfg.clientId.length > 24 ? `${cfg.clientId.slice(0, 12)}…${cfg.clientId.slice(-26)}` : cfg.clientId;
    group.appendChild(row('ID de cliente', short, h('div', { style: { display: 'flex', gap: '4px' } }, change, off)));
    loadGoogleIdentity().catch(() => {});
  };
  await render();
}
