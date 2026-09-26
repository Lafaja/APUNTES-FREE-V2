// Lazo de selección: seleccionar, mover, escalar, rotar, recolorear, copiar, cortar, pegar y duplicar.

import {
  strokeBBox, imageBBox, unionRect, strokeInsideLasso, imageInsideLasso, imageHitByPoint,
  translation, scalingAbout, rotationAbout, matMul, IDENTITY, applyMat, transformStroke, transformImage,
  recolorStroke, cloneStroke, cloneImage, distSqPointSeg, strokeRadius
} from '../model/stroke.js';
import { drawStroke } from '../render/ink.js';
import { getImage } from '../render/images.js';
import { h, iconEl } from '../ui/dom.js';
import { openMenu, openPopover, closePopover } from '../ui/popover.js';
import { INK_COLORS } from '../core/settings.js';

const HANDLE_R = 9; // radio visual (px de pantalla)
const HANDLE_HIT = 22; // radio de impacto (px de pantalla)
const ROTATE_OFFSET = 34;

export class Selection {
  constructor(editor) {
    this.editor = editor;
    this.sel = null; // { viewer, pageId, strokeIds:Set, imageIds:Set }
    this.menu = null;
    this.clipboard = null;
  }

  get active() {
    return !!this.sel;
  }

  // -------------------- Estado --------------------

  items() {
    const s = this.sel;
    if (!s) return { page: null, strokes: [], images: [] };
    const page = s.viewer.session.getPageSync(s.pageId);
    if (!page) return { page: null, strokes: [], images: [] };
    return {
      page,
      strokes: page.strokes.filter(x => s.strokeIds.has(x.id)),
      images: page.images.filter(x => s.imageIds.has(x.id))
    };
  }

  bbox() {
    const { strokes, images } = this.items();
    let r = null;
    for (const s of strokes) r = unionRect(r, strokeBBox(s));
    for (const i of images) r = unionRect(r, imageBBox(i));
    return r;
  }

  pageIndex() {
    return this.sel ? this.sel.viewer.session.pageIndex(this.sel.pageId) : -1;
  }

  set(viewer, pageId, strokeIds, imageIds) {
    this.clear();
    if (!strokeIds.size && !imageIds.size) return;
    this.sel = { viewer, pageId, strokeIds, imageIds };
    this.redraw();
  }

  clear() {
    if (!this.sel) return;
    const v = this.sel.viewer;
    v.setHidden(this.sel.pageId, null);
    this.sel = null;
    this.hideMenu();
    v.clearOverlay();
  }

  /** Tras deshacer/rehacer o cambios externos: quitar ids que ya no existen. */
  validate() {
    if (!this.sel) return;
    const { page, strokes, images } = this.items();
    if (!page || this.pageIndex() === -1) {
      this.clear();
      return;
    }
    this.sel.strokeIds = new Set(strokes.map(s => s.id));
    this.sel.imageIds = new Set(images.map(i => i.id));
    if (!this.sel.strokeIds.size && !this.sel.imageIds.size) this.clear();
    else this.redraw();
  }

  // -------------------- Dibujo de la selección --------------------

