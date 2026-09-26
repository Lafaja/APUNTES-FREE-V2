// Ajustes: apariencia, escritura, almacenamiento, copias de seguridad, versión anterior e instalación.

import * as repo from '../core/repo.js';
import { settings, applyTheme } from '../core/settings.js';
import { formatBytes, timeAgo, formatDateTime } from '../core/util.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, alertDialog, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { APP_VERSION } from '../core/version.js';

function row(title, sub, control) {
  return h('div.settings-row', h('div.row-text', h('div.row-title', title), sub ? h('div.row-sub', sub) : null), control || null);
}

function switchCtl(value, onChange) {
  const input = h('input', { type: 'checkbox', checked: !!value });
  input.addEventListener('change', () => onChange(input.checked));
  return h('label.switch', input, h('span'));
}

function segmented(options, value, onPick) {
  const seg = h('div.segmented');
  for (const o of options) {
    const b = h('button', { type: 'button' }, o.label);
    if (o.id === value) b.classList.add('active');
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      onPick(o.id);
    });
    seg.appendChild(b);
  }
  return seg;
}

export async function openSettingsDialog(app, section) {
  const body = h('div');

  // ---------- Apariencia ----------
  body.appendChild(h('div.settings-group',
    h('h3', 'Apariencia'),
    row('Tema', 'Automático sigue el modo claro/oscuro del sistema.', null),
    h('div', { style: { paddingBottom: '12px' } }, segmented([
      { id: 'auto', label: 'Automático' }, { id: 'light', label: 'Claro' }, { id: 'dark', label: 'Oscuro' }
    ], settings.get('theme'), v => {
      settings.set('theme', v);
      applyTheme();
    }))
  ));

  // ---------- Escritura ----------
  body.appendChild(h('div.settings-group',
    h('h3', 'Escritura'),
    row('Uso del dedo', 'Automático: el dedo dibuja hasta que la app detecta un lápiz; después el dedo solo desplaza (rechazo de palma).', null),
    h('div', { style: { paddingBottom: '12px' } }, segmented([
      { id: 'auto', label: 'Automático' }, { id: 'pan', label: 'Desplazar' }, { id: 'draw', label: 'Dibujar' }
    ], settings.get('fingerMode'), v => settings.set('fingerMode', v))),
    row('Formas perfectas', 'Al terminar un trazo, deja el lápiz quieto medio segundo: la línea, círculo, rectángulo o triángulo se vuelve perfecto. Si sigues moviéndolo, vuelve a ser trazo a mano.', switchCtl(settings.get('shapeSnap'), v => settings.set('shapeSnap', v))),
    row('Toque con dos dedos = deshacer', 'Y con tres dedos, rehacer. Con un dedo (si el dedo desplaza) se siguen los enlaces del PDF.', switchCtl(settings.get('twoFingerUndo'), v => settings.set('twoFingerUndo', v))),
    row('Añadir página al escribir al final', 'En apuntes, crea una hoja nueva cuando escribes en la parte baja de la última.', switchCtl(settings.get('autoAddPages'), v => settings.set('autoAddPages', v))),
    row('Botones de zoom', 'Muestra − 100 % + en la esquina del documento.', switchCtl(settings.get('showZoomControls'), v => settings.set('showZoomControls', v)))
  ));

  // ---------- Almacenamiento ----------
  const storageGroup = h('div.settings-group', { id: 'settings-storage' });
  body.appendChild(storageGroup);
  const renderStorage = async () => {
    clear(storageGroup);
    storageGroup.appendChild(h('h3', 'Almacenamiento y seguridad de los datos'));
    let persisted = null;
    let estimate = null;
    try {
      if (navigator.storage && navigator.storage.persisted) persisted = await navigator.storage.persisted();
      if (navigator.storage && navigator.storage.estimate) estimate = await navigator.storage.estimate();
    } catch {}
    const counts = await repo.counts().catch(() => ({}));
    const persistCtl = persisted
      ? h('span', h('span.status-dot.ok'), 'Protegido')
      : h('button.btn.btn-sm.btn-outline', { type: 'button', on: { click: async () => {
        const ok = navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false;
        app.persisted = ok;
        toast(ok ? 'Almacenamiento protegido' : 'El navegador no lo ha concedido todavía. Instala la app en la pantalla de inicio y vuelve a intentarlo.', { type: ok ? 'success' : 'warn', duration: 6000 });
        renderStorage();
      } } }, 'Solicitar protección');
    storageGroup.appendChild(row(
      'Almacenamiento persistente',
      persisted ? 'El navegador no borrará tus apuntes aunque le falte espacio.' : 'Sin esta protección el navegador podría borrar datos si se queda sin espacio. Instalar la app ayuda a conseguirla.',
      persistCtl
    ));
    if (estimate && estimate.quota) {
      const used = estimate.usage || 0;
      const pct = Math.min(100, (used / estimate.quota) * 100);
      storageGroup.appendChild(h('div.settings-row', h('div.row-text',
        h('div.row-title', `Espacio usado: ${formatBytes(used)} de ${formatBytes(estimate.quota)}`),
        h('div.row-sub', `${counts.docs || 0} documentos · ${counts.folders || 0} carpetas · ${counts.pages || 0} páginas · ${counts.versions || 0} versiones guardadas · ${counts.trashed || 0} en la papelera`),
        h('div.meter', h('i', { style: { width: `${Math.max(1, pct)}%`, background: pct > 85 ? 'var(--danger)' : 'var(--accent)' } })))));
    }

    // Copias de seguridad manuales
    const backup = await repo.getMeta('backup', {});
    const doBackup = h('button.btn.btn-sm.btn-primary', { type: 'button' }, iconEl('download'), 'Crear copia');
    doBackup.addEventListener('click', async () => {
      const { exportBackup } = await import('../core/backup.js');
      await exportBackup();
      renderStorage();
    });
    storageGroup.appendChild(row('Copia de seguridad (.zip)', backup && backup.lastAt ? `Última copia: ${timeAgo(backup.lastAt)} (${formatDateTime(backup.lastAt)}).` : 'Todavía no has hecho ninguna. Guárdala en la nube, un pendrive o tu ordenador.', doBackup));
    const doRestore = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('restore'), 'Restaurar…');
    doRestore.addEventListener('click', () => restoreFlow(app, renderStorage));
    storageGroup.appendChild(row('Restaurar una copia', 'Admite copias .zip de esta versión y copias .json de la versión anterior. Nunca sobrescribe lo que ya tienes.', doRestore));

    // Copia automática
    const { autoBackupSupported, getAutoBackup, chooseAutoBackupFolder, runAutoBackup, disableAutoBackup } = await import('../core/backup.js');
    if (autoBackupSupported()) {
      const cfg = await getAutoBackup();
      const wrap = h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } });
      const choose = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('folder'), cfg.enabled ? 'Cambiar carpeta' : 'Elegir carpeta');
      choose.addEventListener('click', async () => {
        try {
          await chooseAutoBackupFolder();
          const r = await runAutoBackup({ force: true, userGesture: true });
          toast(r === 'done' ? 'Copia automática activada y primera copia creada' : 'Copia automática activada', { type: 'success' });
        } catch (err) {
          if (err && err.name !== 'AbortError') toast(`No se pudo usar esa carpeta: ${err.message}`, { type: 'error' });
        }
        renderStorage();
      });
      wrap.appendChild(choose);
      if (cfg.enabled) {
        const now = h('button.btn.btn-sm.btn-outline', { type: 'button' }, 'Copiar ahora');
        now.addEventListener('click', async () => {
          const r = await runAutoBackup({ force: true, userGesture: true });
          toast(r === 'done' ? 'Copia creada en la carpeta' : r === 'need-permission' ? 'Hace falta volver a dar permiso a la carpeta' : 'No se pudo crear la copia', { type: r === 'done' ? 'success' : 'warn' });
          renderStorage();
        });
        const off = h('button.btn.btn-sm.btn-danger-ghost', { type: 'button' }, 'Desactivar');
        off.addEventListener('click', async () => {
          await disableAutoBackup();
          renderStorage();
        });
        wrap.append(now, off);
      }
      const sub = cfg.enabled
        ? `Carpeta: «${cfg.dirName || 'elegida'}». ${cfg.lastAt ? `Última copia ${timeAgo(cfg.lastAt)}.` : 'Aún sin copias.'} Se hace sola cada pocas horas si hay cambios y se guardan las 5 más recientes.${cfg.lastError ? ` Último error: ${cfg.lastError}` : ''}`
        : 'Guarda automáticamente copias .zip en una carpeta de tu dispositivo (por ejemplo, una sincronizada con OneDrive o Google Drive).';
      storageGroup.appendChild(row('Copia automática en una carpeta', sub, wrap));
    }

    // Versión anterior
    const legacyBtn = h('button.btn.btn-sm.btn-outline', { type: 'button' }, 'Buscar e importar');
    legacyBtn.addEventListener('click', async () => {
      const { detectLegacyData, migrateLegacy } = await import('../core/migrate.js');
      const found = await detectLegacyData();
      if (!found || !found.total) {
        await alertDialog('No hay datos nuevos de la versión anterior en este navegador (o ya se importaron). Si tienes una copia .json de la versión anterior, usa «Restaurar…».', 'Versión anterior');
        return;
      }
      const { runMigrationDialog } = await import('./migration.js');
      await runMigrationDialog(found, migrateLegacy, { fromSettings: true });
      await app.library.reload();
      renderStorage();
    });
    const mig = await repo.getMeta('migration', null);
    storageGroup.appendChild(row('Datos de la versión anterior', mig && mig.at ? `Importados ${timeAgo(mig.at)}. Puedes repetirlo: solo añade lo que falte.` : 'Importa los apuntes que tenías en la versión anterior de la app (no la modifica).', legacyBtn));
  };
  await renderStorage();

  // ---------- Google Drive ----------
  const driveGroup = h('div.settings-group', { id: 'settings-drive' });
  body.appendChild(driveGroup);
  try {
    const { renderDriveGroup } = await import('./drive.js');
    await renderDriveGroup(app, driveGroup);
  } catch (err) {
    console.warn('Apartado de Google Drive no disponible', err);
    driveGroup.remove();
  }

  // ---------- Instalación ----------
  const installGroup = h('div.settings-group', h('h3', 'Instalar la app'));
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (standalone) {
    installGroup.appendChild(row('La app está instalada', 'Funciona sin conexión y con almacenamiento propio.', h('span', h('span.status-dot.ok'), 'Instalada')));
  } else if (app.installPrompt) {
    const b = h('button.btn.btn-sm.btn-primary', { type: 'button' }, iconEl('install'), 'Instalar');
    b.addEventListener('click', async () => {
      app.installPrompt.prompt();
      try {
        await app.installPrompt.userChoice;
      } catch {}
      app.installPrompt = null;
    });
    installGroup.appendChild(row('Instalar en este dispositivo', 'Se abrirá como una app, sin barra del navegador, y funcionará sin conexión.', b));
  } else {
    installGroup.appendChild(row('Cómo instalarla', null, null));
    installGroup.appendChild(h('ul', { style: { margin: '0 0 12px', paddingLeft: '20px', color: 'var(--text-2)', fontSize: '14px' } },
      h('li', 'Android (Chrome): menú ⋮ → «Instalar aplicación» o «Añadir a pantalla de inicio».'),
      h('li', 'iPad (Safari): botón Compartir → «Añadir a pantalla de inicio».'),
      h('li', 'Windows (Edge o Chrome): icono de instalar en la barra de direcciones, o menú → «Aplicaciones» → «Instalar».')));
  }
  body.appendChild(installGroup);

  // ---------- Acerca de ----------
  const diag = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('copy'), 'Copiar diagnóstico');
  diag.addEventListener('click', async () => {
    const counts = await repo.counts().catch(() => ({}));
    let est = {};
    try { est = await navigator.storage.estimate(); } catch {}
    const text = [
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
    try {
      await navigator.clipboard.writeText(text);
      toast('Diagnóstico copiado', { type: 'success' });
    } catch {
      await alertDialog(text, 'Diagnóstico');
    }
  });
  body.appendChild(h('div.settings-group', h('h3', 'Acerca de'), row(`Tablet Studio ${APP_VERSION}`, 'Apuntes a mano y PDF anotados. Todo se guarda en este dispositivo; nada se envía a internet.', diag)));

  const m = openModal({ title: 'Ajustes', body, wide: true, buttons: [{ label: 'Cerrar', value: null, variant: 'btn-primary' }] });
  if (section === 'storage') setTimeout(() => storageGroup.scrollIntoView({ block: 'start' }), 80);
  if (section === 'drive') setTimeout(() => driveGroup.scrollIntoView({ block: 'start' }), 80);
  return m.promise;
}

