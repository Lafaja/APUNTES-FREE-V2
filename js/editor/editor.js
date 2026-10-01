// Controlador del editor: abre documentos (uno o dos en pantalla dividida), herramientas, páginas,
// deshacer/rehacer, guardado visible y cierre seguro.

import { openSession, releaseSession, flushAllSessions } from '../model/session.js';
import * as repo from '../core/repo.js';
import { settings, fingerDraws } from '../core/settings.js';
import { uid, debounce, nextFrame } from '../core/util.js';
import { normalizeBg, pageSizeFor } from '../model/paper.js';
import { DocumentViewer } from './viewer.js';
import { InputController } from './input.js';
import { PenTool, EraserTool, ShapeTool } from './tools.js';
import { Selection, LassoTool } from './selection.js';
import { Toolbar } from './toolbar.js';
import { DocSearch } from './search.js';
import { DocTabs } from './tabs.js';
import { importImageFile } from '../render/images.js';
import { updateThumbnail } from '../render/thumbs.js';
import { destPoint } from '../render/pdfnav.js';
import { h, iconEl, $, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu, closePopover, isPopoverOpen } from '../ui/popover.js';
import { confirmDialog, promptDialog, alertDialog, openModal, isModalOpen } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

export class Editor {
  constructor(app) {
    this.app = app;
    this.screen = $('#screen-editor');
    this.body = $('#ed-body');
    this.panes = [];
    this.activePane = null;
    this.tool = 'pen';
    this.selection = new Selection(this);
    this.tools = {
      pen: new PenTool(this),
      eraser: new EraserTool(this),
      lasso: new LassoTool(this, this.selection),
      shape: new ShapeTool(this)
    };
    this.toolbar = new Toolbar(this, $('#ed-tools'));
    this.search = new DocSearch(this);
    this.tabs = new DocTabs(this);
    this.autoAdded = new Set();
    this.closing = false;
    this.bindTopBar();
    this.bindKeyboard();
    this.updateFingerButton();
  }

  isOpen() {
    return this.panes.length > 0;
  }

  get viewer() {
    return this.activePane ? this.activePane.viewer : null;
  }

  get session() {
    return this.activePane ? this.activePane.session : null;
  }

  isReadOnly() {
    return !!(this.session && this.session.readOnly);
  }

  // =====================================================================
  // Apertura y cierre
  // =====================================================================

  async open(docId, { splitWith = null } = {}) {
    if (this.isOpen()) await this.close({ keepScreen: true });
    this.screen.hidden = false;
    this.autoAdded.clear();
    try {
      await this.addPane(docId);
    } catch (err) {
      console.error(err);
      await this.close();
      await alertDialog(`No se pudo abrir el documento: ${err.message || err}`, 'Error');
      return false;
    }
    if (splitWith) {
      try {
        await this.addPane(splitWith);
      } catch (err) {
        // El primer documento ya está abierto: no se cierra todo por culpa del segundo.
        console.error(err);
        toast('No se pudo abrir el segundo documento de la pantalla dual', { type: 'error' });
        this.syncRoute();
      }
    }
    this.setTool(this.tool === 'lasso' || this.tool === 'eraser' || this.tool === 'shape' ? this.tool : 'pen');
    return true;
  }

  async addPane(docId, { index = this.panes.length } = {}) {
    if (this.panes.length >= 2) return null;
    const session = await openSession(docId);
    session.node.openedAt = Date.now();
    session.nodeDirty = true;
    const el = h('div.pane');
    const header = h('div.pane-header');
    const title = h('span.pane-title', session.node.name);
    const changeBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Abrir otro documento en este panel' }, iconEl('fileSwap'));
    const swapBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Intercambiar los paneles' }, iconEl('swap'));
    const closeBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Cerrar este panel' }, iconEl('x'));
    header.append(iconEl(session.node.source === 'pdf' ? 'fileText' : 'edit'), title, changeBtn, swapBtn, closeBtn);
    el.appendChild(header);
    this.body.appendChild(el);
    const viewer = new DocumentViewer(el, session, { editor: this });
    const input = new InputController(viewer, this);
    const zoomCtl = this.buildZoomControls(viewer);
    viewer.el.appendChild(zoomCtl.el);
    const pane = { el, header, title, viewer, input, session, zoomCtl, unsubs: [] };
    closeBtn.addEventListener('click', () => this.closePane(pane));
    swapBtn.addEventListener('click', () => this.swapPanes());
    changeBtn.addEventListener('click', () => this.changePaneDocument(pane));
    header.addEventListener('pointerdown', () => this.setActiveViewer(viewer));
    pane.unsubs.push(
      viewer.on('current-page', () => {
        if (pane === this.activePane) {
          this.updatePageIndicator();
          this.updateBookmarkButton();
        }
      }),
      viewer.on('add-page-click', () => this.addPage(pane, { atEnd: true })),
      viewer.on('scroll', () => {
        if (this.selection.sel && this.selection.sel.viewer === viewer) this.selection.redraw();
      }),
      viewer.on('zoom', ({ zoom }) => {
        zoomCtl.label.textContent = `${Math.round(zoom * 100)}%`;
        if (this.selection.sel && this.selection.sel.viewer === viewer) this.selection.redraw();
        this.saveViewSoon(pane);
      }),
      viewer.on('zoom-preview', ({ zoom }) => {
        zoomCtl.label.textContent = `${Math.round(zoom * 100)}%`;
      }),
      session.on('save-state', () => {
        if (pane === this.activePane) this.updateSaveState();
      }),
      session.on('history', () => {
        if (pane.session === this.session) this.updateUndoRedo();
      }),
      session.on('renamed', ({ name }) => {
        title.textContent = name;
        if (pane === this.activePane) this.updateTitle();
        this.tabs.render();
      }),
      session.on('layout', () => {
        this.selection.validate();
        this.updatePageIndicator();
        if (pane === this.activePane) {
          this.updateSearchButton();
          this.updateBookmarkButton();
        }
      }),
      session.on('bookmarks', () => {
        if (pane.session === this.session) this.updateBookmarkButton();
      }),
      session.on('page-change', () => {
        if (this.selection.sel && this.selection.sel.viewer.session === session) this.selection.validate();
      })
    );
    this.panes.splice(Math.max(0, Math.min(index, this.panes.length)), 0, pane);
    this.layoutPanes();
    this.setActiveViewer(viewer);
    await nextFrame();
    await nextFrame();
    viewer.restoreView(session.node.view);
    zoomCtl.label.textContent = `${Math.round(viewer.zoom * 100)}%`;
    if (session.readOnly) this.showReadOnlyBanner();
    this.syncRoute();
    this.tabs.add(docId);
    return pane;
  }

