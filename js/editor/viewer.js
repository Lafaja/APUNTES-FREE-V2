// Visor de documento: maquetación continua de páginas, virtualización, zoom y renderizado.
//
// - Solo las páginas cercanas a la pantalla tienen canvas (memoria acotada aunque haya 500 páginas).
// - Desplazar no redibuja nada: las páginas son capas ya pintadas que el navegador mueve.
// - Tras hacer zoom se vuelven a pintar a la nueva resolución (nítidas), por región si es muy grande.

import { Emitter } from '../core/events.js';
import { clamp } from '../core/util.js';
import { paperSvgDataUri } from '../model/paper.js';
import { strokeBBox, imageBBox, rectsIntersect } from '../model/stroke.js';
import { drawStrokes, drawStroke } from '../render/ink.js';
import { getImage, imageEvents } from '../render/images.js';
import { pdfQueue, renderPdfPage } from '../render/pdf.js';
import { getPagePositions, matchRects } from '../core/textindex.js';
import { getPageLinks } from '../render/pdfnav.js';
import { h, iconEl } from '../ui/dom.js';

const GAP = 22;
const PAD_TOP = 24;
const PAD_BOTTOM = 120;
const PAD_X = 24;
export const MIN_ZOOM = 0.25;
export const MAX_ZOOM = 6;
const PIXEL_BUDGET = 6e6; // píxeles de dispositivo máximos por canvas de página (menos = repintados más rápidos)

function dprNow() {
  return Math.min(globalThis.devicePixelRatio || 1, 2.5);
}

function releaseCanvas(c) {
  if (!c) return;
  c.width = 0;
  c.height = 0;
  c.remove();
}

// ===========================================================================
// PageView: una página montada en pantalla
// ===========================================================================

class PageView {
  constructor(viewer, index, ref) {
    this.viewer = viewer;
    this.index = index;
    this.id = ref.id;
    this.page = null;
    this.el = h('div.page.page-loading', { dataset: { pageId: ref.id } });
    this.ink = null; // { canvas, ctx, rect, S }
    this.pdf = null; // { canvas, rect, S } (capa PDF actual)
    this.pdfPending = null; // clave de la petición en curso
    this.pdfPendingLayer = null; // geometría de la petición en curso
    this.pdfPlaceholder = null;
    this.dirtyRect = null; // región de tinta pendiente de repintar (coordenadas de página)
    this.fullDirty = true;
    this.destroyed = false;
    this.geom = { left: 0, top: 0, w: 0, h: 0 };
    viewer.stage.appendChild(this.el);
    this.load();
  }

  async load() {
    try {
      const page = await this.viewer.session.getPage(this.id);
      if (this.destroyed) return;
      this.page = page;
      this.el.classList.remove('page-loading');
      this.applyBackground();
      this.fullDirty = true;
      this.viewer.schedulePaint(this);
      this.applyBookmark();
      if (this.viewer.search) this.applySearch();
    } catch (err) {
      console.error('No se pudo cargar la página', err);
      if (this.destroyed) return;
      this.el.classList.remove('page-loading');
      this.el.appendChild(h('div.page-error', 'No se pudo cargar esta página. Tus datos siguen guardados; prueba a recargar.'));
    }
  }

  applyBackground() {
    const p = this.page;
    if (!p) return;
    this.el.style.backgroundColor = p.bg.color;
    this.el.style.backgroundImage = p.bg.template === 'blank' ? 'none' : paperSvgDataUri(p.bg, p.w, p.h);
    if (p.pdf) {
      if (!this.pdfPlaceholder) {
        this.pdfPlaceholder = h('div.pdf-layer', { style: { position: 'absolute' } });
        this.el.insertBefore(this.pdfPlaceholder, this.el.firstChild);
      }
    } else if (this.pdfPlaceholder) {
      this.pdfPlaceholder.remove();
      this.pdfPlaceholder = null;
    }
    this.positionLayers();
  }

  setGeometry(left, top, w, h) {
    const g = this.geom;
    if (g.left === left && g.top === top && g.w === w && g.h === h) return;
    this.geom = { left, top, w, h };
    const s = this.el.style;
    s.left = `${left}px`;
    s.top = `${top}px`;
    s.width = `${w}px`;
    s.height = `${h}px`;
    this.positionLayers();
  }

  /** Coloca los canvas existentes según el zoom actual (estirados hasta que se repinten). */
  positionLayers() {
    const z = this.viewer.zoom;
    const place = (el, rect) => {
      if (!el || !rect) return;
      el.style.left = `${rect.x * z}px`;
      el.style.top = `${rect.y * z}px`;
      el.style.width = `${rect.w * z}px`;
      el.style.height = `${rect.h * z}px`;
    };
    if (this.ink) place(this.ink.canvas, this.ink.rect);
    if (this.pdf) place(this.pdf.canvas, this.pdf.rect);
    if (this.pdfPlaceholder && this.page && this.page.pdf) {
      const r = this.page.pdf;
      place(this.pdfPlaceholder, { x: r.x, y: r.y, w: r.w, h: r.h });
    }
    if (this.searchData) this.renderSearchLayer();
  }

  /** Cinta roja en la esquina de las páginas marcadas. */
  applyBookmark() {
    const on = this.viewer.session.isBookmarked(this.id);
    if (on && !this.bookmarkEl) {
      this.bookmarkEl = h('div.page-bookmark', { title: 'Página marcada', 'aria-label': 'Página marcada' });
      this.el.appendChild(this.bookmarkEl);
    } else if (!on && this.bookmarkEl) {
      this.bookmarkEl.remove();
      this.bookmarkEl = null;
    }
  }

