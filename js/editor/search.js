// Buscar dentro del texto de los PDF del documento abierto: barra de búsqueda, recuento,
// resaltado de todas las coincidencias y saltos entre ellas (▲ ▼ / Intro / Mayús+Intro).

import { getPdfText, findInPage, normalizeQuery, getPagePositions, matchRects } from '../core/textindex.js';
import { h, iconEl, $ } from '../ui/dom.js';
import { debounce } from '../core/util.js';

export class DocSearch {
  constructor(editor) {
    this.editor = editor;
    this.results = [];
    this.index = -1;
    this.token = 0;
    this.nq = '';
    this.viewer = null;
    this.prefer = null;
    this.build();
    this._runSoon = debounce(() => this.run(), 250);
  }

  build() {
    this.input = h('input.search-input', { type: 'search', placeholder: 'Buscar en el PDF', autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Buscar en el PDF' });
    this.status = h('span.search-status');
    this.prevBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Anterior (Mayús+Intro)', 'aria-label': 'Anterior' }, iconEl('chevronUp'));
    this.nextBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Siguiente (Intro)', 'aria-label': 'Siguiente' }, iconEl('chevronDown'));
    const closeBtn = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Cerrar búsqueda (Esc)', 'aria-label': 'Cerrar búsqueda' }, iconEl('x'));
    this.el = h('div.search-bar', { hidden: true },
      h('label.search-field', iconEl('search'), this.input),
      this.status, this.prevBtn, this.nextBtn, closeBtn);
    this.input.addEventListener('input', () => this._runSoon());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this._runSoon.flush();
        if (e.shiftKey) this.prev();
        else this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.prevBtn.addEventListener('click', () => this.prev());
    this.nextBtn.addEventListener('click', () => this.next());
    closeBtn.addEventListener('click', () => this.close());
    $('#ed-search-slot').appendChild(this.el);
  }

  isOpen() {
    return !this.el.hidden;
  }

  toggle() {
    if (this.isOpen()) this.close();
    else this.open();
  }

  /**
   * Abre la barra. `prefer` = { blobId, pdfIndex } hace que la primera coincidencia mostrada
   * sea la de esa página del PDF (al venir de un resultado de la biblioteca).
   */
  open(prefill = null, { prefer = null } = {}) {
    this.el.hidden = false;
    if (prefill !== null && prefill !== undefined) this.input.value = prefill;
    this.prefer = prefer;
    setTimeout(() => {
      this.input.focus();
      this.input.select();
    }, 30);
    if (this.input.value.trim()) this.run();
    else this.setStatus('');
  }

  close() {
    this.el.hidden = true;
    this.token++;
    this.results = [];
    this.index = -1;
    this.nq = '';
    this.prefer = null;
    for (const p of this.editor.panes) p.viewer.setSearch(null);
    this.viewer = null;
  }

  setStatus(text, kind = '') {
    this.status.textContent = text;
    this.status.className = `search-status ${kind}`;
    const has = this.results.length > 0;
    this.prevBtn.disabled = !has;
    this.nextBtn.disabled = !has;
  }

  /** El panel activo cambió (pantalla dual): buscar en el nuevo documento. */
  onPaneChange() {
    if (!this.isOpen()) return;
    if (this.viewer && this.viewer !== this.editor.viewer) this.viewer.setSearch(null);
    this.run();
  }

  async run() {
    const token = ++this.token;
    const pane = this.editor.activePane;
    if (!pane) return;
    const viewer = pane.viewer;
    const session = pane.session;
    if (this.viewer && this.viewer !== viewer) this.viewer.setSearch(null);
    this.viewer = viewer;
    const nq = normalizeQuery(this.input.value);
    this.nq = nq;
    this.results = [];
    this.index = -1;
    if (nq.length < 2) {
      viewer.setSearch(null);
      this.setStatus(nq.length ? 'Escribe al menos 2 letras' : '');
      return;
    }
    this.setStatus('Buscando…', 'busy');
    let pages;
    try {
      pages = await session.loadAllPages();
    } catch (err) {
      this.setStatus('No se pudo buscar', 'error');
      return;
    }
    if (token !== this.token) return;
    const results = [];
    let pdfPages = 0;
    let withText = 0;
    let unreadable = 0;
    const bad = new Set(); // PDFs que no se han podido leer (no se reintenta en cada página)
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      if (!p || !p.pdf || !p.pdf.blobId) continue;
      pdfPages++;
      if (bad.has(p.pdf.blobId)) {
        unreadable++;
        continue;
      }
      let entry;
      try {
        entry = await getPdfText(p.pdf.blobId, {
          onProgress: (a, b) => {
            if (token === this.token) this.setStatus(`Preparando el PDF para buscar… ${a}/${b}`, 'busy');
          }
        });
      } catch (err) {
        console.warn('No se pudo leer el texto del PDF', err);
        bad.add(p.pdf.blobId);
        unreadable++;
        continue;
      }
      if (token !== this.token) return;
      if (entry.hasText) withText++;
      const occ = findInPage(entry, p.pdf.index, nq);
      occ.forEach((m, k) => results.push({ pageId: p.id, pageIndex: i, occ: k, start: m.s, blobId: p.pdf.blobId, pdfIndex: p.pdf.index, rotation: p.pdf.rotation || 0 }));
    }
    if (token !== this.token) return;
    this.results = results;
    viewer.setSearch({ nq, current: null });
    if (!pdfPages) {
      this.setStatus('Este documento no tiene páginas de PDF con texto', 'muted');
      return;
    }
    if (unreadable === pdfPages) {
      this.setStatus('No se pudo leer el texto de este PDF', 'error');
      return;
    }
    if (!withText) {
      this.setStatus('Este PDF no contiene texto (parece escaneado)', 'muted');
      return;
    }
    if (!results.length) {
      this.setStatus('Sin resultados', 'muted');
      return;
    }
    // Empezar por la coincidencia pedida o por la primera desde la página que se está viendo.
    let first = -1;
    const prefer = this.prefer;
    this.prefer = null;
    if (prefer) first = results.findIndex(r => r.blobId === prefer.blobId && r.pdfIndex === prefer.pdfIndex);
    if (first === -1) {
      const cur = viewer.currentPage;
      first = results.findIndex(r => r.pageIndex >= cur);
    }
    if (first === -1) first = 0;
    await this.goTo(first);
  }

  async goTo(i) {
    if (!this.results.length) return;
    const n = this.results.length;
    this.index = ((i % n) + n) % n;
    const r = this.results[this.index];
    const viewer = this.viewer;
    if (!viewer || viewer.destroyed) return;
    this.setStatus(`${this.index + 1} de ${n}`);
    viewer.setSearch({ nq: this.nq, current: { pageId: r.pageId, occ: r.occ } });
    const token = this.token;
    try {
      const pos = await getPagePositions(r.blobId, r.pdfIndex, r.rotation);
      if (token !== this.token) return;
      const rects = matchRects(pos, this.nq)[r.occ];
      const page = viewer.session.getPageSync(r.pageId);
      if (!rects || !rects.length || !page || !page.pdf) {
        viewer.scrollToPage(r.pageIndex);
        return;
      }
      const k = page.pdf.w / pos.baseW;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const q of rects) {
        minX = Math.min(minX, q.x);
        minY = Math.min(minY, q.y);
        maxX = Math.max(maxX, q.x + q.w);
        maxY = Math.max(maxY, q.y + q.h);
      }
      const px = page.pdf.x || 0;
      const py = page.pdf.y || 0;
      viewer.scrollToRect(r.pageIndex, { x: px + minX * k, y: py + minY * k, w: (maxX - minX) * k, h: (maxY - minY) * k });
    } catch (err) {
      console.warn(err);
      viewer.scrollToPage(r.pageIndex);
    }
  }

  next() {
    if (this.results.length) this.goTo(this.index + 1);
  }

  prev() {
    if (this.results.length) this.goTo(this.index - 1);
  }
}
