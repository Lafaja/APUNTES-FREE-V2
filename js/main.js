// Punto de entrada: arranque seguro, navegación, ciclo de vida y protección de datos.

import { openDatabase, onVersionChange } from './core/db.js';
import * as repo from './core/repo.js';
import { settings, applyTheme } from './core/settings.js';
import { timeAgo } from './core/util.js';
import { Library } from './library/library.js';
import { Editor } from './editor/editor.js';
import { hydrateIcons } from './ui/icons.js';
import { toast } from './ui/toast.js';
import { alertDialog } from './ui/modal.js';
import { h, $ } from './ui/dom.js';
import { newNoteDialog, folderDialog, pickFolderDialog, pickDocumentDialog } from './dialogs/basic.js';
import { anyPendingChanges, openSession, releaseSession, normalizePageRecord, allSessions } from './model/session.js';
import { pageSizeFor, normalizeBg } from './model/paper.js';
import { updateThumbnail } from './render/thumbs.js';
import { APP_VERSION } from './core/version.js';
import { pauseIndexing } from './core/textindex.js';

export { APP_VERSION };

class App {
  constructor() {
    this.persisted = null;
    this.thumbQueue = [];
    this.thumbBusy = false;
    this.swWaiting = null;
    this.channel = null;
    this.bannerDismissed = new Set();
    this.installPrompt = null;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      this.installPrompt = e;
    });
    window.addEventListener('appinstalled', () => {
      this.installPrompt = null;
      toast('App instalada', { type: 'success' });
      this.checkPersistence().then(() => this.updateBanners());
    });
  }

  async boot() {
    applyTheme();
    if (window.matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
        if (settings.get('theme') === 'auto') applyTheme();
      });
    }
    hydrateIcons();
    this.installErrorHandlers();
    try {
      await openDatabase();
    } catch (err) {
      this.showBootError(err);
      return;
    }
    onVersionChange(() => {
      toast('La app se actualizó en otra pestaña. Recarga para seguir.', { type: 'warn', duration: 0, action: { label: 'Recargar', fn: () => this.safeReload() } });
    });
    this.library = new Library(this);
    this.editor = new Editor(this);
    await this.library.reload();
    this.setupLifecycle();
    this.setupBroadcast();
    this.hideBoot();
    await this.checkMigration();
    this.checkPersistence().then(() => this.updateBanners());
    this.setupServiceWorker();
    window.addEventListener('popstate', () => this.onRoute());
    this.onRoute(true);
    setTimeout(() => this.autoBackup(), 20000);
  }

  /** Copia automática en la carpeta elegida y/o en Google Drive, si está activada y toca (nunca bloquea la interfaz). */
  async autoBackup() {
    this.autoBackupDrive();
    try {
      const { runAutoBackup } = await import('./core/backup.js');
      const r = await runAutoBackup();
      if (r === 'need-permission' && !this.bannerDismissed.has('autobackup')) {
        const banners = [{
          icon: 'shield',
          kind: 'info',
          title: 'Copia automática en pausa',
          text: 'El navegador necesita que vuelvas a permitir el acceso a la carpeta de copias.',
          actions: [{ label: 'Permitir y copiar', primary: true, fn: async () => {
            const res = await runAutoBackup({ force: true, userGesture: true });
            toast(res === 'done' ? 'Copia automática creada' : 'No se pudo crear la copia', { type: res === 'done' ? 'success' : 'warn' });
            this.bannerDismissed.add('autobackup');
            this.updateBanners();
          } }],
          dismiss: () => this.bannerDismissed.add('autobackup')
        }];
        const slot = document.getElementById('lib-banner-slot');
        if (slot && !slot.children.length) this.library.setBanners(banners);
      }
    } catch (err) {
      console.warn('Copia automática no disponible', err);
    }
  }

  async autoBackupDrive() {
    try {
      const gd = await import('./core/gdrive.js');
      if (!(await gd.driveBackupDue())) return;
      if (gd.hasValidToken()) {
        await gd.backupToDrive();
        toast('Copia automática guardada en Google Drive', { type: 'success' });
        this.drivePending = false;
      } else {
        // La sesión de Google caducó: un aviso para renovarla con un toque. Se deja todo cargado
        // para que, al tocar, la ventana de Google se abra al instante (si no, el navegador la bloquea).
        this.drivePending = true;
        this.driveCfg = await gd.getDriveConfig();
        this.driveUi = await import('./dialogs/drive.js');
        gd.loadGoogleIdentity().catch(() => {});
      }
      this.updateBanners();
    } catch (err) {
      console.warn('Copia automática en Google Drive no realizada', err);
    }
  }

  // ---------------------------------------------------------------------
  // Arranque
  // ---------------------------------------------------------------------

  hideBoot() {
    const b = $('#boot-screen');
    b.classList.add('hide');
    setTimeout(() => (b.hidden = true), 250);
  }

  showBootError(err) {
    console.error(err);
    const b = $('#boot-screen');
    b.innerHTML = '';
    const retry = h('button.btn.btn-primary', { type: 'button' }, 'Reintentar');
    retry.addEventListener('click', () => location.reload());
    b.appendChild(h('div.boot-error',
      h('h1', 'No se puede acceder al almacenamiento'),
      h('p', err.message || String(err)),
      h('p', 'La app no funcionará sin almacenamiento para no arriesgar tus apuntes. Si estás en modo incógnito, ábrela en una ventana normal. Si tienes la app abierta en otra pestaña, ciérrala y reintenta.'),
      retry));
  }

  installErrorHandlers() {
    window.addEventListener('error', e => {
      console.error('Error no controlado:', e.error || e.message);
    });
    window.addEventListener('unhandledrejection', e => {
      console.error('Promesa rechazada sin controlar:', e.reason);
    });
  }

  // ---------------------------------------------------------------------
  // Protección de datos
  // ---------------------------------------------------------------------

  async checkPersistence() {
    try {
      if (navigator.storage && navigator.storage.persisted) {
        this.persisted = await navigator.storage.persisted();
        if (!this.persisted && navigator.storage.persist) this.persisted = await navigator.storage.persist();
      }
    } catch {
      this.persisted = null;
    }
    return this.persisted;
  }

  setupLifecycle() {
    // Al ocultar la app (cambiar de app, apagar pantalla, cerrar pestaña) se guarda todo al instante.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && this.editor) this.editor.flushAll();
    });
    window.addEventListener('pagehide', () => {
      if (this.editor) this.editor.flushAll();
    });
    window.addEventListener('beforeunload', e => {
      if (anyPendingChanges()) {
        if (this.editor) this.editor.flushAll();
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  setupBroadcast() {
    if (!('BroadcastChannel' in window)) return;
    this.channel = new BroadcastChannel('tablet-studio-v2');
    this.channel.onmessage = e => {
      if (e.data && e.data.type === 'library-changed' && !this.editor.isOpen()) this.library.reload();
    };
  }

  broadcast() {
    try {
      if (this.channel) this.channel.postMessage({ type: 'library-changed' });
    } catch {}
  }

  async updateBanners() {
    const banners = [];
    const counts = await repo.counts().catch(() => ({ docs: 0 }));
    const backup = await repo.getMeta('backup', {});
    const days = settings.get('backupReminderDays') || 7;
    if (counts.docs > 0 && !this.bannerDismissed.has('backup')) {
      const last = backup && backup.lastAt;
      if (!last || Date.now() - last > days * 86400000) {
        banners.push({
          icon: 'shield',
          kind: 'info',
          title: last ? `Tu última copia de seguridad fue ${timeAgo(last)}` : 'Aún no has hecho ninguna copia de seguridad',
          text: 'Guarda una copia en tu tablet, en la nube o en un pendrive: es la mejor garantía contra borrados del navegador.',
          actions: [{ label: 'Hacer copia ahora', primary: true, fn: () => this.backupNow() }],
          dismiss: () => this.bannerDismissed.add('backup')
        });
      }
    }
    if (this.drivePending && !this.bannerDismissed.has('gdrive')) {
      banners.push({
        icon: 'drive',
        kind: 'info',
        title: 'Copia en Google Drive pendiente',
        text: 'La sesión de Google caducó. Toca para renovarla y guardar la copia de hoy en tu Drive.',
        actions: [{ label: 'Copiar ahora', primary: true, fn: async () => {
          const ui = this.driveUi || (await import('./dialogs/drive.js'));
          await ui.runDriveBackupInteractive(this, this.driveCfg || null);
        } }],
        dismiss: () => this.bannerDismissed.add('gdrive')
      });
    }
    if (this.persisted === false && !this.bannerDismissed.has('persist')) {
      banners.push({
        icon: 'alert',
        title: 'El navegador podría borrar los datos si le falta espacio',
        text: 'Instala la app en tu pantalla de inicio (menú del navegador → «Instalar» o «Añadir a pantalla de inicio») para que el almacenamiento sea permanente, y haz copias de seguridad.',
        actions: [{ label: 'Más info', fn: () => this.openSettings('storage') }],
        dismiss: () => this.bannerDismissed.add('persist')
      });
    }
    if (this.swWaiting) {
      banners.unshift({
        icon: 'info',
        kind: 'info',
        title: 'Hay una nueva versión de la app',
        text: 'Actualiza cuando quieras: tus apuntes se guardan antes.',
        actions: [{ label: 'Actualizar', primary: true, fn: () => this.applyUpdate() }]
      });
    }
    this.library.setBanners(banners);
  }

  async backupNow() {
    const { exportBackup } = await import('./core/backup.js');
    await exportBackup({ interactive: true });
    this.updateBanners();
  }

  async emergencyExport(session) {
    const { exportBackup } = await import('./core/backup.js');
    await exportBackup({ interactive: true, sessions: [session], docIds: [session.id] });
  }

  // ---------------------------------------------------------------------
  // Migración desde la versión anterior
  // ---------------------------------------------------------------------

  async checkMigration() {
    const done = await repo.getMeta('migration', null);
    if (done) return;
    try {
      const { detectLegacyData, migrateLegacy } = await import('./core/migrate.js');
      const found = await detectLegacyData();
      if (!found || !found.total) {
        await repo.setMeta('migration', { at: Date.now(), found: 0 });
        return;
      }
      const { runMigrationDialog } = await import('./dialogs/migration.js');
      await runMigrationDialog(found, migrateLegacy);
      await this.library.reload();
    } catch (err) {
      console.error('Error en la migración', err);
      toast(`No se pudieron importar los datos de la versión anterior: ${err.message}. No se ha borrado nada.`, { type: 'error', duration: 8000 });
    }
  }

  // ---------------------------------------------------------------------
  // Navegación
  // ---------------------------------------------------------------------

  docFromHash() {
    const m = /^#\/doc\/([^/]+)(?:\/([^/]+))?/.exec(location.hash || '');
    return m ? { id: decodeURIComponent(m[1]), split: m[2] ? decodeURIComponent(m[2]) : null } : null;
  }

  async onRoute(initial = false) {
    const target = this.docFromHash();
    if (target) {
      const first = this.editor.isOpen() && this.editor.panes[0] ? this.editor.panes[0].session.id : null;
      if (first !== target.id) {
        const usable = id => {
          const n = id && this.library.nodes.get(id);
          return !!(n && n.kind === 'doc' && this.library.isAlive(id));
        };
        if (!usable(target.id)) {
          history.replaceState(null, '', '#/');
          if (this.editor.isOpen()) await this.hideEditor();
          return;
        }
        await this.showEditor(target.id, usable(target.split) ? target.split : null);
      }
    } else if (this.editor.isOpen()) {
      await this.hideEditor();
    } else if (initial) {
      history.replaceState(null, '', location.pathname + location.search + '#/');
    }
  }

  /**
   * Abre un documento (y opcionalmente otro al lado). `search` = { query, blobId, pdfIndex }
   * abre además la búsqueda en el PDF, empezando por esa página si se indica.
   */
  async openDocument(id, { splitWith = null, search = null } = {}) {
    const hash = `#/doc/${encodeURIComponent(id)}${splitWith ? `/${encodeURIComponent(splitWith)}` : ''}`;
    if (this.editor.isOpen()) history.replaceState({ doc: id }, '', hash);
    else history.pushState({ doc: id }, '', hash);
    const ok = await this.showEditor(id, splitWith);
    if (ok && search && search.query) this.editor.search.open(search.query, { prefer: search });
    return ok;
  }

  async showEditor(id, splitWith) {
    $('#screen-library').hidden = true;
    pauseIndexing(true);
    const ok = await this.editor.open(id, { splitWith });
    if (!ok) {
      $('#screen-library').hidden = false;
      pauseIndexing(false);
      history.replaceState(null, '', '#/');
    }
    return ok;
  }

  /** El editor avisa de qué documentos hay abiertos (pantalla dual) para mantener la dirección al día. */
  syncRoute(ids) {
    if (!ids || !ids.length || !this.editor.isOpen()) return;
    const hash = `#/doc/${ids.slice(0, 2).map(encodeURIComponent).join('/')}`;
    if (location.hash !== hash) history.replaceState(history.state, '', hash);
  }

  /** Pantalla dual desde la biblioteca: elegir dos documentos y abrirlos uno al lado del otro. */
  async openDual() {
    const a = await this.pickDocument({ title: 'Pantalla dual · primer documento' });
    if (!a) return;
    const b = await this.pickDocument({ title: 'Pantalla dual · segundo documento', hint: 'Puedes elegir otra vez el mismo documento para ver dos partes a la vez.' });
    if (!b) return;
    await this.openDocument(a, { splitWith: b });
  }

  async closeEditor() {
    if (history.state && history.state.doc) history.back();
    else {
      history.replaceState(null, '', '#/');
      await this.hideEditor();
    }
  }

  async hideEditor() {
    const ok = await this.editor.close();
    $('#screen-library').hidden = false;
    pauseIndexing(false);
    document.title = 'Tablet Studio · Apuntes';
    await this.library.reload();
    this.broadcast();
    this.updateBanners();
    if (!ok) toast('Aún se están guardando cambios; se seguirá intentando.', { type: 'warn' });
    setTimeout(() => this.autoBackup(), 3000);
  }

  async safeReload() {
    try {
      if (this.editor) await this.editor.flushAll();
    } catch {}
    location.reload();
  }

  // ---------------------------------------------------------------------
  // Acciones de la biblioteca
  // ---------------------------------------------------------------------

  async newNote(parentId) {
    const res = await newNoteDialog();
    if (!res) return;
    const size = pageSizeFor(res.paper.size, res.paper.orientation);
    const bg = normalizeBg({ template: res.paper.template, color: res.paper.color, spacing: res.paper.spacing });
    const { node } = await repo.createDocument({
      name: res.name,
      parentId,
      source: 'note',
      paper: res.paper,
      pages: [{ w: size.w, h: size.h, bg }],
      autoAddPages: res.paper.size !== 'infinite'
    });
    this.broadcast();
    await this.openDocument(node.id);
  }

  async newFolder(parentId) {
    const res = await folderDialog({});
    if (!res || !res.name.trim()) return;
    await repo.createFolder({ name: res.name, color: res.color, parentId });
    await this.library.reload();
    this.broadcast();
  }

  async editFolder(node) {
    const res = await folderDialog({ title: 'Editar carpeta', name: node.name, color: node.color, confirmLabel: 'Guardar' });
    if (!res || !res.name.trim()) return;
    await repo.patchNode(node.id, { name: res.name.trim(), color: res.color, updatedAt: Date.now() });
    await this.library.reload();
    this.broadcast();
  }

  async importPdf(parentId) {
    const input = h('input', { type: 'file', accept: 'application/pdf,.pdf', multiple: true, style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const files = [...(input.files || [])];
      input.remove();
      if (!files.length) return;
      const { importPdfFlow } = await import('./dialogs/import-pdf.js');
      let lastId = null;
      for (const f of files) {
        const id = await importPdfFlow(f, parentId, { single: files.length === 1 });
        if (id) lastId = id;
      }
      await this.library.reload();
      this.broadcast();
      if (lastId && files.length === 1) await this.openDocument(lastId);
    });
    input.click();
  }

  pickFolder(opts) {
    return pickFolderDialog(this.library.nodes, opts);
  }

  async pickDocument(opts) {
    await this.library.reload();
    return pickDocumentDialog(this.library.nodes, opts);
  }

  // ---------------------------------------------------------------------
  // Diálogos cargados bajo demanda
  // ---------------------------------------------------------------------

  async openSettings(section) {
    const { openSettingsDialog } = await import('./dialogs/settings.js');
    await openSettingsDialog(this, section);
    this.editor.updateFingerButton();
    this.updateBanners();
  }

  async openExport(session, currentPage) {
    const { openExportDialog } = await import('./dialogs/export.js');
    await openExportDialog(session, currentPage);
  }

  async exportFromLibrary(docId) {
    const session = await openSession(docId);
    try {
      await this.openExport(session, 0);
    } finally {
      await releaseSession(session);
    }
  }

  async openVersions(session) {
    const { openVersionsDialog } = await import('./dialogs/versions.js');
    await openVersionsDialog(this, session.id, session);
  }

  async openVersionsById(docId) {
    const { openVersionsDialog } = await import('./dialogs/versions.js');
    await openVersionsDialog(this, docId, null);
  }

  /** Restaura una versión; si el documento está abierto se cierra (guardando) y se vuelve a abrir. */
  async restoreVersion(docId, versionId) {
    const wasOpen = this.editor.isOpen() && this.editor.panes.some(p => p.session.id === docId);
    if (wasOpen) await this.editor.close({ keepScreen: true });
    try {
      if (allSessions().some(s => s.id === docId)) {
        throw new Error('El documento tiene cambios que aún no se han podido guardar; inténtalo de nuevo en unos segundos.');
      }
      await repo.restoreVersion(versionId);
    } finally {
      if (wasOpen) await this.editor.open(docId);
      await this.library.reload();
    }
  }

  async openPagesPanel(editor, pane, opts) {
    const { openPagesPanel } = await import('./dialogs/pages.js');
    await openPagesPanel(editor, pane, opts);
  }

  async openPageBackground(editor, pane) {
    const { openPageBackgroundDialog } = await import('./dialogs/pages.js');
    await openPageBackgroundDialog(editor, pane);
  }

  // ---------------------------------------------------------------------
  // Miniaturas en segundo plano
  // ---------------------------------------------------------------------

  queueThumbnail(docId) {
    if (this.thumbQueue.includes(docId)) return;
    this.thumbQueue.push(docId);
    this.pumpThumbs();
  }

  pumpThumbs() {
    if (this.thumbBusy || !this.thumbQueue.length) return;
    if (this.editor && this.editor.isOpen()) {
      setTimeout(() => this.pumpThumbs(), 3000);
      return;
    }
    this.thumbBusy = true;
    const run = async () => {
      const id = this.thumbQueue.shift();
      try {
        const node = await repo.getNode(id);
        if (node && node.pages && node.pages.length) {
          const rec = await repo.loadPage(node.pages[0].id);
          if (rec) {
            await updateThumbnail(node, normalizePageRecord(rec, node.pages[0], node.id));
            this.library.thumbReady(id);
          }
        }
      } catch (err) {
        console.warn('Miniatura no generada', id, err);
      } finally {
        this.thumbBusy = false;
        setTimeout(() => this.pumpThumbs(), 50);
      }
    };
    if ('requestIdleCallback' in window) requestIdleCallback(run, { timeout: 1500 });
    else setTimeout(run, 100);
  }

  // ---------------------------------------------------------------------
  // Service worker (funcionamiento sin conexión y actualizaciones seguras)
  // ---------------------------------------------------------------------

  setupServiceWorker() {
    if (!('serviceWorker' in navigator) || location.protocol === 'file:') return;
    // En desarrollo local no se usa (evita servir archivos viejos de la caché); se puede forzar con ?sw=1.
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if (isLocal && !/[?&]sw=1/.test(location.search)) {
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
      return;
    }
    navigator.serviceWorker.register('./sw.js').then(reg => {
      const onWaiting = w => {
        this.swWaiting = w;
        this.updateBanners();
        if (this.editor.isOpen()) toast('Nueva versión disponible: se aplicará al volver a la biblioteca', { type: 'info' });
      };
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      reg.addEventListener('updatefound', () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener('statechange', () => {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) onWaiting(nw);
        });
      });
      // Buscar actualizaciones de vez en cuando.
      setInterval(() => reg.update().catch(() => {}), 60 * 60 * 1000);
    }).catch(err => console.warn('Service worker no registrado', err));
    let reloading = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloading || !this.updateRequested) return;
      reloading = true;
      this.safeReload();
    });
  }

  async applyUpdate() {
    if (!this.swWaiting) return;
    if (this.editor) await this.editor.flushAll();
    this.updateRequested = true;
    this.swWaiting.postMessage({ type: 'SKIP_WAITING' });
  }
}

const app = new App();
window.__tabletStudio = app;
app.boot().catch(err => {
  console.error(err);
  alertDialog(`Error al iniciar la app: ${err.message || err}`);
});