  redraw(matrix = null) {
    const s = this.sel;
    if (!s) return;
    const v = s.viewer;
    const i = this.pageIndex();
    if (i < 0) return;
    const box = this.bbox();
    if (!box) return;
    v.clearOverlay();
    const ctx = v.octx;
    const m = v.overlayTransform(i);
    const M = matrix || IDENTITY;
    // Elementos en movimiento (ocultos en la página, dibujados aquí con la transformación).
    if (matrix) {
      const { strokes, images } = this.items();
      ctx.save();
      ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
      ctx.transform(M[0], M[1], M[2], M[3], M[4], M[5]);
      for (const img of images) {
        const bmp = getImage(img.blobId);
        ctx.save();
        ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
        if (img.rot) ctx.rotate((img.rot * Math.PI) / 180);
        if (bmp) {
          if (img.crop) ctx.drawImage(bmp, img.crop.x, img.crop.y, img.crop.w, img.crop.h, -img.w / 2, -img.h / 2, img.w, img.h);
          else ctx.drawImage(bmp, -img.w / 2, -img.h / 2, img.w, img.h);
        } else {
          ctx.fillStyle = 'rgba(148,163,184,0.3)';
          ctx.fillRect(-img.w / 2, -img.h / 2, img.w, img.h);
        }
        ctx.restore();
      }
      for (const st of strokes) if (st.t === 'highlighter') drawStroke(ctx, st);
      for (const st of strokes) if (st.t !== 'highlighter') drawStroke(ctx, st);
      ctx.restore();
    }
    // Marco y tiradores en píxeles de pantalla.
    const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]].map(([x, y]) => {
      const [tx, ty] = applyMat(M, x, y);
      return [m[0] * tx + m[4], m[3] * ty + m[5]];
    });
    const d = v.dpr;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.lineWidth = 1.5 * d;
    ctx.strokeStyle = '#2563eb';
    ctx.setLineDash([6 * d, 5 * d]);
    ctx.beginPath();
    corners.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,0.05)';
    ctx.fill();
    ctx.stroke();
    ctx.setLineDash([]);
    // Tirador de rotación
    const top = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    const rot = this.rotateHandlePos(corners);
    ctx.beginPath();
    ctx.moveTo(top[0], top[1]);
    ctx.lineTo(rot[0], rot[1]);
    ctx.stroke();
    const handle = (x, y) => {
      ctx.beginPath();
      ctx.arc(x, y, HANDLE_R * d, 0, Math.PI * 2);
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.lineWidth = 2.5 * d;
      ctx.stroke();
    };
    for (const [x, y] of corners) handle(x, y);
    handle(rot[0], rot[1]);
    ctx.restore();
    if (!matrix) this.showMenu(corners);
  }

  rotateHandlePos(corners) {
    const d = this.sel.viewer.dpr;
    const top = [(corners[0][0] + corners[1][0]) / 2, (corners[0][1] + corners[1][1]) / 2];
    const bottom = [(corners[3][0] + corners[2][0]) / 2, (corners[3][1] + corners[2][1]) / 2];
    const dx = top[0] - bottom[0];
    const dy = top[1] - bottom[1];
    const len = Math.hypot(dx, dy) || 1;
    return [top[0] + (dx / len) * ROTATE_OFFSET * d, top[1] + (dy / len) * ROTATE_OFFSET * d];
  }

  /** Qué parte de la selección hay bajo un punto de pantalla: 'rotate' | 'corner:n' | 'inside' | null. */
  hitTest(viewer, clientX, clientY) {
    if (!this.sel || this.sel.viewer !== viewer) return null;
    const i = this.pageIndex();
    const box = this.bbox();
    if (i < 0 || !box) return null;
    const m = viewer.overlayTransform(i);
    const d = viewer.dpr;
    const r = viewer.overlay.getBoundingClientRect();
    const px = (clientX - r.left) * d;
    const py = (clientY - r.top) * d;
    const corners = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]].map(([x, y]) => [m[0] * x + m[4], m[3] * y + m[5]]);
    const rot = this.rotateHandlePos(corners);
    const hit = HANDLE_HIT * d;
    if (Math.hypot(px - rot[0], py - rot[1]) <= hit) return { kind: 'rotate', corners };
    for (let k = 0; k < 4; k++) {
      if (Math.hypot(px - corners[k][0], py - corners[k][1]) <= hit) return { kind: 'corner', index: k, corners };
    }
    const pad = 10 * d;
    if (px >= corners[0][0] - pad && px <= corners[2][0] + pad && py >= corners[0][1] - pad && py <= corners[2][1] + pad) return { kind: 'inside', corners };
    return null;
  }

  // -------------------- Menú flotante --------------------

  showMenu(corners) {
    const v = this.sel.viewer;
    const d = v.dpr;
    const minY = Math.min(...corners.map(c => c[1])) / d;
    const maxY = Math.max(...corners.map(c => c[1])) / d;
    const cx = (Math.min(...corners.map(c => c[0])) + Math.max(...corners.map(c => c[0]))) / 2 / d;
    if (!this.menu) {
      this.menu = h('div.selection-menu');
      const mk = (label, icon, fn) => {
        const b = h('button.btn', { type: 'button' }, iconEl(icon), label);
        b.addEventListener('click', e => {
          e.stopPropagation();
          fn(b);
        });
        return b;
      };
      this.menu.append(
        mk('Copiar', 'copy', () => this.copy()),
        mk('Cortar', 'scissors', () => this.cut()),
        mk('Duplicar', 'layers', () => this.duplicate()),
        mk('Color', 'palette', b => this.pickColor(b)),
        mk('', 'rotate', () => this.rotateBy(90)),
        mk('Eliminar', 'trash', () => this.remove()),
        mk('', 'more', b => this.moreMenu(b))
      );
      this.menu.addEventListener('pointerdown', e => e.stopPropagation());
    }
    if (this.menu.parentNode !== v.el) v.el.appendChild(this.menu);
    this.menu.hidden = false;
    // El menú se ancla por su borde inferior (translate -100 %): se coloca encima de la selección
    // y, si no cabe, debajo; si tampoco, arriba del todo.
    const vh = v.el.clientHeight;
    const menuH = this.menu.offsetHeight || 46;
    let bottom = minY - ROTATE_OFFSET - HANDLE_R - 10; // por encima del tirador de rotación
    if (bottom - menuH < 8) {
      bottom = maxY + HANDLE_R + 14 + menuH;
      if (bottom > vh - 8) bottom = menuH + 8;
    }
    const halfW = (this.menu.offsetWidth || 420) / 2;
    const left = Math.max(halfW + 8, Math.min(v.el.clientWidth - halfW - 8, cx));
    this.menu.style.left = `${left}px`;
    this.menu.style.top = `${bottom}px`;
  }

  hideMenu() {
    if (this.menu) {
      this.menu.hidden = true;
      this.menu.remove();
    }
    closePopover();
  }

  // -------------------- Acciones --------------------

  _commitReplace(label, fnStroke, fnImage) {
    const s = this.sel;
    if (!s) return;
    const session = s.viewer.session;
    const { page, strokes, images } = this.items();
    if (!page) return;
    const rs = new Map();
    const ri = new Map();
    if (fnStroke) for (const st of strokes) rs.set(st.id, fnStroke(st));
    if (fnImage) for (const im of images) ri.set(im.id, fnImage(im));
    const ops = [...session.opsForReplace(page, 'strokes', rs), ...session.opsForReplace(page, 'images', ri)];
    if (ops.length) session.commit(s.pageId, ops, { label, origin: s.viewer });
  }

  applyMatrix(M, label = 'Transformar') {
    this._commitReplace(label, st => transformStroke(st, M), im => transformImage(im, M));
    this.redraw();
  }

  rotateBy(deg) {
    const box = this.bbox();
    if (!box) return;
    const cx = (box.minX + box.maxX) / 2;
    const cy = (box.minY + box.maxY) / 2;
    this.applyMatrix(rotationAbout((deg * Math.PI) / 180, cx, cy), 'Rotar');
  }

  recolor(color) {
    this._commitReplace('Color', st => recolorStroke(st, color), null);
    this.redraw();
  }

  pickColor(anchor) {
    const grid = h('div.swatches');
    for (const c of [...INK_COLORS, ...(this.editor.favColors() || [])]) {
      const b = h('button.swatch', { type: 'button', style: { background: c }, title: c });
      b.addEventListener('click', () => {
        closePopover();
        this.recolor(c);
      });
      grid.appendChild(b);
    }
    openPopover(anchor, h('div.tool-panel', h('h3', 'Color de la selección'), grid));
  }

  remove() {
    const s = this.sel;
    if (!s) return;
    const session = s.viewer.session;
    const page = session.getPageSync(s.pageId);
    const ops = [...session.opsForRemoval(page, 'strokes', s.strokeIds), ...session.opsForRemoval(page, 'images', s.imageIds)];
    this.clear();
    if (ops.length) session.commit(s.pageId, ops, { label: 'Eliminar', origin: s.viewer });
  }

  copy({ silent = false } = {}) {
    const { strokes, images } = this.items();
    if (!strokes.length && !images.length) return;
    this.clipboard = {
      strokes: strokes.map(s => cloneStroke(s)),
      images: images.map(i => cloneImage(i)),
      bbox: this.bbox(),
      fromPage: this.sel.pageId
    };
    if (!silent) this.editor.toast('Copiado', 'success');
  }

  cut() {
    this.copy({ silent: true });
    this.remove();
    this.editor.toast('Cortado · usa «Pegar» para colocarlo', 'info');
  }

  duplicate() {
    this.copy({ silent: true });
    this.paste(this.sel.viewer, this.pageIndex(), null, { offset: 24 });
  }

  /** Pega el portapapeles en la página indicada (en `at` si se da, si no desplazado u centrado). */
  paste(viewer, pageIndex, at = null, { offset = 24 } = {}) {
    const cb = this.clipboard;
    if (!cb) return;
    const session = viewer.session;
    const ref = session.node.pages[pageIndex];
    if (!ref) return;
    const page = session.getPageSync(ref.id);
    if (!page) return;
    let dx = offset;
    let dy = offset;
    const bw = cb.bbox.maxX - cb.bbox.minX;
    const bh = cb.bbox.maxY - cb.bbox.minY;
    if (at) {
      dx = at.x - (cb.bbox.minX + bw / 2);
      dy = at.y - (cb.bbox.minY + bh / 2);
    } else if (cb.fromPage !== ref.id) {
      const vis = viewer.visiblePageRect(pageIndex) || { x: 0, y: 0, w: ref.w, h: ref.h };
      dx = vis.x + vis.w / 2 - (cb.bbox.minX + bw / 2);
      dy = vis.y + vis.h / 2 - (cb.bbox.minY + bh / 2);
    }
    const M = translation(dx, dy);
    const strokes = cb.strokes.map(s => transformStroke(cloneStroke(s, true), M));
    const images = cb.images.map(i => transformImage(cloneImage(i, true), M));
    const ops = [];
    if (strokes.length) ops.push({ key: 'strokes', index: page.strokes.length, removed: [], added: strokes });
    if (images.length) ops.push({ key: 'images', index: page.images.length, removed: [], added: images });
    session.commit(ref.id, ops, { label: 'Pegar', origin: viewer });
    this.editor.useLasso();
    this.set(viewer, ref.id, new Set(strokes.map(s => s.id)), new Set(images.map(i => i.id)));
    // El siguiente pegado se desplaza un poco más para no quedar encima.
    cb.bbox = { minX: cb.bbox.minX + dx, minY: cb.bbox.minY + dy, maxX: cb.bbox.maxX + dx, maxY: cb.bbox.maxY + dy };
    cb.fromPage = ref.id;
  }

  reorder(toFront) {
    const s = this.sel;
    if (!s) return;
    const session = s.viewer.session;
    const page = session.getPageSync(s.pageId);
    const ops = [];
    for (const key of ['strokes', 'images']) {
      const ids = key === 'strokes' ? s.strokeIds : s.imageIds;
      const moved = page[key].filter(x => ids.has(x.id));
      if (!moved.length) continue;
      const rest = page[key].filter(x => !ids.has(x.id));
      const next = toFront ? [...rest, ...moved] : [...moved, ...rest];
      ops.push({ key, index: 0, removed: [...page[key]], added: next });
    }
    if (ops.length) session.commit(s.pageId, ops, { label: toFront ? 'Traer al frente' : 'Enviar al fondo', origin: s.viewer });
    this.redraw();
  }

  moreMenu(anchor) {
    openMenu(anchor, [
      { label: 'Rotar 90° a la izquierda', icon: 'restore', onClick: () => this.rotateBy(-90) },
      { label: 'Traer al frente', icon: 'bringFront', onClick: () => this.reorder(true) },
      { label: 'Enviar al fondo', icon: 'layers', onClick: () => this.reorder(false) },
      'sep',
      { label: 'Quitar selección', icon: 'x', onClick: () => this.clear() }
    ]);
  }
}