  // ---------------- Resaltado de búsqueda ----------------

  async applySearch() {
    const s = this.viewer.search;
    const p = this.page;
    if (!s || !p || !p.pdf || !p.pdf.blobId) {
      this.clearSearchLayer();
      return;
    }
    const token = (this._searchToken = (this._searchToken || 0) + 1);
    try {
      const pos = await getPagePositions(p.pdf.blobId, p.pdf.index, p.pdf.rotation || 0);
      if (this.destroyed || token !== this._searchToken || !this.viewer.search) return;
      this.searchData = {
        matches: matchRects(pos, s.nq),
        k: p.pdf.w / pos.baseW,
        ox: p.pdf.x || 0,
        oy: p.pdf.y || 0,
        current: s.current && s.current.pageId === this.id ? s.current.occ : -1
      };
      this.renderSearchLayer();
    } catch (err) {
      console.warn('No se pudo resaltar la búsqueda', err);
    }
  }

  renderSearchLayer() {
    const d = this.searchData;
    if (!d || !d.matches.length) {
      if (this.searchLayer) {
        this.searchLayer.remove();
        this.searchLayer = null;
      }
      return;
    }
    if (!this.searchLayer) {
      this.searchLayer = h('div.search-layer');
      this.el.appendChild(this.searchLayer);
    }
    const z = this.viewer.zoom;
    const frag = document.createDocumentFragment();
    d.matches.forEach((rects, mi) => {
      for (const r of rects) {
        const div = document.createElement('div');
        div.className = mi === d.current ? 'search-hl current' : 'search-hl';
        div.style.left = `${(d.ox + r.x * d.k) * z}px`;
        div.style.top = `${(d.oy + r.y * d.k) * z}px`;
        div.style.width = `${r.w * d.k * z}px`;
        div.style.height = `${r.h * d.k * z}px`;
        frag.appendChild(div);
      }
    });
    this.searchLayer.replaceChildren(frag);
  }

  clearSearchLayer() {
    this._searchToken = (this._searchToken || 0) + 1;
    this.searchData = null;
    if (this.searchLayer) {
      this.searchLayer.remove();
      this.searchLayer = null;
    }
  }

  priority() {
    const v = this.viewer;
    const top = v.scroll.scrollTop;
    const center = top + v.scroll.clientHeight / 2;
    const mid = this.geom.top + this.geom.h / 2;
    const visible = this.geom.top < top + v.scroll.clientHeight && this.geom.top + this.geom.h > top;
    return (visible ? 0 : 1e6) + Math.abs(mid - center);
  }

