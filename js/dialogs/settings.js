// Ajustes: apariencia, escritura, almacenamiento, copias de seguridad, versión anterior e instalación.

import * as repo from '../core/repo.js';
import { settings, applyTheme, TIMINGS, timing } from '../core/settings.js';
import { formatBytes, timeAgo, formatDateTime } from '../core/util.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, alertDialog, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { APP_VERSION } from '../core/version.js';
import { diagnosticText } from '../core/feedback.js';

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

function fmtTiming(key, v) {
  if (TIMINGS[key].unit === 'px') return `${v} px`;
  return v >= 1000 ? `${(v / 1000).toFixed(2).replace(/0$/, '').replace('.', ',')} s` : `${v} ms`;
}

/** Fila con deslizador para un tiempo ajustable (se guarda al soltar, el número cambia al arrastrar). */
function timingRow(key, title, sub) {
  const t = TIMINGS[key];
  const value = h('span.size-value', fmtTiming(key, timing(key)));
  const input = h('input', { type: 'range', min: t.min, max: t.max, step: t.step, value: timing(key), 'aria-label': title });
  input.addEventListener('input', () => { value.textContent = fmtTiming(key, Number(input.value)); });
  input.addEventListener('change', () => settings.set(key, Number(input.value)));
  const wrap = h('div.timing-row', row(title, `${sub} Normal: ${fmtTiming(key, t.def)}.`, null), h('div.size-row', input, value));
  wrap.reset = () => {
    input.value = t.def;
    value.textContent = fmtTiming(key, t.def);
    settings.set(key, t.def);
  };
  return wrap;
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
    row('Unidades de medida', 'Para el grosor de plumas, borrador y formas, y la separación de las líneas del papel.', null),
    h('div', { style: { paddingBottom: '12px' } }, segmented([
      { id: 'mm', label: 'Milímetros' }, { id: 'cm', label: 'Centímetros' }, { id: 'pt', label: 'Puntos' }, { id: 'px', label: 'Píxeles' }
    ], settings.get('units'), v => settings.set('units', v))),
    row('Sensibilidad a la presión', 'Cuanto más aprietas el lápiz, más ancha sale la línea. Solo con lápices que detectan presión; afecta a lo que escribas a partir de ahora, no a lo ya escrito.', null),
    h('div', { style: { paddingBottom: '12px' } }, segmented([
      { id: 'off', label: 'Desactivada' }, { id: 'soft', label: 'Suave' }, { id: 'normal', label: 'Normal' }, { id: 'strong', label: 'Fuerte' }
    ], settings.get('pressure'), v => settings.set('pressure', v))),
    row('Formas perfectas', 'Al terminar un trazo, deja el lápiz quieto un momento (se ajusta en «Tiempos»): la línea, flecha, círculo, rectángulo o triángulo se vuelve perfecto. Sin levantarlo, en una línea cambias el ángulo (el primer punto queda fijo) y en un círculo el tamaño.', switchCtl(settings.get('shapeSnap'), v => settings.set('shapeSnap', v))),
    h('h3', { style: { marginTop: '18px' } }, 'Menú circular de herramientas'),
    row('Qué es', 'Un círculo con tus plumas, herramientas y colores. Elige arrastrando hasta una opción y soltando, o suelta y toca la opción. Puedes abrirlo de varias formas a la vez:', null),
    row('Mantener pulsado', 'Deja el lápiz o el dedo quieto sobre la página.', switchCtl(settings.get('radialMenu'), v => settings.set('radialMenu', v))),
    h('div', { style: { paddingBottom: '8px' } }, segmented([
      { id: 'both', label: 'Lápiz y dedo' }, { id: 'pen', label: 'Solo lápiz' }, { id: 'finger', label: 'Solo dedo' }
    ], settings.get('radialMenuInput'), v => settings.set('radialMenuInput', v))),
    row('Doble toque con el dedo', 'Dos toques rápidos en el mismo sitio (cuando el dedo desplaza la página).', switchCtl(settings.get('radialDoubleTap'), v => settings.set('radialDoubleTap', v))),
    row('Botón lateral del lápiz', 'Pulsa el botón del lápiz y toca la pantalla. Sustituye al borrado con el botón (el extremo borrador sigue borrando).', switchCtl(settings.get('radialPenButton'), v => settings.set('radialPenButton', v))),
    row('Botón flotante', 'Un botón con una paleta en la esquina inferior izquierda del documento.', switchCtl(settings.get('radialFab'), v => settings.set('radialFab', v))),
    h('h3', { style: { marginTop: '18px' } }, 'Gestos'),
    row('Toque con dos dedos = deshacer', 'Y con tres dedos, rehacer. Con un dedo (si el dedo desplaza) se siguen los enlaces del PDF.', switchCtl(settings.get('twoFingerUndo'), v => settings.set('twoFingerUndo', v))),
    row('Añadir página al escribir al final', 'En apuntes, crea una hoja nueva cuando escribes en la parte baja de la última.', switchCtl(settings.get('autoAddPages'), v => settings.set('autoAddPages', v))),
    row('Botones de zoom', 'Muestra − 100 % + en la esquina del documento.', switchCtl(settings.get('showZoomControls'), v => settings.set('showZoomControls', v))),
    row('Mantener pantalla completa', 'Al volver de otra app (Google, la cámara…) la pantalla completa vuelve sola con el primer toque. Se activa al pulsar el botón de pantalla completa y se quita al pulsarlo otra vez.', switchCtl(settings.get('keepFullscreen'), v => settings.set('keepFullscreen', v))),
    row('Pestañas de documentos', 'Cada documento que abres queda como pestaña encima de la barra para cambiar entre ellos. «+» abre otro; la «x» cierra la pestaña (no borra nada).', null),
    h('div', { style: { paddingBottom: '12px' } }, segmented([
      { id: 'always', label: 'Siempre' }, { id: 'auto', label: 'Con 2 o más' }, { id: 'off', label: 'Ocultas' }
    ], settings.get('tabsBar'), v => settings.set('tabsBar', v)))
  ));

  // ---------- Tiempos ----------
  const timingRows = [
    timingRow('shapeSnapDelay', 'Forma perfecta: tiempo quieto al final', 'Cuánto hay que dejar el lápiz quieto al acabar una línea o figura para que se vuelva recta o perfecta.'),
    timingRow('shapeSnapTolerance', 'Forma perfecta: cuánto se puede mover', 'Temblor del lápiz que aún cuenta como «quieto». Más alto = más fácil que salte; más bajo = menos saltos sin querer.'),
    timingRow('radialMenuDelay', 'Menú circular: mantener pulsado', 'Cuánto mantener el lápiz o el dedo quieto para que salga el menú.'),
    timingRow('doubleTapMs', 'Doble toque: separación máxima', 'Tiempo máximo entre los dos toques del doble toque con el dedo.'),
    timingRow('gestureTapMs', 'Toques con dedos: duración máxima', 'Lo que puede durar un toque (dos dedos = deshacer, tres = rehacer, un dedo = enlace). Súbelo si a veces no lo reconoce.'),
    timingRow('palmGuardMs', 'Rechazo de palma tras el lápiz', 'Tiempo durante el que se ignoran los dedos después de levantar el lápiz. Súbelo si la mano mueve la página sin querer.'),
    timingRow('dragHoldMs', 'Biblioteca: mantener para arrastrar', 'Cuánto mantener pulsada una tarjeta para moverla a una carpeta.')
  ];
  body.appendChild(h('div.settings-group',
    h('h3', 'Tiempos'),
    ...timingRows,
    h('div', { style: { padding: '8px 0 12px' } }, h('button.btn.btn-sm.btn-outline', { type: 'button', on: { click: () => {
      timingRows.forEach(r => r.reset());
      toast('Tiempos restablecidos', { type: 'success' });
    } } }, 'Restablecer tiempos'))
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

  // ---------- Errores y sugerencias ----------
  const bugBtn = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('alert'), 'Informar');
  const ideaBtn = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('star'), 'Sugerir');
  const feedback = async kind => {
    const { openFeedbackDialog } = await import('./feedback.js');
    openFeedbackDialog(app, kind);
  };
  bugBtn.addEventListener('click', () => feedback('bug'));
  ideaBtn.addEventListener('click', () => feedback('idea'));
  body.appendChild(h('div.settings-group', h('h3', 'Errores y sugerencias'),
    row('Informar de un error', 'Cuéntanos qué ha fallado y lo arreglaremos.', bugBtn),
    row('Sugerir una mejora', '¿Echas algo de menos? Escribe tu idea.', ideaBtn)));

  // ---------- Acerca de ----------
  const diag = h('button.btn.btn-sm.btn-outline', { type: 'button' }, iconEl('copy'), 'Copiar diagnóstico');
  diag.addEventListener('click', async () => {
    const text = await diagnosticText(app);
    try {
      await navigator.clipboard.writeText(text);
      toast('Diagnóstico copiado', { type: 'success' });
    } catch {
      await alertDialog(text, 'Diagnóstico');
    }
  });
  body.appendChild(h('div.settings-group', h('h3', 'Acerca de'), row(`Tablet Studio ${APP_VERSION}`, 'Apuntes a mano y PDF anotados. Todo se guarda en este dispositivo; nada se envía a internet salvo los mensajes de error o sugerencia que tú escribas.', diag)));

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
