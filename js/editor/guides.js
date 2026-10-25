// Instrumentos de dibujo técnico (como en GoodNotes): regla, escuadra, cartabón y transportador son objetos
// transparentes sobre la hoja que se mueven con un dedo y se giran con dos (imán cada 15°). Si se escribe
// con la pluma pegada a uno de sus bordes, el trazo sigue ese borde (recto, o en arco en el transportador).
// El compás es una herramienta: punta (centro), abrir (radio) y girar el lápiz alrededor para trazar el arco.
//
// Cada instrumento vive en coordenadas de una página ({ page, x, y, a }: origen y giro), así se mueve con la
// hoja al desplazar o hacer zoom y sus centímetros son los de la hoja. Se pinta en una capa SVG propia.

import { PX_PER_MM } from '../model/paper.js';
import { strokeBBox } from '../model/stroke.js';
import { drawLiveStroke } from '../render/ink.js';
import { formatLength } from '../core/settings.js';
import { presetShapeStroke } from './tools.js';

const CM = PX_PER_MM * 10;
const DEG = Math.PI / 180;
const SNAP_PX = 22; // distancia en pantalla del lápiz al borde para que el trazo lo siga
const ANGLE_MAGNET = 1.5 * DEG; // cerca de un múltiplo de 15° el giro se queda exacto
const COMPASS_PIN_PX = 26; // tocar tan cerca del centro del compás cambia el radio
const SVGNS = 'http://www.w3.org/2000/svg';

export const INSTRUMENTS = [
  { id: 'ruler', name: 'Regla', icon: 'ruler' },
  { id: 'square', name: 'Escuadra', hint: '45°', icon: 'setSquare' },
  { id: 'cartabon', name: 'Cartabón', hint: '30° y 60°', icon: 'cartabon' },
  { id: 'protractor', name: 'Transportador', hint: 'Grados', icon: 'protractor' }
];

// ---------------------------------------------------------------------------
// Geometría de cada instrumento (coordenadas locales, unidades de página)
// ---------------------------------------------------------------------------

const RULER_L = 20 * CM;
const RULER_W = 3.2 * CM;
const SQUARE_A = 13 * CM;
const CART_L = 15 * CM;
const CART_S = CART_L / Math.sqrt(3);
const PROT_R = 7 * CM;

const GEOMETRY = {
  ruler: {
    poly: [[0, 0], [RULER_L, 0], [RULER_L, RULER_W], [0, RULER_W]],
    center: [RULER_L / 2, RULER_W / 2]
  },
  square: {
    poly: [[0, 0], [SQUARE_A, 0], [0, SQUARE_A]],
    center: [SQUARE_A / 3, SQUARE_A / 3]
  },
  cartabon: {
    poly: [[0, 0], [CART_L, 0], [0, CART_S]],
    center: [CART_L / 3, CART_S / 3]
  },
  protractor: {
    poly: null, // semicírculo: ver inside()
    arc: { r: PROT_R },
    center: [0, -PROT_R * 0.42]
  }
};

function edgesOf(type) {
  const g = GEOMETRY[type];
  if (type === 'protractor') return [{ seg: [-PROT_R, 0, PROT_R, 0] }, { arc: { cx: 0, cy: 0, r: PROT_R } }];
  const out = [];
  for (let i = 0; i < g.poly.length; i++) {
    const a = g.poly[i];
    const b = g.poly[(i + 1) % g.poly.length];
    out.push({ seg: [a[0], a[1], b[0], b[1]] });
  }
  return out;
}