// ---------------------------------------------------------------------------
// Herramienta de lazo
// ---------------------------------------------------------------------------

export class LassoTool {
  constructor(editor, selection) {
    this.editor = editor;
    this.selection = selection;
    this.modifies = true;
    this.usesPrediction = false;
  }

  begin(ctx) {
    this.ctx = ctx;
    this.mode = null;
    const sel = this.selection;
    const hit = sel.hitTest(ctx.viewer, ctx.clientX, ctx.clientY);
    if (hit && sel.sel.pageId === ctx.pageId) {
      this.startTransform(hit, ctx);
      return;
    }
    sel.clear();
    this.mode = 'lasso';
    this.path = [ctx.x, ctx.y];
    this.startClient = { x: ctx.clientX, y: ctx.clientY };
    this.maxDist = 0;
  }

  startTransform(hit, ctx) {
    const sel = this.selection;
    const box = sel.bbox();
    this.box = box;
    this.start = { x: ctx.x, y: ctx.y };
    this.M = IDENTITY;
    sel.hideMenu();
    ctx.viewer.setHidden(sel.sel.pageId, new Set([...sel.sel.strokeIds, ...sel.sel.imageIds]));
    if (hit.kind === 'rotate') {
      this.mode = 'rotate';
      this.center = { x: (box.minX + box.maxX) / 2, y: (box.minY + box.maxY) / 2 };
      this.a0 = Math.atan2(ctx.y - this.center.y, ctx.x - this.center.x);
    } else if (hit.kind === 'corner') {
      this.mode = 'scale';
      const c = [[box.minX, box.minY], [box.maxX, box.minY], [box.maxX, box.maxY], [box.minX, box.maxY]];
      const opp = c[(hit.index + 2) % 4];
      this.anchor = { x: opp[0], y: opp[1] };
      this.corner = { x: c[hit.index][0], y: c[hit.index][1] };
    } else {
      this.mode = 'move';
    }
    sel.redraw(this.M);
  }