  /** Coloca los paneles y el divisor en orden y aplica la orientación y el reparto de espacio. */
  layoutPanes() {
    const split = this.panes.length > 1;
    if (split && !this.divider) {
      this.divider = h('div.split-divider', { title: 'Arrastra para repartir el espacio' });
      this.bindDivider();
    }
    if (!split && this.divider) {
      this.divider.remove();
      this.divider = null;
    }
    // El orden visual se decide con CSS (order): mover un panel dentro del DOM haría que el
    // navegador olvidase su posición de desplazamiento y el documento saltaría a la página 1.
    this.panes.forEach((p, i) => {
      if (p.el.parentNode !== this.body) this.body.appendChild(p.el);
      p.el.style.order = String(i * 2);
      p.el.classList.toggle('second', i === 1);
    });
    if (split) {
      if (this.divider.parentNode !== this.body) this.body.appendChild(this.divider);
      this.divider.style.order = '1';
    }
    this.body.classList.toggle('split', split);
    this.applySplitOrientation();
    if (split) this.applySplitRatio();
    else if (this.panes[0]) this.panes[0].el.style.flex = '';
    this.updateDualButton();
  }

  /** Lado a lado en horizontal; uno encima de otro si la pantalla está en vertical (o si se elige así). */
  splitStacked() {
    const mode = settings.get('splitOrientation') || 'auto';
    if (mode === 'stack') return true;
    if (mode === 'side') return false;
    return window.innerHeight > window.innerWidth * 1.05;
  }

  applySplitOrientation() {
    const stacked = this.panes.length > 1 && this.splitStacked();
    this.body.classList.toggle('stacked', stacked);
    if (!this._orientationListener) {
      this._orientationListener = debounce(() => {
        if (this.panes.length > 1) this.applySplitOrientation();
      }, 150);
      window.addEventListener('resize', this._orientationListener);
    }
  }

  async swapPanes() {
    if (this.panes.length < 2) return;
    this.panes.reverse();
    const ratio = Math.min(0.8, Math.max(0.2, settings.get('splitRatio') || 0.5));
    settings.set('splitRatio', 1 - ratio);
    this.layoutPanes();
    this.syncRoute();
  }

  async changePaneDocument(pane) {
    const id = await this.app.pickDocument({ title: 'Abrir en este panel', hint: 'Puedes elegir el mismo documento que el otro panel para ver dos partes a la vez.', exclude: pane.session.id });
    await this.replacePaneDocument(pane, id);
  }

  /** Sustituye el documento de un panel por otro (pantalla dual y pestañas). */
  async replacePaneDocument(pane, id) {
    if (!id || id === pane.session.id || !this.panes.includes(pane)) return;
    const index = this.panes.indexOf(pane);
    if (this.selection.sel && this.selection.sel.viewer === pane.viewer) this.selection.clear();
    if (this.search.isOpen()) pane.viewer.setSearch(null);
    await this.teardownPane(pane);
    this.panes = this.panes.filter(p => p !== pane);
    if (this.activePane === pane) this.activePane = null;
    await this.addPane(id, { index });
  }

  /** Mantiene la dirección (#/doc/A/B) al día para que recargar conserve la pantalla dual. */
  syncRoute() {
    if (this.app && typeof this.app.syncRoute === 'function') {
      this.app.syncRoute(this.panes.map(p => p.session.id));
    }
  }

  saveViewSoon(pane) {
    if (!pane._saveView) pane._saveView = debounce(() => {
      if (!pane.viewer.destroyed) pane.session.setView(pane.viewer.viewState());
    }, 1500);
    pane._saveView();
  }

  async closePane(pane) {
    if (this.panes.length <= 1) {
      await this.app.closeEditor();
      return;
    }
    if (this.selection.sel && this.selection.sel.viewer === pane.viewer) this.selection.clear();
    await this.teardownPane(pane);
    this.panes = this.panes.filter(p => p !== pane);
    if (this.activePane === pane) this.activePane = null;
    this.layoutPanes();
    this.setActiveViewer(this.panes[0].viewer);
    this.syncRoute();
    this.tabs.render();
  }

  async teardownPane(pane) {
    for (const u of pane.unsubs) u();
    try {
      pane.session.setView(pane.viewer.viewState());
    } catch {}
    const session = pane.session;
    const firstId = session.node.pages[0] && session.node.pages[0].id;
    let first = null;
    try {
      first = firstId ? await session.getPage(firstId) : null;
    } catch {}
    const node = session.node;
    pane.input.destroy();
    pane.viewer.destroy();
    pane.el.remove();
    await releaseSession(session);
    // Miniatura para la biblioteca (en segundo plano, sin bloquear).
    if (first && (node.rev || 0) !== (node.thumbRev || 0)) {
      updateThumbnail(node, first)
        .then(() => {
          if (this.app.library) this.app.library.thumbReady(node.id);
        })
        .catch(err => console.warn('Miniatura no generada', err));
    }
  }