function inside(type, lx, ly) {
  if (type === 'protractor') return ly <= 0 && lx * lx + ly * ly <= PROT_R * PROT_R;
  const poly = GEOMETRY[type].poly;
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > ly !== yj > ly && lx < ((xj - xi) * (ly - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}

/** Punto más cercano de un borde a (x, y) en coordenadas locales: { x, y, d }. */
function nearestOnEdge(e, x, y) {
  if (e.seg) {
    const [ax, ay, bx, by] = e.seg;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
    const px = ax + t * dx;
    const py = ay + t * dy;
    return { x: px, y: py, d: Math.hypot(x - px, y - py) };
  }
  const { cx, cy, r } = e.arc;
  // Arco superior del transportador: ángulos de −180° a 0° (y hacia abajo).
  let ang = Math.atan2(y - cy, x - cx);
  if (ang > 0) ang = ang > Math.PI / 2 ? -Math.PI : 0;
  const px = cx + r * Math.cos(ang);
  const py = cy + r * Math.sin(ang);
  return { x: px, y: py, d: Math.hypot(x - px, y - py) };
}

/** Rayitas cada milímetro a lo largo del eje local x (o y) desde `from` hasta `to` (en mm). */
function tickPath(axis, from, to, origin) {
  let d = '';
  for (let mm = from; mm <= to; mm++) {
    const len = mm % 10 === 0 ? 0.55 * CM : mm % 5 === 0 ? 0.38 * CM : 0.22 * CM;
    const p = origin + mm * PX_PER_MM;
    d += axis === 'x' ? `M${p.toFixed(2)} 0V${len.toFixed(2)}` : `M0 ${p.toFixed(2)}H${len.toFixed(2)}`;
  }
  return d;
}

function svg(tag, attrs = {}, text) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  if (text !== undefined) el.textContent = text;
  return el;
}

/** Triángulo interior (hueco) a distancia `o` de los tres lados de un triángulo rectángulo de catetos a, b. */
function innerTriangle(a, b, o) {
  const k = 1 - o * Math.sqrt(1 / (a * a) + 1 / (b * b));
  return [[o, o], [a * (k - o / b), o], [o, b * (k - o / a)]];
}

function buildShape(type) {
  const g = svg('g', { class: `guide guide-${type}` });
  const body = { class: 'guide-body', 'vector-effect': 'non-scaling-stroke' };
  const line = { class: 'guide-line', 'vector-effect': 'non-scaling-stroke' };
  const label = (x, y, txt, cls = 'guide-num', size = 0.32) => svg('text', { x: x.toFixed(2), y: y.toFixed(2), class: cls, 'font-size': (size * CM).toFixed(2), 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, txt);
  if (type === 'ruler') {
    g.appendChild(svg('rect', { ...body, x: 0, y: 0, width: RULER_L, height: RULER_W, rx: 0.15 * CM }));
    const x0 = 0.5 * CM;
    g.appendChild(svg('path', { ...line, d: tickPath('x', 0, 190, x0) }));
    for (let c = 0; c <= 19; c++) g.appendChild(label(x0 + c * CM, 0.95 * CM, String(c)));
    g.appendChild(label(RULER_L / 2, RULER_W * 0.68, 'cm', 'guide-unit', 0.28));
  } else if (type === 'square' || type === 'cartabon') {
    const a = type === 'square' ? SQUARE_A : CART_L;
    const b = type === 'square' ? SQUARE_A : CART_S;
    g.appendChild(svg('path', { ...body, d: `M0 0H${a}L0 ${b}Z` }));
    const hole = innerTriangle(a, b, 2.4 * CM);
    g.appendChild(svg('path', { class: 'guide-hole', 'vector-effect': 'non-scaling-stroke', d: `M${hole.map(p => p.map(v => v.toFixed(2)).join(' ')).join('L')}Z` }));
    const maxA = Math.floor((a - 1.6 * CM) / PX_PER_MM);
    const maxB = Math.floor((b - 1.6 * CM) / PX_PER_MM);
    g.appendChild(svg('path', { ...line, d: tickPath('x', 0, maxA, 0) + tickPath('y', 0, maxB, 0) }));
    for (let c = 1; c * 10 <= maxA; c++) g.appendChild(label(c * CM, 0.95 * CM, String(c)));
    for (let c = 1; c * 10 <= maxB; c++) g.appendChild(label(0.95 * CM, c * CM, String(c)));
    g.appendChild(label(a * 0.2, b * 0.2, type === 'square' ? '45°' : '30°·60°', 'guide-unit', 0.3));
  } else if (type === 'protractor') {
    const R = PROT_R;
    g.appendChild(svg('path', { ...body, d: `M${-R} 0A${R} ${R} 0 0 1 ${R} 0Z` }));
    let d = '';
    for (let deg = 0; deg <= 180; deg++) {
      const len = deg % 10 === 0 ? 0.65 * CM : deg % 5 === 0 ? 0.42 * CM : 0.24 * CM;
      const c = Math.cos(deg * DEG);
      const s = -Math.sin(deg * DEG);
      d += `M${(R * c).toFixed(2)} ${(R * s).toFixed(2)}L${((R - len) * c).toFixed(2)} ${((R - len) * s).toFixed(2)}`;
    }
    g.appendChild(svg('path', { ...line, d }));
    for (let deg = 0; deg <= 180; deg += 10) {
      const c = Math.cos(deg * DEG);
      const s = -Math.sin(deg * DEG);
      g.appendChild(label((R - 1.0 * CM) * c, (R - 1.0 * CM) * s, String(deg), 'guide-num', 0.28));
      g.appendChild(label((R - 1.5 * CM) * c, (R - 1.5 * CM) * s, String(180 - deg), 'guide-num2', 0.22));
    }
    g.appendChild(svg('path', { ...line, d: `M${-0.3 * CM} 0H${0.3 * CM}M0 0V${-0.3 * CM}M${-1.4 * CM} 0A${1.4 * CM} ${1.4 * CM} 0 0 1 ${1.4 * CM} 0` }));
  }
  return g;
}

// ---------------------------------------------------------------------------
// Capa de instrumentos de un visor
// ---------------------------------------------------------------------------

export class Guides {
  constructor(viewer, editor) {
    this.viewer = viewer;
    this.editor = editor;
    this.items = new Map(); // tipo → { type, page, x, y, a, g }
    this.compass = null; // { page, cx, cy, r }
    this.layer = svg('svg', { class: 'viewer-guides', 'aria-hidden': 'true' });
    this.compassG = svg('g', { class: 'guide-compass' });
    this.labelG = svg('g', { class: 'guide-label' });
    this.layer.append(this.compassG, this.labelG);
    viewer.el.appendChild(this.layer);
    const up = () => this.update();
    for (const ev of ['zoom', 'zoom-preview', 'resize']) viewer.on(ev, up);
    // Directo del evento nativo (no del aviso del visor, que llega un fotograma tarde): sin temblor al desplazar.
    viewer.scroll.addEventListener('scroll', () => { if (this.items.size || this.compass) up(); }, { passive: true });
    viewer.session.on('layout', up);
    // Rueda del ratón sobre un instrumento: girarlo (en vez de desplazar la hoja).
    viewer.el.addEventListener('wheel', e => {
      const it = this.hit(e.clientX, e.clientY);
      if (!it || e.ctrlKey) return;
      e.preventDefault();
      e.stopPropagation();
      this.rotateAround(it, this.centerPage(it), (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? 15 : 1) * DEG);
      this.showAngle(it);
      this.update();
    }, { capture: true, passive: false });
  }

  has(type) {
    return this.items.has(type);
  }

  get count() {
    return this.items.size;
  }

  toggle(type) {
    if (this.items.has(type)) this.remove(type);
    else this.add(type);
  }

  remove(type) {
    const it = this.items.get(type);
    if (!it) return;
    it.g.remove();
    this.items.delete(type);
  }

  clear() {
    for (const t of [...this.items.keys()]) this.remove(t);
  }

  /** Coloca el instrumento en el centro de la pantalla, recto. */
  add(type) {
    const v = this.viewer;
    const r = v.scroll.getBoundingClientRect();
    const pt = v.clientToPage(r.left + r.width / 2, r.top + r.height / 2);
    if (!pt) return;
    const [cx, cy] = GEOMETRY[type].center;
    const it = { type, page: pt.index, x: pt.x - cx, y: pt.y - cy, a: 0, g: buildShape(type) };
    this.items.set(type, it);
    this.layer.insertBefore(it.g, this.compassG);
    this.update();
  }

  // ---------------- Transformaciones ----------------

  /** Página → pantalla (relativa al visor): { s, ex, ey }, también durante el pellizco. */
  pageMatrix(i) {
    const v = this.viewer;
    const L = v.layout;
    if (!L || !L.tops.length) return null;
    i = Math.max(0, Math.min(L.tops.length - 1, i));
    const p = v._pinch;
    if (p && p.tx !== undefined) {
      return { s: p.k * v.zoom, ex: p.tx + p.k * L.lefts[i] - p.sl0, ey: p.ty + p.k * L.tops[i] - p.st0 };
    }
    return { s: v.zoom, ex: L.lefts[i] - v.scroll.scrollLeft, ey: L.tops[i] - v.scroll.scrollTop };
  }

  toPage(it, lx, ly) {
    const c = Math.cos(it.a);
    const s = Math.sin(it.a);
    return [it.x + c * lx - s * ly, it.y + s * lx + c * ly];
  }

  toLocal(it, px, py) {
    const c = Math.cos(it.a);
    const s = Math.sin(it.a);
    const dx = px - it.x;
    const dy = py - it.y;
    return [c * dx + s * dy, -s * dx + c * dy];
  }

  centerPage(it) {
    return this.toPage(it, ...GEOMETRY[it.type].center);
  }

  /** Punto de pantalla en coordenadas de la página `i` (aunque esté fuera de ella). */
  clientTo(i, clientX, clientY) {
    const pt = this.viewer.clientToPage(clientX, clientY, i);
    return pt ? [pt.x, pt.y] : null;
  }

  /** Desplazamiento para pasar coordenadas de la página k a la página i (todas comparten escala). */
  pageOffset(k, i) {
    if (k === i) return [0, 0];
    const L = this.viewer.layout;
    const z = this.viewer.zoom;
    return [(L.lefts[k] - L.lefts[i]) / z, (L.tops[k] - L.tops[i]) / z];
  }

  hit(clientX, clientY) {
    let best = null;
    for (const it of this.items.values()) {
      const p = this.clientTo(it.page, clientX, clientY);
      if (!p) continue;
      const [lx, ly] = this.toLocal(it, p[0], p[1]);
      if (inside(it.type, lx, ly)) best = it; // el último añadido queda encima
    }
    return best;
  }

  rotateAround(it, pivot, da) {
    const c = Math.cos(da);
    const s = Math.sin(da);
    const dx = it.x - pivot[0];
    const dy = it.y - pivot[1];
    it.x = pivot[0] + c * dx - s * dy;
    it.y = pivot[1] + s * dx + c * dy;
    it.a += da;
  }

  // ---------------- Gestos (llamados desde InputController) ----------------

  /** Empieza a mover un instrumento con un dedo o el ratón. */
  gestureStart(it, id, clientX, clientY) {
    this.gesture = { it, pts: new Map(), raw: { x: it.x, y: it.y, a: it.a }, rotated: false };
    this.gestureAdd(id, clientX, clientY);
  }

  gestureAdd(id, clientX, clientY) {
    const g = this.gesture;
    if (!g || g.pts.size >= 2) return;
    const p = this.clientTo(g.it.page, clientX, clientY);
    if (p) g.pts.set(id, p);
  }

  gestureMove(id, clientX, clientY) {
    const g = this.gesture;
    if (!g || !g.pts.has(id)) return;
    const it = g.it;
    const p = this.clientTo(it.page, clientX, clientY);
    if (!p) return;
    const before = [...g.pts.values()].map(q => q.slice());
    g.pts.set(id, p);
    const after = [...g.pts.values()];
    // Se trabaja sobre el estado "sin imán" para que el imán no frene el giro.
    const raw = { type: it.type, ...g.raw };
    if (after.length === 1) {
      raw.x += after[0][0] - before[0][0];
      raw.y += after[0][1] - before[0][1];
    } else {
      const [a0, b0] = before;
      const [a1, b1] = after;
      const m0 = [(a0[0] + b0[0]) / 2, (a0[1] + b0[1]) / 2];
      const m1 = [(a1[0] + b1[0]) / 2, (a1[1] + b1[1]) / 2];
      const da = Math.atan2(b1[1] - a1[1], b1[0] - a1[0]) - Math.atan2(b0[1] - a0[1], b0[0] - a0[0]);
      this.rotateAround(raw, m0, da);
      raw.x += m1[0] - m0[0];
      raw.y += m1[1] - m0[1];
      g.rotated = true;
      g.pivot = m1;
    }
    g.raw = { x: raw.x, y: raw.y, a: raw.a };
    Object.assign(it, g.raw);
    if (g.rotated) {
      const step = 15 * DEG;
      const snapA = Math.round(it.a / step) * step;
      if (Math.abs(snapA - it.a) < ANGLE_MAGNET) this.rotateAround(it, g.pivot || this.centerPage(it), snapA - it.a);
      this.showAngle(it);
    }
    this.update();
  }

  gestureEnd(id) {
    const g = this.gesture;
    if (!g) return;
    g.pts.delete(id);
    if (!g.pts.size) {
      this.gesture = null;
      this.hideAngleSoon();
    }
  }

  gestureCancel() {
    if (this.gesture) this.hideAngleSoon();
    this.gesture = null;
  }

  // ---------------- Seguir el borde al escribir ----------------

  /**
   * Si (clientX, clientY) está junto al borde de un instrumento, devuelve una función que lleva cualquier
   * punto (coordenadas de la página `pageIndex`) a ese borde; si no, null.
   */
  snapper(pageIndex, clientX, clientY) {
    let best = null;
    const z = this.viewer.zoom;
    for (const it of this.items.values()) {
      const p = this.clientTo(it.page, clientX, clientY);
      if (!p) continue;
      const [lx, ly] = this.toLocal(it, p[0], p[1]);
      for (const e of edgesOf(it.type)) {
        const n = nearestOnEdge(e, lx, ly);
        const d = n.d * z;
        if (d < SNAP_PX && (!best || d < best.d)) best = { d, it, e };
      }
    }
    if (!best) return null;
    const { it, e } = best;
    const [ox, oy] = this.pageOffset(pageIndex, it.page);
    const snap = { it: { ...it } };
    return pt => {
      const [lx, ly] = this.toLocal(snap.it, pt.x + ox, pt.y + oy);
      const n = nearestOnEdge(e, lx, ly);
      const [px, py] = this.toPage(snap.it, n.x, n.y);
      return { x: px - ox, y: py - oy, p: pt.p };
    };
  }

  // ---------------- Pintado ----------------

  update() {
    for (const it of this.items.values()) {
      const m = this.pageMatrix(it.page);
      if (!m) continue;
      const c = Math.cos(it.a) * m.s;
      const s = Math.sin(it.a) * m.s;
      it.g.setAttribute('transform', `matrix(${c} ${s} ${-s} ${c} ${m.ex + m.s * it.x} ${m.ey + m.s * it.y})`);
    }
    this.drawCompass();
    if (this._angleFor) this.placeAngle();
  }

  showAngle(it) {
    clearTimeout(this._angleTimer);
    this._angleFor = it;
    this.placeAngle();
  }

  hideAngleSoon() {
    clearTimeout(this._angleTimer);
    this._angleTimer = setTimeout(() => {
      this._angleFor = null;
      this.labelG.replaceChildren();
    }, 700);
  }

  placeAngle() {
    const it = this._angleFor;
    if (!it || !this.items.has(it.type)) {
      this.labelG.replaceChildren();
      return;
    }
    let deg = Math.round(-it.a / DEG) % 360;
    if (deg < 0) deg += 360;
    if (it.type === 'ruler') deg %= 180;
    const [px, py] = this.centerPage(it);
    const m = this.pageMatrix(it.page);
    if (!m) return;
    this.setLabel(`${deg}°`, m.ex + m.s * px, m.ey + m.s * py);
  }

  setLabel(text, x, y) {
    const w = 14 + text.length * 8.5;
    this.labelG.replaceChildren(
      svg('rect', { x: (x - w / 2).toFixed(1), y: (y - 13).toFixed(1), width: w.toFixed(1), height: 26, rx: 13, class: 'guide-label-bg' }),
      svg('text', { x: x.toFixed(1), y: (y + 0.5).toFixed(1), class: 'guide-label-text', 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, text)
    );
  }

  /** Compás: punta, circunferencia de guía y, mientras se abre, el radio con su medida. */
  drawCompass() {
    const c = this.compass;
    const showing = c && this.editor.tool === 'compass';
    if (!showing) {
      if (this.compassG.firstChild) this.compassG.replaceChildren();
      return;
    }
    const m = this.pageMatrix(c.page);
    if (!m) return;
    const X = m.ex + m.s * c.cx;
    const Y = m.ey + m.s * c.cy;
    const R = m.s * c.r;
    const kids = [];
    if (R > 1) kids.push(svg('circle', { cx: X, cy: Y, r: R, class: 'compass-ring' }));
    if (c.arm !== undefined && R > 1) {
      const ax = X + R * Math.cos(c.arm);
      const ay = Y + R * Math.sin(c.arm);
      kids.push(svg('line', { x1: X, y1: Y, x2: ax, y2: ay, class: 'compass-arm' }));
      kids.push(svg('circle', { cx: ax, cy: ay, r: 4, class: 'compass-tip' }));
    }
    kids.push(svg('circle', { cx: X, cy: Y, r: 5, class: 'compass-pin' }));
    this.compassG.replaceChildren(...kids);
    if (c.showRadius) this.setLabel(`r = ${formatLength(c.r)}`, X, Y - 28);
  }
}

// ---------------------------------------------------------------------------
// Compás
// ---------------------------------------------------------------------------

export class CompassTool {
  constructor(editor) {
    this.editor = editor;
    this.modifies = true;
    this.usesPrediction = false;
  }

  begin(ctx) {
    this.ctx = ctx;
    const guides = ctx.viewer.guides;
    this.guides = guides;
    const z = ctx.viewer.zoom;
    let c = guides.compass;
    // Si la página del compás ya no está cargada, se empieza uno nuevo (nunca se pierde un arco).
    const cPage = c && ctx.viewer.session.node.pages[c.page];
    if (c && (!cPage || !ctx.viewer.session.getPageSync(cPage.id))) c = null;
    let local = null;
    if (c) {
      const [ox, oy] = guides.pageOffset(ctx.pageIndex, c.page);
      this.off = [ox, oy];
      local = [ctx.x + ox, ctx.y + oy];
    }
    const d = c ? Math.hypot(local[0] - c.cx, local[1] - c.cy) : Infinity;
    if (c && d * z < COMPASS_PIN_PX) {
      this.mode = 'radius';
    } else if (c && c.r * z > 8 && Math.abs(d - c.r) * z < Math.max(40, c.r * z * 0.35)) {
      this.mode = 'arc';
      this.a0 = Math.atan2(local[1] - c.cy, local[0] - c.cx);
      this.last = this.a0;
      this.sweep = 0;
      c.arm = this.a0;
    } else {
      this.mode = 'radius';
      guides.compass = c = { page: ctx.pageIndex, cx: ctx.x, cy: ctx.y, r: 0 };
      this.off = [0, 0];
    }
    if (this.mode === 'radius') c.showRadius = true;
    guides.update();
  }

  local(p) {
    return [p.x + this.off[0], p.y + this.off[1]];
  }

  move(points) {
    const c = this.guides.compass;
    if (!c || !points.length) return;
    if (this.mode === 'radius') {
      const [x, y] = this.local(points[points.length - 1]);
      c.r = Math.hypot(x - c.cx, y - c.cy);
      c.arm = Math.atan2(y - c.cy, x - c.cx);
      this.guides.update();
      return;
    }
    for (const p of points) {
      const [x, y] = this.local(p);
      const a = Math.atan2(y - c.cy, x - c.cx);
      let da = a - this.last;
      if (da > Math.PI) da -= 2 * Math.PI;
      if (da < -Math.PI) da += 2 * Math.PI;
      this.last = a;
      this.sweep = Math.max(-2 * Math.PI, Math.min(2 * Math.PI, this.sweep + da));
    }
    c.arm = this.a0 + this.sweep;
    this.guides.update();
    this.render();
  }

  stroke() {
    const c = this.guides.compass;
    const full = Math.abs(this.sweep) >= 2 * Math.PI - 0.02;
    const sweep = full ? 2 * Math.PI : this.sweep;
    const n = Math.max(8, Math.ceil((Math.abs(sweep) * c.r) / 3), Math.ceil(Math.abs(sweep) / (4 * DEG)));
    const pts = [];
    const count = full ? n : n + 1;
    for (let i = 0; i < count; i++) {
      const t = this.a0 + (sweep * i) / n;
      pts.push(c.cx + c.r * Math.cos(t), c.cy + c.r * Math.sin(t));
    }
    return presetShapeStroke(this.editor.activePreset(), pts, full, 'arc', this.ctx.viewer.zoom);
  }

  render() {
    const v = this.ctx.viewer;
    v.clearOverlay();
    if (Math.abs(this.sweep) < 0.01) return;
    const s = this.stroke();
    const ctx = v.octx;
    const m = v.overlayTransform(this.guides.compass.page);
    ctx.save();
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    try {
      drawLiveStroke(ctx, s);
    } finally {
      ctx.restore();
    }
  }

  end() {
    const c = this.guides.compass;
    const v = this.ctx.viewer;
    v.clearOverlay();
    if (!c) return;
    c.showRadius = false;
    c.arm = undefined;
    if (this.mode === 'radius') {
      this.guides.labelG.replaceChildren();
      if (c.r * v.zoom < 6) this.guides.compass = null; // un toque sin abrir: nada
      this.guides.update();
      return;
    }
    this.guides.update();
    if (Math.abs(this.sweep) * c.r * v.zoom < 4) return;
    const s = this.stroke();
    const ref = v.session.node.pages[c.page];
    if (!ref) return;
    v.session.addStrokes(ref.id, [s], { origin: v, label: 'Compás' });
    this.editor.afterStroke(v, c.page, strokeBBox(s));
  }

  cancel() {
    const c = this.guides && this.guides.compass;
    if (c) {
      c.showRadius = false;
      c.arm = undefined;
      this.guides.labelG.replaceChildren();
      this.guides.update();
    }
    if (this.ctx) this.ctx.viewer.clearOverlay();
  }
}