  move(points) {
    const p = points[points.length - 1];
    if (!p) return;
    const { viewer } = this.ctx;
    if (this.mode === 'lasso') {
      for (const q of points) {
        const n = this.path.length;
        if (Math.hypot(q.x - this.path[n - 2], q.y - this.path[n - 1]) * viewer.zoom >= 2) this.path.push(q.x, q.y);
      }
      this.maxDist = Math.max(this.maxDist, Math.hypot(p.x - this.path[0], p.y - this.path[1]) * viewer.zoom);
      this.drawLasso();
      return;
    }
    if (this.mode === 'move') {
      this.M = translation(p.x - this.start.x, p.y - this.start.y);
    } else if (this.mode === 'scale') {
      const vx = this.corner.x - this.anchor.x;
      const vy = this.corner.y - this.anchor.y;
      const len2 = vx * vx + vy * vy || 1;
      let s = ((p.x - this.anchor.x) * vx + (p.y - this.anchor.y) * vy) / len2;
      s = Math.max(0.05, Math.min(20, s));
      this.M = scalingAbout(s, s, this.anchor.x, this.anchor.y);
    } else if (this.mode === 'rotate') {
      let a = Math.atan2(p.y - this.center.y, p.x - this.center.x) - this.a0;
      const deg = (a * 180) / Math.PI;
      const snap = Math.round(deg / 90) * 90;
      if (Math.abs(deg - snap) < 4) a = (snap * Math.PI) / 180;
      this.M = rotationAbout(a, this.center.x, this.center.y);
    }
    this.selection.redraw(this.M);
  }