function restoreFlow(app, after) {
  const input = h('input', { type: 'file', accept: '.zip,.json,application/zip,application/json', style: { display: 'none' } });
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.remove();
    if (!file) return;
    await restoreFile(app, file, after);
  });
  input.click();
}

/** Restaura una copia (.zip de esta versión o .json de la anterior) sin sobrescribir nada existente. */
export async function restoreFile(app, file, after) {
  try {
    if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      const ok = await confirmDialog('Es una copia de la versión anterior. Se añadirán las carpetas y documentos que no tengas ya.', { title: 'Importar copia antigua', confirmLabel: 'Importar' });
      if (!ok) return;
      const { importLegacyBackupJson } = await import('../core/migrate.js');
      const stop = toast('Importando…', { duration: 0 });
      let report;
      try {
        report = await importLegacyBackupJson(await file.text());
      } finally {
        stop();
      }
      const { reportText } = await import('./migration.js');
      await alertDialog(`Importado: ${reportText(report)}.${report.errors.length ? `\n\nAvisos:\n${report.errors.slice(0, 8).join('\n')}` : ''}`, 'Copia importada');
    } else {
      const { inspectBackup, restoreBackup } = await import('../core/backup.js');
      const { manifest } = await inspectBackup(file);
      let mode = 'merge';
      let applySettings = false;
      const seg = h('div.segmented');
      for (const [id, label] of [['merge', 'Añadir lo que falta'], ['copy', 'Importar como copia']]) {
        const b = h('button', { type: 'button' }, label);
        if (id === mode) b.classList.add('active');
        b.addEventListener('click', () => {
          mode = id;
          seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        });
        seg.appendChild(b);
      }
      const chk = h('input', { type: 'checkbox' });
      chk.addEventListener('change', () => { applySettings = chk.checked; });
      const ok = await openModal({
        title: 'Restaurar copia',
        body: h('div',
          h('p', `Copia del ${formatDateTime(manifest.createdAt)}: ${manifest.counts.docs} documentos y ${manifest.counts.folders} carpetas.`),
          h('div.field', h('span', 'Cómo restaurar'), seg),
          h('p.hint', '«Añadir lo que falta» recupera lo que no esté en este dispositivo sin tocar nada existente. «Importar como copia» lo pone todo en una carpeta nueva.'),
          h('label.settings-row', { style: { borderTop: '0' } }, h('div.row-text', h('div.row-title', 'Restaurar también las preferencias'), h('div.row-sub', 'Plumas, colores y ajustes.')), h('span.switch', chk, h('span')))),
        buttons: [{ label: 'Cancelar', value: false, variant: 'btn-ghost' }, { label: 'Restaurar', value: true, variant: 'btn-primary', icon: 'restore' }]
      }).promise;
      if (!ok) return;
      const stop = toast('Restaurando copia…', { duration: 0 });
      let report;
      try {
        report = await restoreBackup(file, { mode, applySettings });
      } finally {
        stop();
      }
      await alertDialog(`Restaurado: ${report.docs} documentos, ${report.folders} carpetas y ${report.blobs} archivos.${report.skipped ? ` ${report.skipped} ya existían y no se han tocado.` : ''}${report.errors.length ? `\n\nAvisos:\n${report.errors.slice(0, 8).join('\n')}` : ''}`, 'Copia restaurada');
    }
    await app.library.reload();
    app.broadcast();
    if (after) after();
  } catch (err) {
    console.error(err);
    await alertDialog(`No se pudo restaurar: ${err.message || err}`, 'Error');
  }
}