  /** Cierra el editor guardándolo todo. Devuelve false si algo no se pudo guardar. */
  async close({ keepScreen = false } = {}) {
    if (this.closing) return false;
    this.closing = true;
    try {
      this.selection.clear();
      closePopover();
      if (this.search.isOpen()) this.search.close();
      for (const pane of [...this.panes]) await this.teardownPane(pane);
      this.panes = [];
      this.activePane = null;
      if (this.divider) {
        this.divider.remove();
        this.divider = null;
      }
      this.body.classList.remove('split', 'stacked');
      clear(this.body);
      clear($('#ed-banner-slot'));
      if (!keepScreen) this.screen.hidden = true;
      this.tabs.render();
      return true;
    } finally {
      this.closing = false;
    }
  }

  setActiveViewer(viewer) {
    const pane = this.panes.find(p => p.viewer === viewer);
    if (!pane || pane === this.activePane) return;
    if (this.activePane) this.activePane.el.classList.remove('active');
    this.activePane = pane;
    pane.el.classList.add('active');
    this.updateTitle();
    this.updateSaveState();
    this.updateUndoRedo();
    this.updatePageIndicator();
    this.updateSearchButton();
    this.updateDualButton();
    this.updateBookmarkButton();
    this.toolbar.syncDisabled();
    this.tabs.render();
    if (this.search.isOpen()) this.search.onPaneChange();
  }

  /** La lupa solo tiene sentido si el documento tiene páginas de PDF. */
  updateSearchButton() {
    const s = this.session;
    const hasPdf = !!(s && (s.node.source === 'pdf' || (s.node.pdf && s.node.pdf.blobId)));
    $('#btn-ed-search').hidden = !hasPdf;
  }

  updateDualButton() {
    const b = $('#btn-ed-dual');
    const on = this.panes.length > 1;
    b.classList.toggle('active', on);
    b.title = on ? 'Pantalla dual: opciones' : 'Pantalla dual: abrir otro documento al lado';
  }

  dualMenu(anchor) {
    if (this.panes.length < 2) {
      this.openSplit();
      return;
    }
    const mode = settings.get('splitOrientation') || 'auto';
    const mark = m => (mode === m ? '✓' : '');
    const pane = this.activePane;
    openMenu(anchor, [
      { title: 'Pantalla dual' },
      { label: 'Intercambiar los paneles', icon: 'swap', onClick: () => this.swapPanes() },
      { label: 'Cambiar el documento del panel activo…', icon: 'fileSwap', onClick: () => this.changePaneDocument(pane) },
      'sep',
      { title: 'Orientación' },
      { label: 'Automática (según el giro)', icon: 'rotate', hint: mark('auto'), onClick: () => this.setSplitOrientation('auto') },
      { label: 'Lado a lado', icon: 'split', hint: mark('side'), onClick: () => this.setSplitOrientation('side') },
      { label: 'Uno encima del otro', icon: 'splitRows', hint: mark('stack'), onClick: () => this.setSplitOrientation('stack') },
      'sep',
      { label: 'Cerrar el panel activo', icon: 'x', onClick: () => this.closePane(pane) }
    ]);
  }

  setSplitOrientation(mode) {
    settings.set('splitOrientation', mode);
    this.layoutPanes();
  }

  // =====================================================================
  // Pantalla completa (oculta las barras y pestañas del navegador)
  // =====================================================================

  bindFullscreen() {
    // Botones en la biblioteca y en el editor (mismo comportamiento).
    const btns = [...document.querySelectorAll('.fs-toggle')];
    const supported = !!(document.fullscreenEnabled || document.webkitFullscreenEnabled);
    for (const b of btns) b.hidden = !supported;
    if (!supported) return;
    for (const b of btns) b.addEventListener('click', () => this.toggleFullscreen());
    const sync = () => {
      const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
      document.body.classList.toggle('is-fullscreen', on);
      for (const b of btns) {
        b.classList.toggle('active', on);
        b.title = on ? 'Salir de pantalla completa' : 'Pantalla completa';
        b.innerHTML = icon(on ? 'minimize' : 'maximize');
      }
    };
    document.addEventListener('fullscreenchange', sync);
    document.addEventListener('webkitfullscreenchange', sync);
  }

  async toggleFullscreen() {
    const on = !!(document.fullscreenElement || document.webkitFullscreenElement);
    try {
      if (on) await (document.exitFullscreen ? document.exitFullscreen() : document.webkitExitFullscreen());
      else {
        const el = document.documentElement;
        if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' });
        else if (el.webkitRequestFullscreen) el.webkitRequestFullscreen();
      }
    } catch (err) {
      toast('El navegador no ha permitido la pantalla completa. Instalar la app también quita sus barras.', { type: 'warn', duration: 5000 });
    }
  }

  // =====================================================================
  // Marcadores de página
  // =====================================================================

  currentPageId(pane = this.activePane) {
    if (!pane) return null;
    const ref = pane.session.node.pages[pane.viewer.currentPage];
    return ref ? ref.id : null;
  }

