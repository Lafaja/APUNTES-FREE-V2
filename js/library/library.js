// Biblioteca: carpetas y documentos, búsqueda, recientes, papelera y selección múltiple.

import * as repo from '../core/repo.js';
import { settings } from '../core/settings.js';
import { formatDate, timeAgo, debounce } from '../core/util.js';
import { loadIfIndexed, queueIndex, indexFailed, textIndexEvents, findInPage, snippetAt, normalizeQuery } from '../core/textindex.js';
import { h, iconEl, $, $$, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openMenu } from '../ui/popover.js';
import { confirmDialog, promptDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

const FOLDER_COLORS = ['#3b82f6', '#0ea5e9', '#14b8a6', '#22c55e', '#84cc16', '#eab308', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#64748b', '#78350f'];
export { FOLDER_COLORS };

function norm(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

const FAV_STAR = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';

function folderSvg(color) {
  return `<svg viewBox="0 0 150 124" aria-hidden="true"><path d="M8 20a10 10 0 0 1 10-10h38l12 12h64a10 10 0 0 1 10 10v74a10 10 0 0 1-10 10H18a10 10 0 0 1-10-10z" fill="${color}" opacity="0.55"/><path d="M8 38a10 10 0 0 1 10-10h114a10 10 0 0 1 10 10v68a10 10 0 0 1-10 10H18a10 10 0 0 1-10-10z" fill="${color}"/><path d="M8 38a10 10 0 0 1 10-10h114a10 10 0 0 1 10 10v6H8z" fill="#fff" opacity="0.18"/></svg>`;
}

export class Library {
  constructor(app) {
    this.app = app;
    this.screen = $('#screen-library');
    this.grid = $('#lib-grid');
    this.empty = $('#lib-empty');
    this.nodes = new Map();
    this.folderId = null;
    this.tab = 'docs';
    this.query = '';
    this.selecting = false;
    this.selected = new Set();
    this.thumbUrls = new Map(); // docId -> { url, rev }
    this.io = 'IntersectionObserver' in window ? new IntersectionObserver(entries => this.onCardsVisible(entries), { root: $('#lib-content'), rootMargin: '300px' }) : null;
    // Búsqueda dentro del texto de los PDF (asíncrona, con indexado en segundo plano).
    this.textBox = $('#lib-text-results');
    this.textToken = 0;
    this.nameMatches = 0;
    this._textSearchSoon = debounce(() => this.searchPdfText(), 220);
    const refresh = () => {
      if (this.query && !this.screen.hidden) this._textSearchSoon();
    };
    textIndexEvents.on('indexed', refresh);
    textIndexEvents.on('failed', refresh); // un PDF dañado deja de figurar como "preparando"
    this.bind();
  }

  // ------------------------------------------------------------------
  // Datos
  // ------------------------------------------------------------------

  async reload() {
    const all = await repo.loadAllNodes();
    this.nodes = new Map(all.map(n => [n.id, n]));
    if (this.folderId && !this.isAlive(this.folderId)) this.folderId = null;
    this.render();
  }

  /** Vivo = ni él ni ninguna carpeta superior están en la papelera (y sus padres existen). */
  isAlive(id) {
    let cur = this.nodes.get(id);
    const seen = new Set();
    while (cur) {
      if (cur.deletedAt || seen.has(cur.id)) return false;
      seen.add(cur.id);
      if (!cur.parentId) return true;
      cur = this.nodes.get(cur.parentId);
    }
    return false;
  }

  children(parentId) {
    const out = [];
    for (const n of this.nodes.values()) {
      if ((n.parentId || null) === (parentId || null) && !n.deletedAt) out.push(n);
    }
    // Huérfanos (su carpeta ya no existe): se muestran en la raíz para que nunca se "pierdan".
    if (!parentId) {
      for (const n of this.nodes.values()) {
        if (n.parentId && !this.nodes.has(n.parentId) && !n.deletedAt) out.push(n);
      }
    }
    return out;
  }

  sortNodes(list) {
    const mode = settings.get('sort');
    const cmp = {
      updated: (a, b) => (b.updatedAt || 0) - (a.updatedAt || 0),
      created: (a, b) => (b.createdAt || 0) - (a.createdAt || 0),
      name: (a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' })
    }[mode] || ((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    const folders = list.filter(n => n.kind === 'folder').sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true, sensitivity: 'base' }));
    const docs = list.filter(n => n.kind === 'doc').sort(cmp);
    return [...folders, ...docs];
  }

  countIn(folderId) {
    let c = 0;
    for (const n of this.nodes.values()) if (n.parentId === folderId && !n.deletedAt) c++;
    return c;
  }

  pathOf(node) {
    const parts = [];
    let cur = node.parentId ? this.nodes.get(node.parentId) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? this.nodes.get(cur.parentId) : null;
    }
    return parts.join(' › ');
  }

  // ------------------------------------------------------------------
  // Eventos de la interfaz
  // ------------------------------------------------------------------

  bind() {
    $$('.lib-tab').forEach(b => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
    const search = $('#lib-search');
    search.addEventListener('input', () => {
      this.query = search.value.trim();
      this.render();
    });
    $('#btn-lib-new').addEventListener('click', e => this.openNewMenu(e.currentTarget));
    $('#btn-lib-settings').addEventListener('click', () => this.app.openSettings());
    $('#btn-lib-select').addEventListener('click', () => (this.selecting ? this.exitSelect() : this.enterSelect()));
    $('#btn-lib-sort').addEventListener('click', e => this.openSortMenu(e.currentTarget));
    $('#btn-lib-empty-trash').addEventListener('click', () => this.emptyTrash());
    $('#lib-selection-bar').addEventListener('click', e => {
      const b = e.target.closest('[data-sel]');
      if (b) this.onSelectionAction(b.dataset.sel);
    });
    window.addEventListener('keydown', e => {
      if (this.screen.hidden) return;
      if (e.key === 'Escape' && this.selecting) this.exitSelect();
    });
    this.updateSortLabel();
    this.bindDrag();
  }

  setTab(tab) {
    this.tab = tab;
    this.exitSelect();
    $$('.lib-tab').forEach(b => {
      b.classList.toggle('active', b.dataset.tab === tab);
      b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false');
    });
    this.render();
  }

  openFolder(id) {
    this.folderId = id;
    this.tab = 'docs';
    $$('.lib-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'docs'));
    if (this.query) {
      this.query = '';
      $('#lib-search').value = '';
    }
    this.exitSelect();
    this.render();
    $('#lib-content').scrollTop = 0;
  }

  openNewMenu(anchor) {
    openMenu(anchor, [
      { label: 'Nuevo apunte', icon: 'filePlus', onClick: () => this.app.newNote(this.folderId) },
      { label: 'Nueva carpeta', icon: 'folderPlus', onClick: () => this.app.newFolder(this.folderId) },
      { label: 'Importar PDF…', icon: 'fileUp', onClick: () => this.app.importPdf(this.folderId) },
      'sep',
      { label: 'Pantalla dual…', icon: 'split', hint: 'Dos documentos a la vez', onClick: () => this.app.openDual() }
    ]);
  }

  openSortMenu(anchor) {
    const cur = settings.get('sort');
    const mk = (id, label) => ({ label: `${cur === id ? '✓ ' : ''}${label}`, onClick: () => {
      settings.set('sort', id);
      this.updateSortLabel();
      this.render();
    } });
    openMenu(anchor, [mk('updated', 'Última modificación'), mk('created', 'Fecha de creación'), mk('name', 'Nombre')]);
  }

  updateSortLabel() {
    const labels = { updated: 'Modificado', created: 'Creado', name: 'Nombre' };
    $('#lib-sort-label').textContent = labels[settings.get('sort')] || 'Modificado';
  }

  // ------------------------------------------------------------------
  // Renderizado
  // ------------------------------------------------------------------

  render() {
    if (this.io) this.io.disconnect();
    clear(this.grid);
    this.renderBreadcrumbs();
    const inTrash = this.tab === 'trash';
    $('#btn-lib-empty-trash').hidden = !inTrash;
    $('#btn-lib-sort').hidden = inTrash || this.tab === 'recent';
    document.body.classList.toggle('lib-selecting', this.selecting);

    let list;
    if (this.query) {
      const q = norm(this.query);
      list = this.sortNodes([...this.nodes.values()].filter(n => this.isAlive(n.id) && norm(n.name).includes(q)));
    } else if (this.tab === 'favs') {
      list = this.sortNodes([...this.nodes.values()].filter(n => n.favorite && this.isAlive(n.id)));
    } else if (this.tab === 'recent') {
      list = [...this.nodes.values()].filter(n => n.kind === 'doc' && this.isAlive(n.id)).sort((a, b) => (b.openedAt || b.updatedAt || 0) - (a.openedAt || a.updatedAt || 0)).slice(0, 40);
    } else if (inTrash) {
      list = [...this.nodes.values()].filter(n => n.deletedAt && !this.hasTrashedAncestor(n)).sort((a, b) => b.deletedAt - a.deletedAt);
    } else {
      list = this.sortNodes(this.children(this.folderId));
    }

    const docs = list.filter(n => n.kind === 'doc').length;
    const folders = list.length - docs;
    $('#lib-stats').textContent = list.length ? `${folders ? `${folders} carpeta${folders === 1 ? '' : 's'}` : ''}${folders && docs ? ' · ' : ''}${docs ? `${docs} documento${docs === 1 ? '' : 's'}` : ''}` : '';

    this.nameMatches = list.length;
    const textSearch = this.startTextSearch();
    if (!list.length) {
      // Con búsqueda de texto en marcha, "Sin resultados" solo se muestra si tampoco hay nada dentro de los PDF.
      if (textSearch) this.empty.hidden = true;
      else this.renderEmpty();
      return;
    }
    this.empty.hidden = true;
    const frag = document.createDocumentFragment();
    for (const n of list) frag.appendChild(this.card(n, { showPath: !!this.query || this.tab === 'recent' || this.tab === 'favs' }));
    this.grid.appendChild(frag);
    this.updateSelectionBar();
  }

  hasTrashedAncestor(n) {
    let cur = n.parentId ? this.nodes.get(n.parentId) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      if (cur.deletedAt) return true;
      cur = cur.parentId ? this.nodes.get(cur.parentId) : null;
    }
    return false;
  }

  renderEmpty() {
    const e = this.empty;
    clear(e);
    e.hidden = false;
    if (this.query) {
      e.append(iconEl('search'), h('h2', 'Sin resultados'), h('p', `Ningún nombre de documento o carpeta, ni el texto de ningún PDF, contiene «${this.query}».`));
    } else if (this.tab === 'trash') {
      e.append(iconEl('trash'), h('h2', 'La papelera está vacía'), h('p', 'Lo que elimines aparecerá aquí y podrás restaurarlo cuando quieras.'));
    } else if (this.tab === 'favs') {
      e.append(iconEl('star'), h('h2', 'Sin favoritos'), h('p', 'Marca documentos o carpetas con la estrella (menú ⋮ → «Añadir a favoritos») para tenerlos siempre a mano aquí.'));
    } else if (this.tab === 'recent') {
      e.append(iconEl('history'), h('h2', 'Nada reciente'), h('p', 'Los documentos que abras aparecerán aquí.'));
    } else {
      const row = h('div.btn-row');
      const n = h('button.btn.btn-primary', { type: 'button' }, iconEl('filePlus'), 'Nuevo apunte');
      n.addEventListener('click', () => this.app.newNote(this.folderId));
      const f = h('button.btn.btn-outline', { type: 'button' }, iconEl('folderPlus'), 'Nueva carpeta');
      f.addEventListener('click', () => this.app.newFolder(this.folderId));
      const p = h('button.btn.btn-outline', { type: 'button' }, iconEl('fileUp'), 'Importar PDF');
      p.addEventListener('click', () => this.app.importPdf(this.folderId));
      row.append(n, f, p);
      e.append(iconEl(this.folderId ? 'folder' : 'fileText'), h('h2', this.folderId ? 'Carpeta vacía' : 'Empieza tu primer apunte'), h('p', 'Crea un apunte, una carpeta o importa un PDF para anotarlo.'), row);
    }
  }

  // ------------------------------------------------------------------
  // Búsqueda dentro del texto de los PDF
  // ------------------------------------------------------------------

  pdfDocs() {
    const out = [];
    for (const n of this.nodes.values()) {
      if (n.kind === 'doc' && n.pdf && n.pdf.blobId && this.isAlive(n.id)) out.push(n);
    }
    return out;
  }

  /** Programa la búsqueda en el texto de los PDF. Devuelve true si hay una en marcha. */
  startTextSearch() {
    const nq = this.query ? normalizeQuery(this.query) : '';
    this.textToken++;
    if (nq.length < 2 || !this.pdfDocs().length) {
      this.textBox.hidden = true;
      clear(this.textBox);
      return false;
    }
    if (this.textBox.hidden || !this.textBox.firstChild) this.renderTextResults({ searching: true });
    else this.textBox.classList.add('stale'); // se mantienen los anteriores atenuados hasta tener los nuevos
    this._textSearchSoon();
    return true;
  }

  async searchPdfText() {
    const token = ++this.textToken;
    const query = this.query;
    const nq = normalizeQuery(query);
    if (nq.length < 2) return;
    const results = [];
    const pending = new Set();
    for (const n of this.pdfDocs()) {
      const blobId = n.pdf.blobId;
      let entry = null;
      try {
        entry = await loadIfIndexed(blobId);
      } catch {}
      if (token !== this.textToken) return;
      if (!entry) {
        if (!indexFailed(blobId)) pending.add(blobId);
        continue;
      }
      let count = 0;
      let first = null;
      for (let i = 0; i < entry.pages.length; i++) {
        const occ = findInPage(entry, i, nq);
        if (!occ.length) continue;
        if (!first) first = { page: i, s: occ[0].s, e: occ[0].e };
        count += occ.length;
      }
      if (count) results.push({ node: n, count, first, snippet: snippetAt(entry, first.page, first.s, first.e) });
    }
    if (pending.size) queueIndex([...pending]);
    results.sort((a, b) => b.count - a.count || a.node.name.localeCompare(b.node.name, 'es', { numeric: true, sensitivity: 'base' }));
    this.renderTextResults({ results, pending: pending.size, query });
  }

  renderTextResults({ results = [], pending = 0, query = this.query, searching = false } = {}) {
    const box = this.textBox;
    box.classList.remove('stale');
    clear(box);
    if (!results.length && !pending && !searching) {
      box.hidden = true;
      if (!this.nameMatches && this.query) this.renderEmpty();
      return;
    }
    box.hidden = false;
    if (!this.nameMatches) this.empty.hidden = true;
    const total = results.reduce((a, r) => a + r.count, 0);
    box.appendChild(h('div.text-results-head',
      h('h3.text-results-title', 'Dentro de los PDF'),
      results.length ? h('span.text-results-count', `${total} coincidencia${total === 1 ? '' : 's'} en ${results.length} documento${results.length === 1 ? '' : 's'}`) : null));
    if (searching || pending) {
      const msg = searching
        ? 'Buscando en el texto de los PDF…'
        : `Preparando ${pending} PDF para poder buscar en su texto… (solo la primera vez)`;
      box.appendChild(h('div.text-results-status', h('span.mini-spinner'), msg));
    }
    const MAX = 40;
    for (const r of results.slice(0, MAX)) box.appendChild(this.textHitRow(r, query));
    if (results.length > MAX) box.appendChild(h('div.text-results-status', `Y ${results.length - MAX} documentos más. Escribe algo más concreto para acotar.`));
  }

  textHitRow(r, query) {
    const n = r.node;
    // Nº de página solo si el documento conserva las páginas del PDF tal cual (si no, podría no coincidir).
    const samePages = (n.pages || []).length === n.pdf.pageCount;
    const snippet = h('span.text-hit-snippet',
      samePages ? h('span.text-hit-page', `Pág. ${r.first.page + 1}`) : null,
      r.snippet.before, h('mark', r.snippet.match), r.snippet.after);
    const path = this.pathOf(n);
    const row = h('button.text-hit', { type: 'button', title: `Abrir «${n.name}» y buscar «${query}»` },
      h('span.text-hit-icon', { html: icon('fileText') }),
      h('span.text-hit-body',
        h('span.text-hit-top',
          h('span.text-hit-name', n.name),
          h('span.text-hit-count', `${r.count} coincidencia${r.count === 1 ? '' : 's'}`)),
        snippet,
        path ? h('span.text-hit-path', path) : null));
    row.addEventListener('click', () => {
      this.app.openDocument(n.id, { search: { query, blobId: n.pdf.blobId, pdfIndex: r.first.page } });
    });
    return row;
  }

  renderBreadcrumbs() {
    const bc = $('#lib-breadcrumbs');
    clear(bc);
    if (this.query) {
      bc.appendChild(h('span.crumb.current', `Resultados de «${this.query}»`));
      return;
    }
    if (this.tab === 'trash') {
      bc.appendChild(h('span.crumb.current', 'Papelera'));
      return;
    }
    if (this.tab === 'recent') {
      bc.appendChild(h('span.crumb.current', 'Recientes'));
      return;
    }
    if (this.tab === 'favs') {
      bc.appendChild(h('span.crumb.current', 'Favoritos'));
      return;
    }
    const chain = [];
    let cur = this.folderId ? this.nodes.get(this.folderId) : null;
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      chain.unshift(cur);
      cur = cur.parentId ? this.nodes.get(cur.parentId) : null;
    }
    const root = h(`button.crumb${chain.length ? '' : '.current'}`, { type: 'button', dataset: { dropFolder: '' } }, 'Documentos');
    root.addEventListener('click', () => this.openFolder(null));
    bc.appendChild(root);
    chain.forEach((f, i) => {
      bc.appendChild(h('span.crumb-sep', { html: icon('chevronRight') }));
      const c = h(`button.crumb${i === chain.length - 1 ? '.current' : ''}`, { type: 'button', dataset: { dropFolder: f.id } }, f.name);
      c.addEventListener('click', () => this.openFolder(f.id));
      bc.appendChild(c);
    });
    if (chain.length) {
      const last = chain[chain.length - 1];
      const more = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Opciones de la carpeta' }, iconEl('more'));
      more.addEventListener('click', e => this.openNodeMenu(last, e.currentTarget));
      bc.appendChild(more);
    }
  }

  card(n, { showPath = false } = {}) {
    const isFolder = n.kind === 'folder';
    const card = h('div.card', { role: 'listitem', tabindex: '0', dataset: { id: n.id } });
    const visual = h('div.card-visual');
    if (isFolder) {
      visual.appendChild(h('div.card-folder', { html: folderSvg(n.color || '#3b82f6') }));
    } else {
      const ph = h('div.card-thumb.placeholder', { html: icon(n.source === 'pdf' ? 'fileText' : 'edit') });
      visual.appendChild(ph);
      if (n.source === 'pdf') visual.appendChild(h('span.card-badge', 'PDF'));
      card._thumbTarget = visual;
      if (this.io) this.io.observe(card);
      else this.loadThumb(card);
    }
    visual.appendChild(h('span.card-check', { html: icon('check') }));
    let meta;
    if (n.deletedAt) meta = `Eliminado ${timeAgo(n.deletedAt)}`;
    else if (isFolder) {
      const c = this.countIn(n.id);
      meta = `${c} elemento${c === 1 ? '' : 's'}`;
    } else {
      const pages = (n.pages || []).length;
      meta = `${pages} pág. · ${formatDate(n.updatedAt)}`;
    }
    if (showPath && !n.deletedAt) {
      const p = this.pathOf(n);
      meta = `${p ? p + ' · ' : ''}${meta}`;
    }
    const menuBtn = h('button.btn.btn-icon.card-menu-btn', { type: 'button', 'aria-label': 'Opciones' }, iconEl('moreV'));
    menuBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.openNodeMenu(n, menuBtn);
    });
    const title = h('div.card-title', { title: n.name }, n.favorite && !n.deletedAt ? h('span.fav-star', { html: FAV_STAR, title: 'Favorito' }) : null, n.name);
    card.append(visual, h('div.card-info', h('div.card-text', title, h('div.card-meta', meta)), menuBtn));
    if (this.selected.has(n.id)) card.classList.add('selected');

    card.addEventListener('click', e => {
      if (e.target.closest('.card-menu-btn')) return;
      if (this.selecting) {
        this.toggleSelect(n.id, card);
        return;
      }
      if (n.deletedAt) {
        this.openNodeMenu(n, card.querySelector('.card-visual'));
        return;
      }
      if (isFolder) this.openFolder(n.id);
      else this.app.openDocument(n.id);
    });
    card.addEventListener('keydown', e => {
      if (e.key === 'Enter') card.click();
    });
    // Pulsación larga y arrastrar para mover: ver bindDrag().
    return card;
  }

  /** Pulsación larga sobre una tarjeta: entra en selección múltiple con ella marcada. */
  longPressSelect(card) {
    const id = card.dataset.id;
    if (!this.nodes.has(id)) return;
    if (!this.selecting) this.enterSelect();
    if (!this.selected.has(id)) this.toggleSelect(id, card);
  }

  // ------------------------------------------------------------------
  // Arrastrar para mover a una carpeta (o a una carpeta superior de la ruta)
  //  - Ratón: arrastrar directamente.
  //  - Dedo o lápiz: mantener pulsado (la tarjeta "se levanta") y arrastrar.
  //    Si se suelta sin arrastrar, se entra en selección múltiple (como antes).
  // ------------------------------------------------------------------

  bindDrag() {
    this._dragMove = e => this.dragMove(e);
    this._dragUp = e => this.dragUp(e);
    this._dragCancel = e => this.dragCancel(e);
    this.grid.addEventListener('pointerdown', e => this.dragDown(e));
    // Mientras se arrastra con el dedo, la lista no debe desplazarse.
    $('#lib-content').addEventListener('touchmove', e => {
      if (this.drag && (this.drag.armed || this.drag.active) && this.drag.pointerType !== 'mouse') e.preventDefault();
    }, { passive: false });
    // Después de arrastrar o de una pulsación larga, el "click" final no debe abrir nada.
    this.grid.addEventListener('click', e => {
      if (this._suppressClick && Date.now() - this._suppressClick < 500) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
      this._suppressClick = 0;
    }, true);
    this.grid.addEventListener('contextmenu', e => {
      const card = e.target.closest('.card');
      if (!card) return;
      e.preventDefault();
      if (this.drag && this.drag.pointerType !== 'mouse') return; // la pulsación larga táctil se gestiona aparte
      this.longPressSelect(card);
    });
  }

  dragDown(e) {
    if (this.drag) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    const card = e.target.closest('.card');
    if (!card || e.target.closest('.card-menu-btn')) return;
    const n = this.nodes.get(card.dataset.id);
    if (!n) return;
    const canDrag = this.tab !== 'trash' && !n.deletedAt;
    const d = {
      pointerId: e.pointerId, pointerType: e.pointerType, sx: e.clientX, sy: e.clientY, x: e.clientX, y: e.clientY,
      card, node: n, canDrag, armed: e.pointerType === 'mouse' && canDrag, active: false, longPressed: false, timer: null
    };
    this.drag = d;
    if (e.pointerType !== 'mouse') {
      d.timer = setTimeout(() => {
        if (this.drag !== d || d.active) return;
        d.armed = d.canDrag;
        d.longPressed = true;
        card.classList.add('lifted');
        if (navigator.vibrate) try { navigator.vibrate(12); } catch {}
      }, 420);
    }
    window.addEventListener('pointermove', this._dragMove, { passive: false });
    window.addEventListener('pointerup', this._dragUp);
    window.addEventListener('pointercancel', this._dragCancel);
  }

  dragMove(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (!d.active) {
      const dist = Math.hypot(d.x - d.sx, d.y - d.sy);
      if (!d.armed) {
        if (dist > 10) this.dragCleanup(); // era un desplazamiento de la lista
        return;
      }
      if (dist < 6) return;
      this.dragStart();
    }
    e.preventDefault();
    this.dragUpdate();
  }

  descendantIds(folderIds) {
    const out = new Set();
    const stack = [...folderIds];
    while (stack.length) {
      const id = stack.pop();
      for (const n of this.nodes.values()) {
        if (n.parentId === id && !out.has(n.id)) {
          out.add(n.id);
          stack.push(n.id);
        }
      }
    }
    return out;
  }

  dragStart() {
    const d = this.drag;
    d.active = true;
    clearTimeout(d.timer);
    d.card.classList.remove('lifted');
    d.ids = this.selecting && this.selected.has(d.node.id) ? [...this.selected] : [d.node.id];
    d.origins = d.ids.map(id => ({ id, parentId: this.nodes.get(id)?.parentId || null }));
    d.forbidden = this.descendantIds(d.ids.filter(id => this.nodes.get(id)?.kind === 'folder'));
    for (const id of d.ids) d.forbidden.add(id);
    const ghost = h('div.drag-ghost');
    const vis = d.card.querySelector('.card-thumb, .card-folder svg');
    if (vis) ghost.appendChild(vis.cloneNode(true));
    ghost.appendChild(h('div.drag-ghost-name', d.ids.length > 1 ? `${d.ids.length} elementos` : d.node.name));
    if (d.ids.length > 1) ghost.appendChild(h('span.drag-ghost-count', String(d.ids.length)));
    document.body.appendChild(ghost);
    d.ghost = ghost;
    for (const id of d.ids) this.grid.querySelector(`.card[data-id="${CSS.escape(id)}"]`)?.classList.add('dragging');
    document.body.classList.add('lib-dragging');
    this.dragAutoScroll();
  }

  dragUpdate() {
    const d = this.drag;
    if (!d || !d.active) return;
    d.ghost.style.transform = `translate(${Math.round(d.x - 48)}px, ${Math.round(d.y - 64)}px)`;
    const el = document.elementFromPoint(d.x, d.y);
    let target;
    let targetEl = null;
    const card = el && el.closest('.card');
    if (card) {
      const n = this.nodes.get(card.dataset.id);
      if (n && n.kind === 'folder' && !n.deletedAt && !d.forbidden.has(n.id)) {
        target = n.id;
        targetEl = card;
      }
    } else {
      const crumb = el && el.closest('[data-drop-folder]');
      if (crumb) {
        const id = crumb.dataset.dropFolder || null;
        if (!id || !d.forbidden.has(id)) {
          target = id;
          targetEl = crumb;
        }
      }
    }
    // Soltar donde ya están no hace nada: no se resalta.
    if (targetEl && d.origins.every(o => o.parentId === target)) targetEl = null;
    if (d.targetEl !== targetEl) {
      if (d.targetEl) d.targetEl.classList.remove('drop-target');
      if (targetEl) targetEl.classList.add('drop-target');
      d.targetEl = targetEl;
    }
    d.target = targetEl ? target : undefined;
  }

  dragAutoScroll() {
    const d = this.drag;
    if (!d || !d.active) return;
    const content = $('#lib-content');
    const r = content.getBoundingClientRect();
    const edge = 70;
    let v = 0;
    if (d.y < r.top + edge) v = -Math.ceil((r.top + edge - d.y) / 4);
    else if (d.y > r.bottom - edge) v = Math.ceil((d.y - (r.bottom - edge)) / 4);
    if (v) {
      const before = content.scrollTop;
      content.scrollTop += v;
      if (content.scrollTop !== before) this.dragUpdate();
    }
    d.raf = requestAnimationFrame(() => this.dragAutoScroll());
  }

  async dragUp(e) {
    const d = this.drag;
    if (!d || e.pointerId !== d.pointerId) return;
    this.dragCleanup();
    if (d.active) {
      this._suppressClick = Date.now();
      if (d.targetEl) await this.moveByDrag(d.ids, d.target, d.origins);
      return;
    }
    if (d.longPressed) {
      this._suppressClick = Date.now();
      this.longPressSelect(d.card);
    }
  }

  dragCancel(e) {
    const d = this.drag;
    if (!d || (e && e.pointerId !== d.pointerId)) return;
    this.dragCleanup();
    // Algunos navegadores cancelan el puntero tras una pulsación larga: se trata como tal.
    if (!d.active && d.longPressed) this.longPressSelect(d.card);
  }

  dragCleanup() {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    clearTimeout(d.timer);
    if (d.raf) cancelAnimationFrame(d.raf);
    window.removeEventListener('pointermove', this._dragMove);
    window.removeEventListener('pointerup', this._dragUp);
    window.removeEventListener('pointercancel', this._dragCancel);
    d.card.classList.remove('lifted');
    if (d.targetEl) d.targetEl.classList.remove('drop-target');
    if (d.ghost) d.ghost.remove();
    $$('.card.dragging', this.grid).forEach(c => c.classList.remove('dragging'));
    document.body.classList.remove('lib-dragging');
  }

  async moveByDrag(ids, target, origins) {
    const destName = target ? this.nodes.get(target)?.name || 'la carpeta' : 'Documentos';
    const firstName = this.nodes.get(ids[0])?.name || '';
    try {
      const moved = await repo.moveNodes(ids, target);
      if (this.selecting) this.exitSelect();
      await this.reload();
      this.app.broadcast();
      if (!moved) return;
      toast(`${moved === 1 ? `«${firstName}» movido` : `${moved} elementos movidos`} a «${destName}»`, {
        type: 'success',
        duration: 5000,
        action: { label: 'Deshacer', fn: async () => {
          try {
            const byParent = new Map();
            for (const o of origins) {
              const k = o.parentId || '';
              if (!byParent.has(k)) byParent.set(k, []);
              byParent.get(k).push(o.id);
            }
            for (const [k, list] of byParent) await repo.moveNodes(list, k || null);
          } catch (err) {
            toast(err.message || 'No se pudo deshacer', { type: 'error' });
          }
          await this.reload();
          this.app.broadcast();
        } }
      });
    } catch (err) {
      toast(err.message || 'No se pudo mover', { type: 'error' });
    }
  }

  onCardsVisible(entries) {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      this.io.unobserve(en.target);
      this.loadThumb(en.target);
    }
  }

  async loadThumb(card) {
    const id = card.dataset.id;
    const n = this.nodes.get(id);
    if (!n) return;
    const cached = this.thumbUrls.get(id);
    let url = null;
    if (cached && cached.rev === n.thumbRev) {
      url = cached.url;
    } else {
      const t = await repo.getThumb(id).catch(() => null);
      if (t && t.data) {
        if (cached) URL.revokeObjectURL(cached.url);
        url = URL.createObjectURL(new Blob([t.data], { type: t.type || 'image/jpeg' }));
        this.thumbUrls.set(id, { url, rev: n.thumbRev });
      } else {
        this.app.queueThumbnail(id);
      }
    }
    if (!url || !card.isConnected) return;
    const img = h('img.card-thumb', { alt: '', draggable: 'false', decoding: 'async' });
    img.src = url;
    const ph = card.querySelector('.card-thumb.placeholder');
    if (ph) ph.replaceWith(img);
  }

  /** Miniatura recién generada en segundo plano. */
  thumbReady(docId) {
    const n = this.nodes.get(docId);
    if (n) n.thumbRev = (n.thumbRev || 0) + 0.5; // fuerza recarga
    const cached = this.thumbUrls.get(docId);
    if (cached) {
      URL.revokeObjectURL(cached.url);
      this.thumbUrls.delete(docId);
    }
    const card = this.grid.querySelector(`.card[data-id="${CSS.escape(docId)}"]`);
    if (card) this.loadThumb(card);
  }

  // ------------------------------------------------------------------
  // Menú contextual de una tarjeta
  // ------------------------------------------------------------------

  openNodeMenu(n, anchor) {
    if (n.deletedAt) {
      openMenu(anchor, [
        { label: 'Restaurar', icon: 'restore', onClick: () => this.restore([n.id]) },
        'sep',
        { label: 'Eliminar para siempre', icon: 'trash', danger: true, onClick: () => this.deleteForever([n.id]) }
      ]);
      return;
    }
    const isFolder = n.kind === 'folder';
    openMenu(anchor, [
      isFolder ? { label: 'Abrir', icon: 'folder', onClick: () => this.openFolder(n.id) } : { label: 'Abrir', icon: 'fileText', onClick: () => this.app.openDocument(n.id) },
      { label: 'Renombrar…', icon: 'edit', onClick: () => this.rename(n) },
      isFolder ? { label: 'Color…', icon: 'palette', onClick: () => this.app.editFolder(n) } : null,
      n.favorite
        ? { label: 'Quitar de favoritos', icon: 'star', onClick: () => this.setFavorite([n.id], false) }
        : { label: 'Añadir a favoritos', icon: 'star', onClick: () => this.setFavorite([n.id], true) },
      { label: 'Mover a…', icon: 'folderInput', onClick: () => this.move([n.id]) },
      { label: 'Duplicar', icon: 'copy', onClick: () => this.duplicate([n.id]) },
      !isFolder ? { label: 'Exportar PDF o imagen…', icon: 'share', onClick: () => this.app.exportFromLibrary(n.id) } : null,
      !isFolder ? { label: 'Historial de versiones…', icon: 'history', onClick: () => this.app.openVersionsById(n.id) } : null,
      'sep',
      { label: 'Mover a la papelera', icon: 'trash', danger: true, onClick: () => this.trash([n.id]) }
    ]);
  }

  // ------------------------------------------------------------------
  // Acciones
  // ------------------------------------------------------------------

  async rename(n) {
    const name = await promptDialog({ title: n.kind === 'folder' ? 'Renombrar carpeta' : 'Renombrar documento', label: 'Nombre', value: n.name });
    if (name === null || !name.trim()) return;
    await repo.renameNode(n.id, name);
    await this.reload();
  }

  async move(ids) {
    const target = await this.app.pickFolder({ title: ids.length > 1 ? `Mover ${ids.length} elementos` : 'Mover a…', excludeIds: ids, current: this.nodes.get(ids[0])?.parentId || null });
    if (target === undefined) return;
    try {
      const moved = await repo.moveNodes(ids, target);
      toast(moved ? `${moved} elemento${moved === 1 ? '' : 's'} movido${moved === 1 ? '' : 's'}` : 'Ya estaba en esa carpeta', { type: 'success' });
    } catch (err) {
      toast(err.message || 'No se pudo mover', { type: 'error' });
    }
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
  }

  async setFavorite(ids, value) {
    await repo.setFavorite(ids, value);
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
    toast(value
      ? (ids.length === 1 ? 'Añadido a favoritos' : `${ids.length} elementos añadidos a favoritos`)
      : (ids.length === 1 ? 'Quitado de favoritos' : `${ids.length} elementos quitados de favoritos`), { type: 'success' });
  }

  async duplicate(ids) {
    const stop = toast('Duplicando…', { duration: 0 });
    try {
      const { roots } = await repo.duplicateNodes(ids);
      toast(`${roots.length} elemento${roots.length === 1 ? '' : 's'} duplicado${roots.length === 1 ? '' : 's'}`, { type: 'success' });
    } catch (err) {
      toast(`No se pudo duplicar: ${err.message}`, { type: 'error' });
    } finally {
      stop();
    }
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
  }

  async trash(ids) {
    await repo.trashNodes(ids);
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
    toast(`${ids.length === 1 ? 'Movido' : `${ids.length} elementos movidos`} a la papelera`, {
      type: 'success',
      duration: 5000,
      action: { label: 'Deshacer', fn: async () => {
        await repo.restoreNodes(ids);
        await this.reload();
        this.app.broadcast();
      } }
    });
  }

  async restore(ids) {
    await repo.restoreNodes(ids);
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
    toast('Restaurado', { type: 'success' });
  }

  async deleteForever(ids) {
    const names = ids.map(id => this.nodes.get(id)?.name).filter(Boolean);
    const ok = await confirmDialog(
      `${names.length === 1 ? `«${names[0]}»` : `${names.length} elementos`} se eliminará${names.length === 1 ? '' : 'n'} definitivamente, junto con su historial de versiones. Esta acción NO se puede deshacer.`,
      { title: '¿Eliminar para siempre?', confirmLabel: 'Eliminar definitivamente', danger: true }
    );
    if (!ok) return;
    await repo.deleteForever(ids);
    this.exitSelect();
    await this.reload();
    this.app.broadcast();
    toast('Eliminado definitivamente', { type: 'success' });
  }

  async emptyTrash() {
    const count = [...this.nodes.values()].filter(n => n.deletedAt && !this.hasTrashedAncestor(n)).length;
    if (!count) {
      toast('La papelera ya está vacía');
      return;
    }
    const ok = await confirmDialog(`Se eliminarán definitivamente ${count} elemento${count === 1 ? '' : 's'} de la papelera. Esta acción NO se puede deshacer.`, { title: '¿Vaciar la papelera?', confirmLabel: 'Vaciar papelera', danger: true });
    if (!ok) return;
    await repo.emptyTrash();
    await this.reload();
    this.app.broadcast();
    toast('Papelera vaciada', { type: 'success' });
  }

  // ------------------------------------------------------------------
  // Selección múltiple
  // ------------------------------------------------------------------

  enterSelect() {
    this.selecting = true;
    this.selected.clear();
    $('#btn-lib-select').classList.add('active');
    document.body.classList.add('lib-selecting');
    $('#lib-selection-bar').hidden = false;
    const inTrash = this.tab === 'trash';
    $('#lib-selection-bar [data-sel="restore"]').hidden = !inTrash;
    $('#lib-selection-bar [data-sel="move"]').hidden = inTrash;
    $('#lib-selection-bar [data-sel="duplicate"]').hidden = inTrash;
    $('#lib-selection-bar [data-sel="fav"]').hidden = inTrash;
    this.updateSelectionBar();
  }

  exitSelect() {
    this.selecting = false;
    this.selected.clear();
    $('#btn-lib-select').classList.remove('active');
    document.body.classList.remove('lib-selecting');
    $('#lib-selection-bar').hidden = true;
    $$('.card.selected', this.grid).forEach(c => c.classList.remove('selected'));
  }

  toggleSelect(id, card) {
    if (this.selected.has(id)) this.selected.delete(id);
    else this.selected.add(id);
    if (card) card.classList.toggle('selected', this.selected.has(id));
    this.updateSelectionBar();
  }

  updateSelectionBar() {
    const n = this.selected.size;
    $('#lib-sel-count').textContent = `${n} seleccionado${n === 1 ? '' : 's'}`;
    $$('#lib-selection-bar [data-sel]').forEach(b => {
      if (['move', 'duplicate', 'delete', 'restore', 'fav'].includes(b.dataset.sel)) b.disabled = n === 0;
    });
  }

  onSelectionAction(action) {
    const ids = [...this.selected];
    if (action === 'cancel') return this.exitSelect();
    if (action === 'all') {
      const cards = $$('.card', this.grid);
      const all = cards.every(c => this.selected.has(c.dataset.id));
      cards.forEach(c => {
        if (all) this.selected.delete(c.dataset.id);
        else this.selected.add(c.dataset.id);
        c.classList.toggle('selected', !all);
      });
      this.updateSelectionBar();
      return;
    }
    if (!ids.length) return;
    if (action === 'move') this.move(ids);
    else if (action === 'duplicate') this.duplicate(ids);
    else if (action === 'fav') {
      // Si todos ya son favoritos, se quitan; si no, se añaden.
      const allFav = ids.every(id => this.nodes.get(id)?.favorite);
      this.setFavorite(ids, !allFav);
    }
    else if (action === 'restore') this.restore(ids);
    else if (action === 'delete') {
      if (this.tab === 'trash') this.deleteForever(ids);
      else this.trash(ids);
    }
  }

  // ------------------------------------------------------------------
  // Avisos (banners)
  // ------------------------------------------------------------------

  setBanners(banners) {
    const slot = $('#lib-banner-slot');
    clear(slot);
    for (const b of banners) {
      const el = h(`div.banner${b.kind ? '.' + b.kind : ''}`, iconEl(b.icon || 'alert'), h('div.banner-text', b.title ? h('strong', b.title) : null, b.text));
      for (const a of b.actions || []) {
        const btn = h(`button.btn.btn-sm${a.primary ? '.btn-primary' : ''}`, { type: 'button' }, a.label);
        btn.addEventListener('click', a.fn);
        el.appendChild(btn);
      }
      if (b.dismiss) {
        const x = h('button.btn.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Cerrar' }, iconEl('x'));
        x.addEventListener('click', () => {
          el.remove();
          b.dismiss();
        });
        el.appendChild(x);
      }
      slot.appendChild(el);
    }
  }
}