  /** Rectángulo objetivo de renderizado (página completa o región visible). */
  /**
   * Rectángulo objetivo de renderizado: página completa si cabe en el presupuesto de píxeles;
   * si no, la región visible ampliada un 25 % por cada lado. La resolución en modo región
   * depende solo del zoom y del tamaño de pantalla, así no cambia al desplazarse.
   */
  target(areaRect = null) {
    const p = this.page;
    const v = this.viewer;
    const z = v.zoom;
    const S0 = z * v.dpr;
    const base = areaRect || { x: 0, y: 0, w: p.w, h: p.h };
    if (base.w * base.h * S0 * S0 <= PIXEL_BUDGET) return { rect: { ...base }, S: S0, full: true };
    const vw = v.scroll.clientWidth || 800;
    const vh = v.scroll.clientHeight || 600;
    const nomW = (vw / z) * 1.5;
    const nomH = (vh / z) * 1.5;
    const S = Math.min(S0, Math.sqrt(PIXEL_BUDGET / (nomW * nomH)));
    const vis = v.visiblePageRect(this.index);
    if (!vis) return null;
    const mx = (vw / z) * 0.25;
    const my = (vh / z) * 0.25;
    const x0 = Math.max(base.x, vis.x - mx);
    const y0 = Math.max(base.y, vis.y - my);
    const x1 = Math.min(base.x + base.w, vis.x + vis.w + mx);
    const y1 = Math.min(base.y + base.h, vis.y + vis.h + my);
    if (x1 <= x0 || y1 <= y0) return null;
    const rect = { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1 - Math.floor(x0)), h: Math.ceil(y1 - Math.floor(y0)) };
    return { rect, S, full: false };
  }

  /** ¿Una capa ({ rect, S, full }) sigue cubriendo lo visible de `areaRect` con la resolución adecuada? */
  layerCovers(layer, areaRect = null) {
    if (!layer) return false;
    const t = this.target(areaRect);
    if (!t) return true;
    if (Math.abs(layer.S - t.S) / t.S > 0.02) return false;
    if (t.full) return !!layer.full;
    let vis = this.viewer.visiblePageRect(this.index);
    if (!vis) return true;
    if (areaRect) {
      const x0 = Math.max(vis.x, areaRect.x);
      const y0 = Math.max(vis.y, areaRect.y);
      const x1 = Math.min(vis.x + vis.w, areaRect.x + areaRect.w);
      const y1 = Math.min(vis.y + vis.h, areaRect.y + areaRect.h);
      if (x1 <= x0 || y1 <= y0) return true;
      vis = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    }
    const r = layer.rect;
    return vis.x >= r.x - 1 && vis.y >= r.y - 1 && vis.x + vis.w <= r.x + r.w + 1 && vis.y + vis.h <= r.y + r.h + 1;
  }

  inkCoversVisible() {
    if (!this.ink) return true;
    return this.layerCovers(this.ink);
  }

  pdfRect() {
    const p = this.page;
    return p && p.pdf ? { x: p.pdf.x || 0, y: p.pdf.y || 0, w: p.pdf.w, h: p.pdf.h } : null;
  }

  hasInkContent() {
    const p = this.page;
    return p && (p.strokes.length > 0 || p.images.length > 0);
  }

  invalidate(rect = null) {
    if (!rect) this.fullDirty = true;
    else if (!this.fullDirty) {
      this.dirtyRect = this.dirtyRect
        ? { minX: Math.min(this.dirtyRect.minX, rect.minX), minY: Math.min(this.dirtyRect.minY, rect.minY), maxX: Math.max(this.dirtyRect.maxX, rect.maxX), maxY: Math.max(this.dirtyRect.maxY, rect.maxY) }
        : { ...rect };
    }
    this.viewer.schedulePaint(this);
  }

  /** Repinta lo necesario (llamado por el planificador en un requestAnimationFrame). */
  paintNow() {
    if (this.destroyed || !this.page) return;
    this.paintInk();
    this.paintPdf();
  }

  paintInk() {
    const p = this.page;
    const hidden = this.viewer.hiddenIdsFor(this.id);
    if (!this.hasInkContent() && !this.ink) {
      this.fullDirty = false;
      this.dirtyRect = null;
      return;
    }
    if (!this.ink || !this.inkCoversVisible()) {
      const t = this.target();
      if (!t) return;
      let canvas = this.ink ? this.ink.canvas : null;
      if (!canvas) {
        canvas = h('canvas.ink-layer');
        this.el.appendChild(canvas);
      }
      const cw = Math.max(1, Math.round(t.rect.w * t.S));
      const ch = Math.max(1, Math.round(t.rect.h * t.S));
      if (canvas.width !== cw || canvas.height !== ch) {
        canvas.width = cw;
        canvas.height = ch;
      }
      const ctx = canvas.getContext('2d');
      this.ink = { canvas, ctx, rect: t.rect, S: t.S, full: t.full };
      this.positionLayers();
      this.fullDirty = true;
    }
    const { ctx, rect, S } = this.ink;
    let clip = null;
    if (!this.fullDirty && this.dirtyRect) {
      clip = {
        minX: Math.max(rect.x, this.dirtyRect.minX - 2),
        minY: Math.max(rect.y, this.dirtyRect.minY - 2),
        maxX: Math.min(rect.x + rect.w, this.dirtyRect.maxX + 2),
        maxY: Math.min(rect.y + rect.h, this.dirtyRect.maxY + 2)
      };
      if (clip.maxX <= clip.minX || clip.maxY <= clip.minY) {
        this.dirtyRect = null;
        return;
      }
    } else if (!this.fullDirty) {
      return;
    }
    ctx.setTransform(S, 0, 0, S, -rect.x * S, -rect.y * S);
    ctx.save();
    if (clip) {
      ctx.beginPath();
      ctx.rect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
      ctx.clip();
      ctx.clearRect(clip.minX, clip.minY, clip.maxX - clip.minX, clip.maxY - clip.minY);
    } else {
      ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
    }
    const area = clip || { minX: rect.x, minY: rect.y, maxX: rect.x + rect.w, maxY: rect.y + rect.h };
    // Recorte al borde de la página: lo que sale de la hoja no se ve (como en papel).
    ctx.beginPath();
    ctx.rect(0, 0, p.w, p.h);
    ctx.clip();
    this.drawImages(ctx, area, hidden);
    drawStrokes(ctx, p.strokes, area, hidden);
    ctx.restore();
    this.fullDirty = false;
    this.dirtyRect = null;
  }

  drawImages(ctx, area, hidden) {
    for (const img of this.page.images) {
      if (hidden && hidden.has(img.id)) continue;
      if (!rectsIntersect(imageBBox(img), area)) continue;
      const bmp = getImage(img.blobId);
      if (!bmp) continue; // se repintará al terminar de cargar
      ctx.save();
      ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
      if (img.rot) ctx.rotate((img.rot * Math.PI) / 180);
      if (img.crop) ctx.drawImage(bmp, img.crop.x, img.crop.y, img.crop.w, img.crop.h, -img.w / 2, -img.h / 2, img.w, img.h);
      else ctx.drawImage(bmp, -img.w / 2, -img.h / 2, img.w, img.h);
      ctx.restore();
    }
  }

  /** Dibuja trazos nuevos encima de la capa existente (vía rápida al terminar un trazo). */
  drawOnTop(strokes) {
    if (!this.page) return;
    if (!this.ink) {
      this.invalidate();
      return;
    }
    if (!this.inkCoversVisible()) {
      this.invalidate();
      return;
    }
    const { ctx, rect, S } = this.ink;
    ctx.setTransform(S, 0, 0, S, -rect.x * S, -rect.y * S);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, this.page.w, this.page.h);
    ctx.clip();
    for (const s of strokes) drawStroke(ctx, s);
    ctx.restore();
  }

  paintPdf() {
    const p = this.page;
    if (!p.pdf) return;
    const pr = this.pdfRect();
    const src = `${p.pdf.blobId}|${p.pdf.index}|${p.pdf.rotation || 0}`;
    if (this.pdf && this.pdf.src === src && this.layerCovers(this.pdf, pr)) return;
    if (this.pdfPendingLayer && this.pdfPendingLayer.src === src && this.layerCovers(this.pdfPendingLayer, pr)) return;
    const t = this.target(pr);
    if (!t) return;
    const key = `${t.rect.x}|${t.rect.y}|${t.rect.w}|${t.rect.h}|${t.S.toFixed(3)}|${src}`;
    this.pdfPending = key;
    this.pdfPendingLayer = { rect: t.rect, S: t.S, full: t.full, src };
    const job = {
      priority: () => this.priority(),
      run: async signal => {
        const targetWidth = pr.w * t.S;
        const region = { x: (t.rect.x - pr.x) * t.S, y: (t.rect.y - pr.y) * t.S, w: t.rect.w * t.S, h: t.rect.h * t.S };
        const canvas = await renderPdfPage({
          blobId: p.pdf.blobId,
          index: p.pdf.index,
          rotation: p.pdf.rotation || 0,
          targetWidth,
          region: t.full ? null : region,
          signal
        });
        if (this.destroyed || this.pdfPending !== key) {
          releaseCanvas(canvas);
          return;
        }
        canvas.className = 'pdf-layer';
        const old = this.pdf ? this.pdf.canvas : null;
        this.pdf = { canvas, rect: t.rect, S: t.S, full: t.full, key, src };
        this.pdfPending = null;
        this.pdfPendingLayer = null;
        // La capa PDF va debajo de la tinta.
        this.el.insertBefore(canvas, this.pdfPlaceholder ? this.pdfPlaceholder.nextSibling : this.el.firstChild);
        this.positionLayers();
        if (old) releaseCanvas(old);
      },
      onError: err => {
        if (this.pdfPending === key) {
          this.pdfPending = null;
          this.pdfPendingLayer = null;
        }
        if (!this.el.querySelector('.page-error')) {
          this.el.appendChild(h('div.page-error', `No se pudo mostrar esta página del PDF: ${err.message || err}`));
        }
      }
    };
    pdfQueue.request(this, job);
  }

  destroy() {
    this.destroyed = true;
    pdfQueue.cancel(this);
    if (this.ink) releaseCanvas(this.ink.canvas);
    if (this.pdf) releaseCanvas(this.pdf.canvas);
    this.ink = null;
    this.pdf = null;
    this.el.remove();
  }
}