  drawLasso() {
    const { viewer, pageIndex } = this.ctx;
    viewer.clearOverlay();
    const ctx = viewer.octx;
    const m = viewer.overlayTransform(pageIndex);
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.beginPath();
    for (let i = 0; i < this.path.length; i += 2) {
      if (i === 0) ctx.moveTo(this.path[i], this.path[i + 1]);
      else ctx.lineTo(this.path[i], this.path[i + 1]);
    }
    ctx.closePath();
    ctx.fillStyle = 'rgba(37,99,235,0.07)';
    ctx.fill();
    ctx.lineWidth = 1.6 / viewer.zoom;
    ctx.setLineDash([6 / viewer.zoom, 5 / viewer.zoom]);
    ctx.strokeStyle = '#2563eb';
    ctx.stroke();
    ctx.restore();
  }

  end(last) {
    const { viewer, pageId, pageIndex } = this.ctx;
    const sel = this.selection;
    if (this.mode === 'lasso') {
      viewer.clearOverlay();
      const page = viewer.session.getPageSync(pageId);
      if (!page) return;
      if (this.maxDist < 8) {
        this.tapSelect(page, last || { x: this.path[0], y: this.path[1] });
        return;
      }
      const poly = this.path;
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (let i = 0; i < poly.length; i += 2) {
        minX = Math.min(minX, poly[i]);
        maxX = Math.max(maxX, poly[i]);
        minY = Math.min(minY, poly[i + 1]);
        maxY = Math.max(maxY, poly[i + 1]);
      }
      const box = { minX, minY, maxX, maxY };
      const strokeIds = new Set(page.strokes.filter(s => strokeInsideLasso(s, poly, box)).map(s => s.id));
      const imageIds = new Set(page.images.filter(i => imageInsideLasso(i, poly)).map(i => i.id));
      sel.set(viewer, pageId, strokeIds, imageIds);
      return;
    }
    if (!sel.sel) return;
    const M = this.M;
    viewer.setHidden(sel.sel.pageId, null);
    const moved = M !== IDENTITY && (Math.abs(M[4]) > 0.01 || Math.abs(M[5]) > 0.01 || Math.abs(M[0] - 1) > 1e-4 || Math.abs(M[1]) > 1e-4);
    if (moved) sel.applyMatrix(M, this.mode === 'move' ? 'Mover' : this.mode === 'scale' ? 'Escalar' : 'Rotar');
    else sel.redraw();
    this.mode = null;
  }