  updateBookmarkButton() {
    const b = $('#btn-ed-bookmark');
    const pane = this.activePane;
    const id = this.currentPageId(pane);
    const on = !!(pane && id && pane.session.isBookmarked(id));
    b.classList.toggle('active', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
    b.title = on ? 'Quitar el marcador de esta página' : 'Marcar esta página';
    b.disabled = !pane || pane.session.readOnly;
  }

  toggleBookmark(pane = this.activePane, pageId = this.currentPageId(pane)) {
    if (!pane || !pageId) return;
    if (pane.session.readOnly) {
      this.flashReadOnly();
      return;
    }
    const on = pane.session.toggleBookmark(pageId);
    const n = pane.session.pageIndex(pageId) + 1;
    toast(on ? `Página ${n} marcada` : `Marcador de la página ${n} quitado`, { type: on ? 'success' : 'info', duration: 1800 });
    this.updateBookmarkButton();
  }

  // =====================================================================
  // Enlaces e índice del PDF
  // =====================================================================

  /** Toque sin arrastrar (dedo en modo desplazar) o Ctrl+clic: si hay un enlace del PDF, se sigue. */
  async onTap(viewer, clientX, clientY) {
    let hit = null;
    try {
      hit = await viewer.linkAt(clientX, clientY);
    } catch (err) {
      console.warn('No se pudieron leer los enlaces del PDF', err);
    }
    if (!hit || viewer.destroyed) return;
    const pane = this.panes.find(p => p.viewer === viewer);
    if (pane) await this.followPdfLink(pane, hit);
  }

  async followPdfLink(pane, { link, page, pageIndex }) {
    if (link.url) {
      await this.openExternalUrl(link.url);
      return;
    }
    const last = pane.session.node.pages.length - 1;
    if (link.named) {
      const target = { NextPage: pageIndex + 1, PrevPage: pageIndex - 1, FirstPage: 0, LastPage: last }[link.named];
      if (target !== undefined) this.jumpWithReturn(pane, () => pane.viewer.scrollToPage(Math.max(0, Math.min(last, target))));
      return;
    }
    if (link.dest) await this.goToPdfDest(pane, page.pdf.blobId, link.dest);
  }

  async openExternalUrl(url) {
    const body = h('div', h('p', 'Este enlace del PDF lleva fuera de la app. ¿Abrirlo en el navegador?'), h('p.link-url', url));
    const ok = await confirmDialog(body, { title: 'Enlace externo', confirmLabel: 'Abrir enlace' });
    if (ok) window.open(url, '_blank', 'noopener,noreferrer');
  }

  /** Índice de la página del documento que muestra la página `pdfIndex` de ese PDF (o -1). */
  async docPageForPdf(session, blobId, pdfIndex) {
    const refs = session.node.pages;
    const matches = p => !!(p && p.pdf && p.pdf.blobId === blobId && p.pdf.index === pdfIndex);
    // Lo habitual: el documento conserva el orden del PDF.
    if (refs[pdfIndex]) {
      const guess = await session.getPage(refs[pdfIndex].id).catch(() => null);
      if (matches(guess)) return pdfIndex;
    }
    for (let i = 0; i < refs.length; i++) if (matches(session.getPageSync(refs[i].id))) return i;
    const pages = await session.loadAllPages();
    return pages.findIndex(matches);
  }

  /** Va a un destino del PDF (página y, si lo indica, la altura exacta) con opción de volver. */
  async goToPdfDest(pane, blobId, dest, { docIndex } = {}) {
    const session = pane.session;
    const viewer = pane.viewer;
    const i = Number.isInteger(docIndex) ? docIndex : await this.docPageForPdf(session, blobId, dest.pageIndex);
    if (i < 0) {
      toast('Esa página del PDF ya no está en este documento', { type: 'info' });
      return;
    }
    let x = null;
    let y = 0;
    if (dest.top !== null || dest.left !== null) {
      try {
        const page = await session.getPage(session.node.pages[i].id);
        const pt = await destPoint(blobId, dest, page.pdf ? page.pdf.rotation || 0 : 0);
        if (page.pdf && pt.baseW) {
          const k = page.pdf.w / pt.baseW;
          if (pt.y !== null) y = (page.pdf.y || 0) + pt.y * k;
          if (pt.x !== null) x = (page.pdf.x || 0) + pt.x * k;
        }
      } catch (err) {
        console.warn(err);
      }
    }
    if (viewer.destroyed) return;
    this.jumpWithReturn(pane, () => viewer.scrollToPageOffset(i, y, x));
  }

  /** Salta a otra parte del documento y ofrece volver a donde se estaba. */
  jumpWithReturn(pane, jump) {
    const viewer = pane.viewer;
    const back = { top: viewer.scroll.scrollTop, left: viewer.scroll.scrollLeft, zoom: viewer.zoom, page: viewer.currentPage };
    jump();
    if (viewer.currentPage === back.page && Math.abs(viewer.scroll.scrollTop - back.top) < 40) return;
    toast(`Página ${viewer.currentPage + 1}`, {
      duration: 6000,
      action: { label: 'Volver', fn: () => {
        if (viewer.destroyed) return;
        if (Math.abs(viewer.zoom - back.zoom) < 1e-3) {
          viewer.scroll.scrollTop = back.top;
          viewer.scroll.scrollLeft = back.left;
          viewer.updateVisible();
        } else {
          viewer.scrollToPage(back.page);
        }
      } }
    });
  }

  // =====================================================================
  // Barra superior
  // =====================================================================

  bindTopBar() {
    $('#btn-ed-back').addEventListener('click', () => this.app.closeEditor());
    $('#btn-ed-title').addEventListener('click', () => this.renameDoc());
    $('#btn-ed-undo').addEventListener('click', () => this.undo());
    $('#btn-ed-redo').addEventListener('click', () => this.redo());
    $('#btn-ed-finger').addEventListener('click', () => this.toggleFinger());
    $('#btn-ed-search').addEventListener('click', () => this.search.toggle());
    $('#btn-ed-dual').addEventListener('click', e => this.dualMenu(e.currentTarget));
    $('#btn-ed-bookmark').addEventListener('click', () => this.toggleBookmark());
    this.bindFullscreen();
    $('#btn-ed-pages').addEventListener('click', () => this.openPagesPanel());
    $('#btn-ed-more').addEventListener('click', e => this.openMoreMenu(e.currentTarget));
    $('#ed-save-state').addEventListener('click', () => this.showSaveDetails());
  }

  updateTitle() {
    const s = this.session;
    $('#ed-title-text').textContent = s ? s.node.name : '';
    document.title = s ? `${s.node.name} · Tablet Studio` : 'Tablet Studio';
  }

  updateSaveState() {
    const el = $('#ed-save-state');
    const s = this.session;
    if (!s) return;
    const st = s.saveState;
    el.className = `save-state ${st}`;
    if (st === 'error') {
      el.innerHTML = icon('cloudOff');
      el.title = 'No se pudo guardar. Se reintenta automáticamente. Toca para ver opciones.';
    } else if (st === 'saving' || st === 'pending') {
      el.innerHTML = icon('cloudUp');
      el.title = 'Guardando…';
    } else {
      el.innerHTML = icon('cloudCheck');
      el.title = 'Todos los cambios están guardados en este dispositivo';
    }
  }

  async showSaveDetails() {
    const s = this.session;
    if (!s) return;
    if (s.saveState !== 'error') {
      toast(s.saveState === 'saved' ? 'Todo guardado en este dispositivo' : 'Guardando cambios…', { type: s.saveState === 'saved' ? 'success' : 'info' });
      return;
    }
    const err = s.lastError;
    const quota = err && (err.name === 'QuotaExceededError' || /quota/i.test(err.message || ''));
    const choice = await openModal({
      title: 'No se pudo guardar',
      body: h('div',
        h('p', quota
          ? 'El almacenamiento del navegador está lleno. Tus últimos cambios siguen en memoria y se reintentará guardarlos.'
          : `Error: ${(err && err.message) || 'desconocido'}. Tus cambios siguen en memoria y se reintenta guardarlos automáticamente.`),
        h('p', 'Para no arriesgar nada, descarga ahora una copia de este documento.')),
      buttons: [
        { label: 'Reintentar ahora', value: 'retry', variant: 'btn-ghost' },
        { label: 'Descargar copia', value: 'download', variant: 'btn-primary', icon: 'download' }
      ]
    }).promise;
    if (choice === 'retry') s.flush({ strict: true });
    if (choice === 'download') this.app.emergencyExport(s);
  }

  updateUndoRedo() {
    const s = this.session;
    const st = s ? s.historyState() : { canUndo: false, canRedo: false };
    $('#btn-ed-undo').disabled = !st.canUndo;
    $('#btn-ed-redo').disabled = !st.canRedo;
  }

  updatePageIndicator() {
    const v = this.viewer;
    if (!v) return;
    const total = v.session.node.pages.length;
    $('#ed-page-indicator').textContent = `${Math.min(total, v.currentPage + 1)}/${total}`;
  }

  updateFingerButton() {
    const b = $('#btn-ed-finger');
    const draws = fingerDraws();
    b.innerHTML = icon(draws ? 'pencil' : 'hand');
    b.classList.toggle('finger-draw', draws);
    b.title = draws ? 'El dedo dibuja (toca para que el dedo solo desplace)' : 'El dedo desplaza y el lápiz escribe (toca para dibujar con el dedo)';
  }

  toggleFinger() {
    const draws = fingerDraws();
    settings.set('fingerMode', draws ? 'pan' : 'draw');
    this.updateFingerButton();
    toast(draws ? 'Dedo: desplazar · el lápiz escribe' : 'Dedo: dibujar · usa dos dedos para desplazar', { type: 'info' });
  }

  onPenDetected() {
    this.updateFingerButton();
    if (settings.get('fingerMode') === 'auto') toast('Lápiz detectado: ahora el dedo desplaza y el lápiz escribe', { type: 'info', duration: 4200 });
  }

  onHover() {}

  flashReadOnly() {
    toast('Documento en solo lectura (está abierto en otra ventana)', { type: 'warn' });
  }

  showReadOnlyBanner() {
    const slot = $('#ed-banner-slot');
    clear(slot);
    const retry = h('button.btn.btn-sm', { type: 'button' }, 'Reintentar');
    retry.addEventListener('click', async () => {
      const id = this.session.node.id;
      await this.app.closeEditor();
      this.app.openDocument(id);
    });
    slot.appendChild(h('div.banner', iconEl('alert'), h('div.banner-text', h('strong', 'Solo lectura'), 'Este documento está abierto en otra pestaña o ventana. Ciérralo allí para editarlo aquí sin riesgo de sobrescribir cambios.'), retry));
  }

  async renameDoc() {
    const s = this.session;
    if (!s || s.readOnly) return;
    const name = await promptDialog({ title: 'Renombrar documento', label: 'Nombre', value: s.node.name });
    if (name && name.trim()) s.rename(name);
  }

  // =====================================================================
  // Herramientas
  // =====================================================================

  activePreset() {
    const presets = settings.get('presets');
    return presets.find(p => p.id === settings.get('activePresetId')) || presets[0];
  }

  favColors() {
    return settings.get('favColors');
  }

  selectPreset(id) {
    settings.set('activePresetId', id);
    this.setTool('pen');
  }

  setTool(tool) {
    if (tool !== 'lasso') this.selection.clear();
    this.tool = tool;
    closePopover();
    this.toolbar.syncActive();
  }

  useLasso() {
    if (this.tool !== 'lasso') {
      this.tool = 'lasso';
      this.toolbar.syncActive();
    }
  }

  /** Herramienta para un nuevo trazo; `forced` = 'eraser' para el extremo borrador del lápiz. */
  toolFor(forced) {
    if (forced) return this.tools[forced];
    return this.tools[this.tool] || this.tools.pen;
  }

  // =====================================================================
  // Deshacer / rehacer
  // =====================================================================

  async undo() {
    const s = this.session;
    if (!s) return;
    await s.undo();
    this.selection.validate();
  }

  async redo() {
    const s = this.session;
    if (!s) return;
    await s.redo();
    this.selection.validate();
  }

  toast(msg, type = 'info') {
    toast(msg, { type });
  }

  // =====================================================================
  // Páginas
  // =====================================================================

  currentPageIndex(pane = this.activePane) {
    return pane ? pane.viewer.currentPage : 0;
  }

  /** Plantilla para una página nueva: copia fondo y tamaño de la página de referencia. */
  async newPageLike(session, refIndex) {
    const refs = session.node.pages;
    const ref = refs[Math.max(0, Math.min(refIndex, refs.length - 1))];
    const refPage = ref ? await session.getPage(ref.id) : null;
    const paper = session.node.paper || settings.get('defaultPaper');
    if (refPage && !refPage.pdf) {
      return { w: refPage.w, h: refPage.h, bg: { ...refPage.bg } };
    }
    // Página en blanco para un documento PDF: tamaño de la página actual y papel predeterminado.
    const size = ref ? { w: ref.w, h: ref.h } : pageSizeFor(paper.size, paper.orientation);
    return { w: size.w, h: size.h, bg: normalizeBg({ template: paper.template || 'blank', color: paper.color || '#ffffff', spacing: paper.spacing || 28 }) };
  }

  async addPage(pane = this.activePane, { atEnd = false, before = false } = {}) {
    if (!pane || pane.session.readOnly) return;
    const s = pane.session;
    const cur = this.currentPageIndex(pane);
    const refIndex = atEnd ? s.node.pages.length - 1 : cur;
    const tpl = await this.newPageLike(s, refIndex);
    const index = atEnd ? s.node.pages.length : before ? cur : cur + 1;
    s.insertPage(index, tpl);
    requestAnimationFrame(() => pane.viewer.scrollToPage(index, { smooth: true }));
  }

  /** Tras cada trazo: añadir página automáticamente al escribir al final, o agrandar la pizarra. */
  afterStroke(viewer, pageIndex, bbox) {
    const s = viewer.session;
    const ref = s.node.pages[pageIndex];
    if (!ref || s.readOnly) return;
    const page = s.getPageSync(ref.id);
    if (!page) return;
    const infinite = !!(s.node.paper && s.node.paper.size === 'infinite');
    if (infinite) {
      let w = page.w;
      let hh = page.h;
      if (bbox.maxY > hh - 320) hh += 900;
      if (bbox.maxX > w - 320) w += 900;
      if (w !== page.w || hh !== page.h) s.resizePage(ref.id, w, hh);
      return;
    }
    if (!settings.get('autoAddPages') || !s.node.autoAddPages) return;
    if (pageIndex !== s.node.pages.length - 1) return;
    if (this.autoAdded.has(ref.id)) return;
    if (bbox.maxY > page.h * 0.8) {
      this.autoAdded.add(ref.id);
      this.newPageLike(s, pageIndex).then(tpl => {
        s.insertPage(s.node.pages.length, tpl);
        toast('Página añadida al final', { type: 'info', duration: 1600 });
      });
    }
  }

  async deletePage(pane = this.activePane, index = this.currentPageIndex(pane)) {
    const s = pane.session;
    if (s.readOnly) return;
    if (s.node.pages.length <= 1) {
      toast('Un documento necesita al menos una página', { type: 'warn' });
      return;
    }
    const ok = await confirmDialog(`Se borrará la página ${index + 1}. Puedes deshacerlo y además queda una copia en el historial de versiones.`, { title: '¿Borrar página?', confirmLabel: 'Borrar página', danger: true });
    if (!ok) return;
    this.selection.clear();
    await s.deletePage(s.node.pages[index].id);
    toast('Página borrada', { type: 'success', action: { label: 'Deshacer', fn: () => s.undo() } });
  }

  async duplicatePage(pane = this.activePane, index = this.currentPageIndex(pane)) {
    const s = pane.session;
    if (s.readOnly) return;
    await s.duplicatePage(s.node.pages[index].id);
    requestAnimationFrame(() => pane.viewer.scrollToPage(index + 1, { smooth: true }));
  }

  async clearCurrentPage() {
    const pane = this.activePane;
    if (!pane || pane.session.readOnly) return;
    const s = pane.session;
    const ref = s.node.pages[this.currentPageIndex(pane)];
    const page = await s.getPage(ref.id);
    if (!page.strokes.length && !page.images.length) {
      toast('La página ya está vacía', { type: 'info' });
      return;
    }
    const ok = await confirmDialog('Se borrarán todos los trazos e imágenes de esta página. Puedes deshacerlo.', { title: '¿Borrar la página entera?', confirmLabel: 'Borrar todo', danger: true });
    if (!ok) return;
    this.selection.clear();
    const ops = [];
    if (page.strokes.length) ops.push({ key: 'strokes', index: 0, removed: [...page.strokes], added: [] });
    if (page.images.length) ops.push({ key: 'images', index: 0, removed: [...page.images], added: [] });
    s.commit(ref.id, ops, { label: 'Borrar página' });
    toast('Página borrada', { type: 'success', action: { label: 'Deshacer', fn: () => this.undo() } });
  }

  // =====================================================================
  // Imágenes
  // =====================================================================

  insertImage() {
    if (!this.session || this.isReadOnly()) return;
    const input = h('input', { type: 'file', accept: 'image/*', style: { display: 'none' } });
    document.body.appendChild(input);
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (file) await this.insertImageFile(file);
    });
    input.click();
    setTimeout(() => input.isConnected && !input.files?.length && input.remove(), 60000);
  }

  async insertImageFile(file, pane = this.activePane) {
    if (!pane || pane.session.readOnly) return;
    const stop = toast('Insertando imagen…', { duration: 0 });
    try {
      const { blobId, width, height } = await importImageFile(file);
      const s = pane.session;
      const v = pane.viewer;
      const index = v.currentPage;
      const ref = s.node.pages[index];
      const page = await s.getPage(ref.id);
      const vis = v.visiblePageRect(index) || { x: 0, y: 0, w: page.w, h: page.h };
      const maxW = Math.min(page.w * 0.7, vis.w * 0.8);
      const maxH = Math.min(page.h * 0.7, vis.h * 0.8);
      const k = Math.min(1, maxW / width, maxH / height);
      const w = Math.max(20, width * k);
      const hh = Math.max(20, height * k);
      const img = { id: uid('i'), blobId, x: vis.x + (vis.w - w) / 2, y: vis.y + (vis.h - hh) / 2, w, h: hh, rot: 0 };
      s.addImages(ref.id, [img], { label: 'Imagen', origin: v });
      this.useLasso();
      this.selection.set(v, ref.id, new Set(), new Set([img.id]));
    } catch (err) {
      console.error(err);
      alertDialog(`No se pudo insertar la imagen: ${err.message || err}`);
    } finally {
      stop();
    }
  }

  // =====================================================================
  // Zoom
  // =====================================================================

  buildZoomControls(viewer) {
    const minus = h('button.btn.btn-icon', { type: 'button', title: 'Alejar', 'aria-label': 'Alejar' }, iconEl('minus'));
    const plus = h('button.btn.btn-icon', { type: 'button', title: 'Acercar', 'aria-label': 'Acercar' }, iconEl('plus'));
    const label = h('button.zoom-label', { type: 'button', title: 'Opciones de zoom' }, '100%');
    minus.addEventListener('click', () => viewer.setZoom(viewer.zoom / 1.2));
    plus.addEventListener('click', () => viewer.setZoom(viewer.zoom * 1.2));
    label.addEventListener('click', () => openMenu(label, [
      { label: 'Ajustar al ancho', icon: 'fit', onClick: () => viewer.fitWidth() },
      { label: '100 %', onClick: () => viewer.setZoom(1) },
      { label: '150 %', onClick: () => viewer.setZoom(1.5) },
      { label: '200 %', onClick: () => viewer.setZoom(2) }
    ], { placement: 'above' }));
    const el = h('div.zoom-controls', minus, label, plus);
    el.addEventListener('pointerdown', e => e.stopPropagation());
    el.hidden = !settings.get('showZoomControls');
    return { el, label };
  }

  // =====================================================================
  // Pantalla dividida
  // =====================================================================

  applySplitRatio() {
    if (this.panes.length < 2) return;
    const ratio = Math.min(0.8, Math.max(0.2, settings.get('splitRatio') || 0.5));
    this.panes[0].el.style.flex = `${ratio} 1 0`;
    this.panes[1].el.style.flex = `${1 - ratio} 1 0`;
  }

  bindDivider() {
    const d = this.divider;
    let active = false;
    d.addEventListener('pointerdown', e => {
      active = true;
      d.setPointerCapture(e.pointerId);
      d.classList.add('dragging');
      e.preventDefault();
    });
    d.addEventListener('pointermove', e => {
      if (!active || this.panes.length < 2) return;
      const r = this.body.getBoundingClientRect();
      const stacked = this.body.classList.contains('stacked');
      const raw = stacked ? (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
      const ratio = Math.min(0.8, Math.max(0.2, raw));
      this.panes[0].el.style.flex = `${ratio} 1 0`;
      this.panes[1].el.style.flex = `${1 - ratio} 1 0`;
      this._ratio = ratio;
    });
    const end = () => {
      if (!active) return;
      active = false;
      d.classList.remove('dragging');
      if (this._ratio) settings.set('splitRatio', this._ratio);
    };
    d.addEventListener('pointerup', end);
    d.addEventListener('pointercancel', end);
    // Doble toque en el divisor: repartir al 50 %.
    d.addEventListener('dblclick', () => {
      settings.set('splitRatio', 0.5);
      this.applySplitRatio();
    });
  }

  async openSplit() {
    if (this.panes.length >= 2) return;
    const id = await this.app.pickDocument({ title: 'Pantalla dual: abrir al lado', hint: 'Puedes elegir también este mismo documento para ver dos partes a la vez.' });
    if (!id) return;
    await this.addPane(id);
  }

  // =====================================================================
  // Menús
  // =====================================================================

  openMoreMenu(anchor) {
    const pane = this.activePane;
    if (!pane) return;
    const ro = this.isReadOnly();
    openMenu(anchor, [
      { title: 'Documento' },
      { label: 'Exportar PDF o imagen…', icon: 'share', onClick: () => this.app.openExport(pane.session, pane.viewer.currentPage) },
      { label: 'Historial de versiones…', icon: 'history', onClick: () => this.app.openVersions(pane.session) },
      { label: 'Renombrar…', icon: 'edit', disabled: ro, onClick: () => this.renameDoc() },
      { label: pane.session.node.favorite ? 'Quitar de favoritos' : 'Añadir a favoritos', icon: 'star', onClick: () => this.toggleFavorite(pane) },
      this.panes.length < 2
        ? { label: 'Pantalla dual…', icon: 'split', onClick: () => this.openSplit() }
        : { label: 'Cerrar este panel', icon: 'x', onClick: () => this.closePane(pane) },
      this.search.isOpen() || !$('#btn-ed-search').hidden
        ? { label: 'Buscar en el PDF', icon: 'search', hint: 'Ctrl+F', onClick: () => this.search.open() }
        : null,
      pane.session.node.pdf && pane.session.node.pdf.blobId
        ? { label: 'Índice del PDF…', icon: 'toc', onClick: () => this.openPagesPanel({ tab: 'toc' }) }
        : null,
      { label: 'Páginas marcadas…', icon: 'bookmark', onClick: () => this.openPagesPanel({ tab: 'bookmarks' }) },
      'sep',
      { title: 'Página actual' },
      (() => {
        const pid = this.currentPageId(pane);
        const on = !!(pid && pane.session.isBookmarked(pid));
        return { label: on ? 'Quitar marcador' : 'Marcar página', icon: 'bookmark', disabled: ro, onClick: () => this.toggleBookmark(pane, pid) };
      })(),
      { label: 'Añadir página después', icon: 'filePlus', disabled: ro, onClick: () => this.addPage(pane) },
      { label: 'Fondo de página…', icon: 'grid', disabled: ro, onClick: () => this.app.openPageBackground(this, pane) },
      { label: 'Duplicar página', icon: 'copy', disabled: ro, onClick: () => this.duplicatePage(pane) },
      { label: 'Borrar página', icon: 'trash', danger: true, disabled: ro, onClick: () => this.deletePage(pane) },
      'sep',
      { label: 'Ajustes', icon: 'settings', onClick: () => this.app.openSettings() }
    ]);
  }

  async toggleFavorite(pane) {
    const value = !pane.session.node.favorite;
    try {
      await repo.setFavorite([pane.session.id], value);
      pane.session.node.favorite = value;
      toast(value ? 'Añadido a favoritos' : 'Quitado de favoritos', { type: 'success' });
      this.app.broadcast();
    } catch (err) {
      toast(`No se pudo cambiar: ${err.message || err}`, { type: 'error' });
    }
  }

  openPagesPanel(opts = {}) {
    const pane = this.activePane;
    if (pane) this.app.openPagesPanel(this, pane, opts);
  }

  // =====================================================================
  // Teclado y portapapeles
  // =====================================================================

  bindKeyboard() {
    window.addEventListener('keydown', e => {
      if (!this.isOpen() || this.screen.hidden) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (isModalOpen()) return;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) this.redo();
        else this.undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        this.redo();
      } else if (mod && k === 'f') {
        e.preventDefault();
        if (!$('#btn-ed-search').hidden) this.search.open();
        else toast('Este documento no tiene páginas de PDF en las que buscar', { type: 'info' });
      } else if (mod && (k === '=' || k === '+')) {
        e.preventDefault();
        this.viewer && this.viewer.setZoom(this.viewer.zoom * 1.2);
      } else if (mod && k === '-') {
        e.preventDefault();
        this.viewer && this.viewer.setZoom(this.viewer.zoom / 1.2);
      } else if (mod && k === '0') {
        e.preventDefault();
        this.viewer && this.viewer.fitWidth();
      } else if (mod && k === 'c' && this.selection.active) {
        e.preventDefault();
        this.selection.copy();
      } else if (mod && k === 'x' && this.selection.active) {
        e.preventDefault();
        this.selection.cut();
      } else if (mod && k === 'd' && this.selection.active) {
        e.preventDefault();
        this.selection.duplicate();
      } else if ((k === 'delete' || k === 'backspace') && this.selection.active) {
        e.preventDefault();
        this.selection.remove();
      } else if (k === 'escape') {
        if (isPopoverOpen()) closePopover();
        else if (this.selection.active) this.selection.clear();
        else if (this.search.isOpen()) this.search.close();
      } else if (!mod && !e.altKey) {
        if (k === 'pagedown') this.viewer && this.viewer.scrollToPage(this.viewer.currentPage + 1);
        else if (k === 'pageup') this.viewer && this.viewer.scrollToPage(this.viewer.currentPage - 1);
        else if (k === 'e') this.setTool('eraser');
        else if (k === 'l') this.setTool('lasso');
        else if (k === 'p') this.setTool('pen');
        else if (/^[1-9]$/.test(k)) {
          const p = settings.get('presets')[parseInt(k, 10) - 1];
          if (p) this.selectPreset(p.id);
        }
      }
    });
    // Pegar: imágenes del portapapeles del sistema o elementos copiados con el lazo.
    window.addEventListener('paste', e => {
      if (!this.isOpen() || this.screen.hidden || isModalOpen()) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      const items = e.clipboardData ? [...e.clipboardData.items] : [];
      const img = items.find(it => it.kind === 'file' && it.type.startsWith('image/'));
      if (img) {
        e.preventDefault();
        const f = img.getAsFile();
        if (f) this.insertImageFile(f);
        return;
      }
      if (this.selection.clipboard && this.viewer) {
        e.preventDefault();
        this.selection.paste(this.viewer, this.viewer.currentPage, null);
      }
    });
  }

  /** Guarda todo de forma estricta (al ocultarse la app, antes de actualizar, etc.). */
  flushAll() {
    for (const p of this.panes) {
      try {
        p.session.setView(p.viewer.viewState());
      } catch {}
    }
    return flushAllSessions();
  }
}