// ===========================================================================
// DocumentViewer
// ===========================================================================

export class DocumentViewer extends Emitter {
  constructor(host, session, { editor } = {}) {
    super();
    this.session = session;
    this.editor = editor;
    this.zoom = 1;
    this.dpr = dprNow();
    this.views = new Map(); // pageId -> PageView
    this.layout = { lefts: [], tops: [], ws: [], hs: [], stageW: 0, stageH: 0 };
    this.hidden = new Map(); // pageId -> Set(ids) ocultos (selección en arrastre)
    this.dirty = new Set();
    this.paintRaf = 0;
    this.destroyed = false;
    this.currentPage = 0;
    this._pinch = null;
    this.fitMode = true; // zoom "ajustar al ancho": se recalcula al girar la tablet o cambiar el tamaño
    this.search = null; // { nq, current: { pageId, occ } } mientras hay una búsqueda activa

    this.el = h('div.viewer');
    this.scroll = h('div.viewer-scroll', { tabindex: '0' });
    this.stage = h('div.viewer-stage');
    this.spacer = h('div', { style: { position: 'absolute', left: '0', top: '0', width: '1px', height: '1px', visibility: 'hidden', pointerEvents: 'none' } });
    this.addBtn = h('button.add-page-btn', { type: 'button' }, iconEl('plus'), 'Añadir página');
    this.addBtn.addEventListener('click', () => this.emit('add-page-click'));
    this.addBtn.addEventListener('pointerdown', e => e.stopPropagation());
    this.stage.appendChild(this.addBtn);
    this.scroll.append(this.spacer, this.stage);
    this.overlay = h('canvas.viewer-overlay');
    // Sin "desynchronized": en algunas tablets Android ese modo de baja latencia pinta la capa
    // transparente en NEGRO y tapa todo el documento al primer toque.
    this.octx = this.overlay.getContext('2d');
    this.indicator = h('div.floating-indicator');
    this.el.append(this.scroll, this.overlay, this.indicator);
    host.appendChild(this.el);

    this._onScroll = () => this.onScroll();
    this.scroll.addEventListener('scroll', this._onScroll, { passive: true });
    this._onWheel = e => this.onWheel(e);
    this.scroll.addEventListener('wheel', this._onWheel, { passive: false });

    this._resizeObs = new ResizeObserver(() => this.onResize());
    this._resizeObs.observe(this.el);

    this._unsubs = [
      session.on('page-change', ev => this.onPageChange(ev)),
      session.on('layout', () => this.relayout(true)),
      session.on('page-bg', ev => {
        const v = this.views.get(ev.pageId);
        if (v) v.applyBackground();
      }),
      session.on('bookmarks', ev => {
        const v = this.views.get(ev.pageId);
        if (v && v.page) v.applyBookmark();
      }),
      imageEvents.on('loaded', ({ blobId }) => {
        for (const v of this.views.values()) {
          if (v.page && v.page.images.some(i => i.blobId === blobId)) v.invalidate();
        }
      })
    ];

    this.dprQuery = null;
    this.watchDpr();
  }

  watchDpr() {
    if (!globalThis.matchMedia) return;
    const mq = matchMedia(`(resolution: ${globalThis.devicePixelRatio || 1}dppx)`);
    const handler = () => {
      this.dpr = dprNow();
      this.resizeOverlay();
      for (const v of this.views.values()) v.invalidate();
      this.watchDpr();
    };
    mq.addEventListener ? mq.addEventListener('change', handler, { once: true }) : mq.addListener(handler);
  }