  tapSelect(page, pt) {
    const { viewer, pageId, pageIndex } = this.ctx;
    const tol = 8 / viewer.zoom;
    for (let i = page.images.length - 1; i >= 0; i--) {
      if (imageHitByPoint(page.images[i], pt.x, pt.y)) {
        this.selection.set(viewer, pageId, new Set(), new Set([page.images[i].id]));
        return;
      }
    }
    for (let i = page.strokes.length - 1; i >= 0; i--) {
      const s = page.strokes[i];
      const b = strokeBBox(s);
      if (pt.x < b.minX - tol || pt.x > b.maxX + tol || pt.y < b.minY - tol || pt.y > b.maxY + tol) continue;
      const r = tol + strokeRadius(s);
      const p = s.pts;
      for (let k = 0; k < p.length - 3; k += 3) {
        if (distSqPointSeg(pt.x, pt.y, p[k], p[k + 1], p[k + 3], p[k + 4]) <= r * r) {
          this.selection.set(viewer, pageId, new Set([s.id]), new Set());
          return;
        }
      }
      if (p.length === 3 && Math.hypot(pt.x - p[0], pt.y - p[1]) <= r) {
        this.selection.set(viewer, pageId, new Set([s.id]), new Set());
        return;
      }
    }
    // Nada debajo: si hay algo copiado, ofrecer pegar aquí.
    if (this.selection.clipboard) {
      const c = viewer.pageToClient(pageIndex, pt.x, pt.y);
      openMenu({ x: c.x, y: c.y }, [{ label: 'Pegar aquí', icon: 'clipboard', onClick: () => this.selection.paste(viewer, pageIndex, pt) }]);
    }
  }

  cancel() {
    if (this.mode && this.mode !== 'lasso' && this.selection.sel) {
      this.ctx.viewer.setHidden(this.selection.sel.pageId, null);
      this.selection.redraw();
    } else if (this.ctx) {
      this.ctx.viewer.clearOverlay();
    }
    this.mode = null;
  }
}

export { matMul };