  // ---------------- Maquetación ----------------

  fitWidthZoom() {
    const vw = Math.max(200, this.scroll.clientWidth);
    let maxW = 0;
    for (const r of this.session.node.pages) maxW = Math.max(maxW, r.w);
    if (!maxW) return 1;
    // −2 px de margen: con escalados de pantalla (125 %, 150 %…) el ancho real tiene decimales.
    return clamp((vw - PAD_X * 2 - 2) / maxW, MIN_ZOOM, 1.6);
  }

  computeLayout(z = this.zoom) {
    const refs = this.session.node.pages;
    const vw = this.scroll.clientWidth || 800;
    let maxW = 0;
    for (const r of refs) maxW = Math.max(maxW, r.w * z);
    const stageW = Math.max(vw - 1, maxW + PAD_X * 2);
    const lefts = new Array(refs.length);
    const tops = new Array(refs.length);
    const ws = new Array(refs.length);
    const hs = new Array(refs.length);
    let y = PAD_TOP;
    for (let i = 0; i < refs.length; i++) {
      const w = refs[i].w * z;
      const hh = refs[i].h * z;
      lefts[i] = Math.round((stageW - w) / 2);
      tops[i] = Math.round(y);
      ws[i] = w;
      hs[i] = hh;
      y += hh + GAP;
    }
    const stageH = Math.round(y - GAP + PAD_BOTTOM);
    return { lefts, tops, ws, hs, stageW: Math.round(stageW), stageH };
  }

  relayout(structural = false) {
    if (this.destroyed) return;
    this.layout = this.computeLayout();
    const L = this.layout;
    this.stage.style.width = `${L.stageW}px`;
    this.stage.style.height = `${L.stageH}px`;
    this.spacer.style.width = `${L.stageW}px`;
    this.spacer.style.height = `${L.stageH}px`;
    const n = this.session.node.pages.length;
    if (n) {
      const last = n - 1;
      this.addBtn.style.top = `${L.tops[last] + L.hs[last] + 28}px`;
      this.addBtn.hidden = !!this.session.readOnly;
    }
    if (structural) {
      // Reindexar vistas: las páginas pueden haber cambiado de posición o desaparecido.
      const ids = new Map(this.session.node.pages.map((r, i) => [r.id, i]));
      for (const [id, v] of this.views) {
        if (!ids.has(id)) {
          v.destroy();
          this.views.delete(id);
        } else {
          v.index = ids.get(id);
        }
      }
    }
    for (const v of this.views.values()) {
      const i = v.index;
      v.setGeometry(L.lefts[i], L.tops[i], L.ws[i], L.hs[i]);
    }
    this.updateVisible();
  }

  pageIndexAtY(y) {
    const tops = this.layout.tops;
    const n = tops.length;
    if (!n) return -1;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (tops[mid] <= y) lo = mid;
      else hi = mid - 1;
    }
    // Si está en el hueco entre dos páginas, elegir la más cercana.
    if (lo < n - 1) {
      const endLo = tops[lo] + this.layout.hs[lo];
      if (y > endLo && y - endLo > tops[lo + 1] - y) return lo + 1;
    }
    return lo;
  }

  /** Parte visible de la página i en coordenadas de página (o null). */
  visiblePageRect(i) {
    const L = this.layout;
    const z = this.zoom;
    const st = this.scroll.scrollTop;
    const sl = this.scroll.scrollLeft;
    const vw = this.scroll.clientWidth;
    const vh = this.scroll.clientHeight;
    const x0 = Math.max(L.lefts[i], sl);
    const y0 = Math.max(L.tops[i], st);
    const x1 = Math.min(L.lefts[i] + L.ws[i], sl + vw);
    const y1 = Math.min(L.tops[i] + L.hs[i], st + vh);
    if (x1 <= x0 || y1 <= y0) return null;
    return { x: (x0 - L.lefts[i]) / z, y: (y0 - L.tops[i]) / z, w: (x1 - x0) / z, h: (y1 - y0) / z };
  }

  updateVisible() {
    if (this.destroyed || this._pinch) return;
    const refs = this.session.node.pages;
    const L = this.layout;
    const st = this.scroll.scrollTop;
    const vh = this.scroll.clientHeight || 600;
    const mountTop = st - vh * 0.75;
    const mountBottom = st + vh * 1.75;
    const keepTop = st - vh * 2;
    const keepBottom = st + vh * 3;
    // Desmontar las lejanas.
    for (const [id, v] of this.views) {
      const i = v.index;
      if (L.tops[i] + L.hs[i] < keepTop || L.tops[i] > keepBottom) {
        v.destroy();
        this.views.delete(id);
      }
    }
    // Montar las cercanas.
    if (refs.length) {
      let i = this.pageIndexAtY(Math.max(0, mountTop));
      for (; i < refs.length; i++) {
        if (L.tops[i] > mountBottom) break;
        if (L.tops[i] + L.hs[i] < mountTop) continue;
        const ref = refs[i];
        let v = this.views.get(ref.id);
        if (!v) {
          v = new PageView(this, i, ref);
          v.setGeometry(L.lefts[i], L.tops[i], L.ws[i], L.hs[i]);
          this.views.set(ref.id, v);
        }
      }
    }
    // Las que están en modo región pueden necesitar repintarse al desplazarse.
    for (const v of this.views.values()) {
      if (!v.page) continue;
      if (!v.inkCoversVisible()) v.invalidate();
      else if (v.page.pdf) this.schedulePaint(v);
    }
    // Página actual (la que ocupa el centro de la pantalla).
    const center = st + vh / 2;
    const cur = this.pageIndexAtY(center);
    if (cur !== this.currentPage && cur >= 0) {
      this.currentPage = cur;
      this.emit('current-page', { index: cur, total: refs.length });
    }
  }

  schedulePaint(view) {
    this.dirty.add(view);
    if (!this.paintRaf) this.paintRaf = requestAnimationFrame(() => this.runPaints());
  }

  /**
   * Mientras el lápiz escribe, los repintados completos (p. ej. tras un zoom) esperan: el lápiz
   * tiene prioridad y la página se ve con la resolución anterior hasta levantarlo.
   */
  setDrawing(on) {
    this.drawing = !!on;
    if (!on && this.dirty.size && !this.paintRaf) this.paintRaf = requestAnimationFrame(() => this.runPaints());
  }

  runPaints() {
    this.paintRaf = 0;
    if (this.destroyed) return;
    const start = performance.now();
    const list = [...this.dirty].sort((a, b) => a.priority() - b.priority());
    let deferred = 0;
    for (let k = 0; k < list.length; k++) {
      const v = list[k];
      if (this.drawing && v.fullDirty) {
        deferred++;
        continue;
      }
      if (k > deferred && performance.now() - start > 10) break;
      this.dirty.delete(v);
      if (!v.destroyed) {
        try {
          v.paintNow();
        } catch (err) {
          console.error('Error pintando página', err);
        }
      }
    }
    if (this.dirty.size > deferred || (!this.drawing && this.dirty.size)) this.paintRaf = requestAnimationFrame(() => this.runPaints());
  }

  // ---------------- Eventos ----------------

  onScroll() {
    if (this._scrollRaf) return;
    this._scrollRaf = requestAnimationFrame(() => {
      this._scrollRaf = 0;
      this.updateVisible();
      this.emit('scroll');
    });
    this.flashIndicator();
  }

  flashIndicator() {
    const total = this.session.node.pages.length;
    if (total <= 1) return;
    this.indicator.textContent = `${this.currentPage + 1} / ${total}`;
    this.indicator.classList.add('show');
    clearTimeout(this._indTimer);
    this._indTimer = setTimeout(() => this.indicator.classList.remove('show'), 900);
  }

  onResize() {
    if (this.destroyed) return;
    this.resizeOverlay();
    const wasEmpty = !this.layout.tops.length;
    if (this._firstLayoutDone) {
      // Mantener el punto central estable al cambiar el tamaño (p. ej. girar la tablet).
      const anchor = this.captureAnchor();
      if (this.fitMode) {
        const z = this.fitWidthZoom();
        if (Math.abs(z - this.zoom) > 1e-3) {
          this.zoom = z;
          this.invalidateAllSoon();
          this.emit('zoom', { zoom: z });
        }
      }
      this.relayout();
      this.restoreAnchor(anchor);
    } else if (!wasEmpty || this.scroll.clientWidth > 0) {
      this.relayout();
    }
    this.emit('resize');
  }

  resizeOverlay() {
    const w = this.el.clientWidth;
    const hh = this.el.clientHeight;
    const dpr = this.dpr;
    const cw = Math.max(1, Math.round(w * dpr));
    const ch = Math.max(1, Math.round(hh * dpr));
    if (this.overlay.width !== cw || this.overlay.height !== ch) {
      this.overlay.width = cw;
      this.overlay.height = ch;
      this.overlay.style.width = `${w}px`;
      this.overlay.style.height = `${hh}px`;
    }
  }

  onPageChange({ pageId, rect, fastAdd }) {
    const v = this.views.get(pageId);
    if (!v || !v.page) return;
    if (fastAdd && v.ink && !v.fullDirty && !v.dirtyRect) {
      v.drawOnTop(fastAdd);
    } else if (!v.ink && !v.hasInkContent()) {
      // La página quedó vacía: liberar la capa.
      v.invalidate();
    } else {
      v.invalidate(rect);
    }
  }

  onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const factor = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0022));
      this.zoomAt(this.zoom * factor, { clientX: e.clientX, clientY: e.clientY });
    }
  }

  // ---------------- Zoom ----------------

  captureAnchor(clientX, clientY) {
    const r = this.scroll.getBoundingClientRect();
    const fx = clientX !== undefined ? clientX - r.left : this.scroll.clientWidth / 2;
    const fy = clientY !== undefined ? clientY - r.top : this.scroll.clientHeight / 2;
    const sx = this.scroll.scrollLeft + fx;
    const sy = this.scroll.scrollTop + fy;
    const i = Math.max(0, this.pageIndexAtY(sy));
    const L = this.layout;
    if (!L.tops.length) return { i: 0, lx: 0, ly: 0, fx, fy };
    return { i, lx: (sx - L.lefts[i]) / this.zoom, ly: (sy - L.tops[i]) / this.zoom, fx, fy };
  }

  restoreAnchor(a) {
    const L = this.layout;
    if (!L.tops.length || a.i >= L.tops.length) return;
    const sx = L.lefts[a.i] + a.lx * this.zoom;
    const sy = L.tops[a.i] + a.ly * this.zoom;
    this.scroll.scrollLeft = sx - a.fx;
    this.scroll.scrollTop = sy - a.fy;
    this.updateVisible();
  }

  /** Zoom inmediato alrededor de un punto de pantalla (zoom manual: sale del modo "ajustar al ancho"). */
  zoomAt(newZoom, { clientX, clientY, fit = false } = {}) {
    this.fitMode = fit;
    const z = clamp(newZoom, MIN_ZOOM, MAX_ZOOM);
    if (Math.abs(z - this.zoom) < 1e-4) return;
    const anchor = this.captureAnchor(clientX, clientY);
    this.zoom = z;
    this.relayout();
    this.restoreAnchor(anchor);
    this.invalidateAllSoon();
    this.emit('zoom', { zoom: z });
  }

  setZoom(z) {
    this.zoomAt(z);
  }

  fitWidth() {
    this.zoomAt(this.fitWidthZoom(), { fit: true });
  }

  invalidateAllSoon() {
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      for (const v of this.views.values()) v.invalidate();
    }, 120);
  }

  /** Inicio de pellizco: coordenadas de pantalla del punto focal y distancia entre dedos. */
  pinchStart(fx, fy, dist) {
    const anchor = this.captureAnchor(fx, fy);
    this._pinch = { z0: this.zoom, d0: Math.max(10, dist), anchor, sl0: this.scroll.scrollLeft, st0: this.scroll.scrollTop, k: 1, fx0: anchor.fx, fy0: anchor.fy };
    this.stage.style.willChange = 'transform';
  }

  pinchMove(fx, fy, dist) {
    const p = this._pinch;
    if (!p) return;
    const z = clamp(p.z0 * (dist / p.d0), MIN_ZOOM, MAX_ZOOM);
    const k = z / p.z0;
    p.k = k;
    const r = this.scroll.getBoundingClientRect();
    const f = { x: fx - r.left, y: fy - r.top };
    p.f = f;
    // Punto de escenario (a zoom z0) que estaba bajo el foco inicial.
    const P0x = p.sl0 + p.fx0;
    const P0y = p.st0 + p.fy0;
    const tx = f.x + p.sl0 - k * P0x;
    const ty = f.y + p.st0 - k * P0y;
    this.stage.style.transform = `translate(${tx}px, ${ty}px) scale(${k})`;
    this.emit('zoom-preview', { zoom: z });
  }

  pinchEnd() {
    const p = this._pinch;
    if (!p) return;
    this._pinch = null;
    if (Math.abs(p.k - 1) > 0.01) this.fitMode = false;
    const z = clamp(p.z0 * p.k, MIN_ZOOM, MAX_ZOOM);
    this.stage.style.transform = '';
    this.stage.style.willChange = '';
    const f = p.f || { x: p.fx0, y: p.fy0 };
    this.zoom = z;
    this.relayout();
    const L = this.layout;
    const a = p.anchor;
    if (L.tops.length && a.i < L.tops.length) {
      this.scroll.scrollLeft = L.lefts[a.i] + a.lx * z - f.x;
      this.scroll.scrollTop = L.tops[a.i] + a.ly * z - f.y;
    }
    this.updateVisible();
    // El repintado a la nueva nitidez espera un momento: si el lápiz toca enseguida, entra sin retraso.
    clearTimeout(this._zoomTimer);
    this._zoomTimer = setTimeout(() => {
      for (const v of this.views.values()) v.invalidate();
    }, 160);
    this.emit('zoom', { zoom: z });
  }

  isPinching() {
    return !!this._pinch;
  }

  // ---------------- Coordenadas ----------------

  /** Convierte un punto de pantalla a { index, x, y } en coordenadas de página. */
  clientToPage(clientX, clientY, forceIndex = -1) {
    const r = this.scroll.getBoundingClientRect();
    const sx = clientX - r.left + this.scroll.scrollLeft;
    const sy = clientY - r.top + this.scroll.scrollTop;
    const i = forceIndex >= 0 ? forceIndex : this.pageIndexAtY(sy);
    if (i < 0) return null;
    const L = this.layout;
    return { index: i, x: (sx - L.lefts[i]) / this.zoom, y: (sy - L.tops[i]) / this.zoom };
  }

  /** Transformación para dibujar en el overlay usando coordenadas de la página i. */
  overlayTransform(i) {
    const L = this.layout;
    const d = this.dpr;
    const z = this.zoom;
    const ox = L.lefts[i] - this.scroll.scrollLeft;
    const oy = L.tops[i] - this.scroll.scrollTop;
    return [d * z, 0, 0, d * z, d * ox, d * oy];
  }

  pageToClient(i, x, y) {
    const r = this.scroll.getBoundingClientRect();
    const L = this.layout;
    return { x: r.left + L.lefts[i] - this.scroll.scrollLeft + x * this.zoom, y: r.top + L.tops[i] - this.scroll.scrollTop + y * this.zoom };
  }

  clearOverlay() {
    this.octx.setTransform(1, 0, 0, 1, 0, 0);
    this.octx.clearRect(0, 0, this.overlay.width, this.overlay.height);
  }

  hiddenIdsFor(pageId) {
    return this.hidden.get(pageId) || null;
  }

  setHidden(pageId, ids) {
    if (ids && ids.size) this.hidden.set(pageId, ids);
    else this.hidden.delete(pageId);
    const v = this.views.get(pageId);
    if (v) v.invalidate();
  }

  viewFor(pageId) {
    return this.views.get(pageId) || null;
  }

  /** Activa (o quita, con null) el resaltado de búsqueda en las páginas montadas. */
  setSearch(state) {
    this.search = state;
    for (const v of this.views.values()) {
      if (state) v.applySearch();
      else v.clearSearchLayer();
    }
  }

  /** Desplaza lo justo para que un rectángulo de la página i quede a la vista (a un tercio de altura). */
  scrollToRect(i, r) {
    const L = this.layout;
    if (!L.tops.length || i < 0 || i >= L.tops.length) return;
    const z = this.zoom;
    const sx = L.lefts[i] + r.x * z;
    const sy = L.tops[i] + r.y * z;
    const sw = r.w * z;
    const sh = r.h * z;
    const vw = this.scroll.clientWidth;
    const vh = this.scroll.clientHeight;
    if (sy < this.scroll.scrollTop + 50 || sy + sh > this.scroll.scrollTop + vh - 50) {
      this.scroll.scrollTop = Math.max(0, sy - vh * 0.35);
    }
    if (sx < this.scroll.scrollLeft + 16 || sx + sw > this.scroll.scrollLeft + vw - 16) {
      this.scroll.scrollLeft = Math.max(0, sx - (vw - sw) / 2);
    }
    this.updateVisible();
  }

  // ---------------- Navegación ----------------

  scrollToPage(i, { offsetRatio = 0, smooth = false } = {}) {
    const L = this.layout;
    if (!L.tops.length) return;
    i = clamp(i, 0, L.tops.length - 1);
    const top = L.tops[i] + offsetRatio * L.hs[i] - (offsetRatio ? 0 : 12);
    const left = Math.max(0, (L.stageW - this.scroll.clientWidth) / 2);
    if (smooth && this.scroll.scrollTo) this.scroll.scrollTo({ top, left, behavior: 'smooth' });
    else {
      this.scroll.scrollTop = top;
      this.scroll.scrollLeft = left;
    }
    this.updateVisible();
  }

  /** Lleva un punto (coordenadas de página) de la página i cerca del borde superior de la pantalla. */
  scrollToPageOffset(i, y = 0, x = null) {
    const L = this.layout;
    if (!L.tops.length) return;
    i = clamp(i, 0, L.tops.length - 1);
    const z = this.zoom;
    this.scroll.scrollTop = Math.max(0, L.tops[i] + Math.max(0, y) * z - 16);
    const vw = this.scroll.clientWidth;
    if (x !== null && L.ws[i] > vw) this.scroll.scrollLeft = Math.max(0, L.lefts[i] + x * z - 16);
    else this.scroll.scrollLeft = Math.max(0, (L.stageW - vw) / 2);
    this.updateVisible();
  }

  /** Enlace del PDF que hay bajo un punto de la pantalla: { link, page, pageIndex } o null. */
  async linkAt(clientX, clientY) {
    const pt = this.clientToPage(clientX, clientY);
    if (!pt) return null;
    const ref = this.session.node.pages[pt.index];
    const page = ref ? this.session.getPageSync(ref.id) : null;
    if (!page || !page.pdf || !page.pdf.blobId) return null;
    const { baseW, links } = await getPageLinks(page.pdf.blobId, page.pdf.index, page.pdf.rotation || 0);
    if (!links.length || !baseW) return null;
    const k = page.pdf.w / baseW;
    const lx = (pt.x - (page.pdf.x || 0)) / k;
    const ly = (pt.y - (page.pdf.y || 0)) / k;
    const tol = 6 / (k * this.zoom); // unos píxeles de margen para acertar con el dedo
    let best = null;
    for (const l of links) {
      if (lx >= l.x - tol && lx <= l.x + l.w + tol && ly >= l.y - tol && ly <= l.y + l.h + tol) {
        // Si se solapan, el más pequeño (el más concreto).
        if (!best || l.w * l.h < best.w * best.h) best = l;
      }
    }
    return best ? { link: best, page, pageIndex: pt.index } : null;
  }

  /** Estado de vista para guardar: página, desplazamiento dentro de ella y zoom. */
  viewState() {
    const L = this.layout;
    const st = this.scroll.scrollTop;
    const i = Math.max(0, this.pageIndexAtY(st + 1));
    const ratio = L.hs[i] ? (st - L.tops[i]) / L.hs[i] : 0;
    return { page: i, ratio: clamp(ratio, -0.2, 1), zoom: this.zoom, left: this.scroll.scrollLeft, fit: this.fitMode };
  }

  restoreView(view) {
    if (view && Number.isFinite(view.zoom) && !view.fit) {
      this.zoom = clamp(view.zoom, MIN_ZOOM, MAX_ZOOM);
      this.fitMode = false;
    } else {
      this.zoom = this.fitWidthZoom();
      this.fitMode = true;
    }
    this.relayout();
    this._firstLayoutDone = true;
    if (view && Number.isFinite(view.page)) {
      const L = this.layout;
      const i = clamp(view.page, 0, L.tops.length - 1);
      this.scroll.scrollTop = L.tops[i] + (view.ratio || 0) * L.hs[i];
      this.scroll.scrollLeft = Number.isFinite(view.left) ? view.left : Math.max(0, (L.stageW - this.scroll.clientWidth) / 2);
    } else {
      this.scroll.scrollTop = 0;
      this.scroll.scrollLeft = Math.max(0, (this.layout.stageW - this.scroll.clientWidth) / 2);
    }
    this.updateVisible();
    this.emit('zoom', { zoom: this.zoom });
    this.emit('current-page', { index: this.currentPage, total: this.session.node.pages.length });
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.paintRaf);
    clearTimeout(this._zoomTimer);
    clearTimeout(this._indTimer);
    this._resizeObs.disconnect();
    this.scroll.removeEventListener('scroll', this._onScroll);
    this.scroll.removeEventListener('wheel', this._onWheel);
    for (const u of this._unsubs) u();
    for (const v of this.views.values()) v.destroy();
    this.views.clear();
    releaseCanvas(this.overlay);
    this.el.remove();
  }
}
