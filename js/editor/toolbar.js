// Barra de herramientas del editor y paneles de ajustes de cada herramienta.

import { settings, INK_COLORS, HIGHLIGHT_COLORS, formatLength, KIT_TYPES, layoutItems } from '../core/settings.js';
import { uid } from '../core/util.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openPopover, closePopover } from '../ui/popover.js';
import { BRUSHES, DASHES, dashPattern, drawLiveStroke } from '../render/ink.js';
import { SHAPES } from './tools.js';
import { INSTRUMENTS } from './guides.js';
import { createColorPicker } from '../ui/colorpicker.js';

/** Guarda un color en "mis colores" (máximo 16, sin repetir los de serie). */
function rememberColor(c) {
  const fav = settings.get('favColors');
  if (!fav.includes(c) && !INK_COLORS.includes(c) && !HIGHLIGHT_COLORS.includes(c)) settings.set('favColors', [...fav, c].slice(-16));
}

const BRUSH_ICONS = { pen: 'pen', fountain: 'fountain', brush: 'brush', pencil: 'pencil', highlighter: 'highlighter' };
const PEN_SIZES = [1.2, 2.2, 3.5, 6];
export const TOOL_BUTTONS = [
  { id: 'eraser', icon: 'eraser', name: 'Borrador', title: 'Borrador (toca otra vez para ajustes)' },
  { id: 'lasso', icon: 'lasso', name: 'Lazo', title: 'Lazo: seleccionar, mover y copiar' },
  { id: 'shape', icon: 'shapes', name: 'Formas', title: 'Formas (toca otra vez para ajustes)' },
  { id: 'image', icon: 'image', name: 'Imagen', title: 'Insertar imagen o foto' },
  { id: 'instruments', icon: 'ruler', name: 'Instrumentos', title: 'Regla, escuadra, cartabón, transportador y compás' }
];
const HL_SIZES = [10, 16, 24, 34];

const MM_PER_PX = 25.4 / 96;
const sizeFactor = t => ((BRUSHES[t] || BRUSHES.pen).sizeMul || 1) * Math.SQRT2; // grosor visible = w × esto
/** Escala del grosor en mm de trazo visible (el subrayador conserva su escala propia, mucho más gruesa). */
function sizeRange(t) {
  if (t === 'highlighter') return null;
  return { min: 0.2, max: t === 'brush' ? 5 : 1.5, step: 0.1 };
}

/**
 * Control de grosor: − deslizador + y el valor. En plumas va en pasos de 0,10 mm (de 0,20 a 1,50 mm;
 * el pincel hasta 5 mm) para que sea fácil acertar la medida. `onChange(w)` recibe el grosor interno.
 */
function sizeControl(t, w, onChange) {
  const r = sizeRange(t);
  const toVal = x => (r ? Math.round((x * sizeFactor(t) * MM_PER_PX) / r.step) * r.step : Math.round(x));
  const toW = v => (r ? v / (sizeFactor(t) * MM_PER_PX) : v);
  const min = r ? r.min : 4;
  const max = r ? r.max : 48;
  const step = r ? r.step : 1;
  const clampV = v => Math.min(max, Math.max(min, Math.round(v / step) * step));
  let v = clampV(toVal(w));
  const slider = h('input.size-slider', { type: 'range', min, max, step, value: v, 'aria-label': 'Grosor' });
  const val = h('span.size-value');
  const show = () => {
    val.textContent = formatLength(toW(v) * sizeFactor(t));
  };
  const apply = nv => {
    v = clampV(nv);
    slider.value = v;
    show();
    onChange(toW(v));
  };
  slider.addEventListener('input', () => apply(parseFloat(slider.value)));
  const btn = (dir, label) => {
    const b = h('button.btn.btn-icon.btn-sm.size-step', { type: 'button', title: dir < 0 ? 'Más fino' : 'Más grueso', 'aria-label': dir < 0 ? 'Más fino' : 'Más grueso' }, iconEl(label));
    b.addEventListener('click', () => apply(v + dir * step));
    return b;
  };
  show();
  return {
    el: h('div.size-row', btn(-1, 'minus'), slider, btn(1, 'plus'), val),
    /** Pone un grosor desde fuera (botones de grosores rápidos). */
    set: nw => apply(toVal(nw))
  };
}

export class Toolbar {
  constructor(editor, root) {
    this.editor = editor;
    this.root = root;
    this.render();
    settings.on('change', ({ key }) => {
      if (key === 'presets' || key === 'activePresetId' || key === 'kit' || key === 'toolbarMode' || key === 'layouts' || key === '*') this.render();
    });
    // Si la barra no cabe en una fila, las herramientas bajan a otra fila (nunca se esconden).
    this.bar = root.closest('.ed-toolbar');
    if (this.bar && globalThis.ResizeObserver) {
      // Fuera del aviso del observador: cambiar la clase redimensiona lo observado.
      this._fitObs = new ResizeObserver(() => {
        clearTimeout(this._fitTimer);
        this._fitTimer = setTimeout(() => this.fit(), 0);
      });
      for (const el of [this.bar, this.bar.querySelector('.ed-right'), this.bar.querySelector('.ed-left')]) if (el) this._fitObs.observe(el);
    }
  }

  /** Decide si la barra va en una fila o con las herramientas en filas propias debajo. */
  fit() {
    const bar = this.bar;
    if (!bar || !bar.clientWidth) return;
    const left = bar.querySelector('.ed-left');
    const right = bar.querySelector('.ed-right');
    const width = el => {
      // Ancho natural: suma de los hijos visibles (no depende de si ahora está partido en filas).
      const cs = getComputedStyle(el);
      const kids = [...el.children].filter(c => !c.hidden && c.offsetParent !== null);
      const gap = parseFloat(cs.columnGap) || 0;
      // El título se recorta con «…»: cuenta como mucho 160 px (igual en una fila que partida).
      return kids.reduce((a, c) => a + (c.classList.contains('ed-title') ? Math.min(160, c.scrollWidth) : c.offsetWidth), 0) + gap * Math.max(0, kids.length - 1) + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    };
    const cs = getComputedStyle(bar);
    const avail = bar.clientWidth - (parseFloat(cs.paddingLeft) || 0) - (parseFloat(cs.paddingRight) || 0);
    const gap = parseFloat(cs.columnGap) || 0;
    const need = (left ? width(left) : 0) + width(this.root) + (right ? width(right) : 0) + gap * 2;
    bar.classList.toggle('stacked', need > avail);
  }

  render() {
    clear(this.root);
    // Orden y elementos elegidos en Ajustes → Personalizar; separador al cambiar de grupo.
    const group = id => (id === 'presets' || KIT_TYPES.includes(id) ? 'write' : id === 'sizes' || id === 'colors' ? id : 'tools');
    let last = null;
    for (const id of layoutItems('toolbar')) {
      const g = group(id);
      if (last && g !== last) this.root.appendChild(h('span.tool-sep'));
      last = g;
      if (id === 'presets') this.renderPresets();
      else if (KIT_TYPES.includes(id)) this.renderKitTool(id);
      else if (id === 'sizes') this.renderKitSizes();
      else if (id === 'colors') this.renderKitColors();
      else this.renderTool(id);
    }
    this.syncDisabled();
    this.fit();
  }

  /** Modo «bolis guardados»: una pluma por botón y el botón de añadir. */
  renderPresets() {
    const ed = this.editor;
    const presets = settings.get('presets');
    const activeId = settings.get('activePresetId');
    for (const p of presets) {
      const b = h('button.tool-btn', { type: 'button', title: `${BRUSHES[p.t]?.name || 'Pluma'} (toca otra vez para ajustes)`, dataset: { preset: p.id } });
      b.innerHTML = icon(BRUSH_ICONS[p.t] || 'pen');
      b.style.setProperty('--ink', p.c); // la punta del icono lleva el color de la tinta
      const bar = h('span.tool-color', { style: { color: p.c } });
      b.appendChild(bar);
      if (ed.tool === 'pen' && p.id === activeId) b.classList.add('active');
      b.addEventListener('click', () => {
        if (ed.tool === 'pen' && settings.get('activePresetId') === p.id) this.openPresetPanel(b, p.id);
        else ed.selectPreset(p.id);
      });
      this.root.appendChild(b);
    }
    const add = h('button.tool-btn.add-tool', { type: 'button', title: 'Añadir pluma' });
    add.innerHTML = icon('plus');
    add.addEventListener('click', () => this.addPreset(add));
    this.root.appendChild(add);
  }

  /** Modo «por herramientas»: botón de una herramienta de escritura (tocarla otra vez: tipo de línea). */
  renderKitTool(t) {
    const ed = this.editor;
    const kit = settings.get('kit');
    const kc = kit[t].colors[kit[t].ci];
    const b = h('button.tool-btn', { type: 'button', title: t === 'highlighter' ? BRUSHES[t].name : `${BRUSHES[t].name} (toca otra vez para el tipo de línea)`, dataset: { kit: t } });
    b.innerHTML = icon(BRUSH_ICONS[t]);
    b.style.setProperty('--ink', kc);
    b.appendChild(h('span.tool-color', { style: { color: kc } }));
    if (ed.tool === 'pen' && t === kit.tool) b.classList.add('active');
    b.addEventListener('click', () => {
      if (ed.tool === 'pen' && settings.get('kit').tool === t) {
        if (t !== 'highlighter') this.openKitLinePanel(b);
      } else ed.selectKitTool(t);
    });
    this.root.appendChild(b);
  }

  /** Los 3 grosores de la herramienta elegida (tocar el elegido permite cambiarlo). */
  renderKitSizes() {
    const ed = this.editor;
    const kit = settings.get('kit');
    const k = kit[kit.tool];
    const isHl = kit.tool === 'highlighter';
    k.sizes.forEach((w, i) => {
      const dot = isHl ? Math.max(3, Math.min(16, w * 0.55)) : Math.max(3, Math.min(20, w * 2.6));
      const b = h('button.tool-btn.kit-size', { type: 'button', title: `Grosor ${i + 1} (toca otra vez para cambiarlo)`, dataset: { kitSize: String(i) } },
        h('i', { style: { width: `${isHl ? dot * 1.8 : dot}px`, height: `${dot}px`, borderRadius: isHl ? '3px' : '99px' } }));
      if (i === k.si) b.classList.add('current');
      b.addEventListener('click', () => {
        if (ed.tool === 'pen' && settings.get('kit')[kit.tool].si === i) this.openKitSizePanel(b, i);
        else ed.selectKitSize(i);
      });
      this.root.appendChild(b);
    });
  }

  /** Los 5 colores de la herramienta elegida (tocar el elegido permite cambiarlo). */
  renderKitColors() {
    const ed = this.editor;
    const kit = settings.get('kit');
    const k = kit[kit.tool];
    k.colors.forEach((c, i) => {
      const b = h('button.tool-btn.kit-color', { type: 'button', title: `Color ${i + 1} (toca otra vez para cambiarlo)`, dataset: { kitColor: String(i) } },
        h('span.kit-swatch', { style: { background: c } }));
      if (i === k.ci) b.classList.add('current');
      b.addEventListener('click', () => {
        if (ed.tool === 'pen' && settings.get('kit')[kit.tool].ci === i) this.openKitColorPanel(b, i);
        else ed.selectKitColor(i);
      });
      this.root.appendChild(b);
    });
  }

  /** Borrador, lazo, formas, imagen o instrumentos (iguales en los dos modos). */
  renderTool(id) {
    const ed = this.editor;
    const t = TOOL_BUTTONS.find(x => x.id === id);
    if (!t) return;
    {
      const b = h('button.tool-btn', { type: 'button', title: t.title, dataset: { tool: t.id } });
      b.innerHTML = icon(t.icon);
      if (ed.tool === t.id) b.classList.add('active');
      if (t.id === 'shape') {
        const cfg = settings.get('shape');
        b.appendChild(h('span.tool-color', { style: { color: cfg.color } }));
      }
      b.addEventListener('click', () => {
        if (t.id === 'image') {
          ed.insertImage();
          return;
        }
        if (t.id === 'instruments') {
          this.openInstrumentsPanel(b);
          return;
        }
        if (ed.tool === t.id) {
          if (t.id === 'eraser') this.openEraserPanel(b);
          else if (t.id === 'shape') this.openShapePanel(b);
        } else {
          ed.setTool(t.id);
        }
      });
      this.root.appendChild(b);
    }
  }

  syncActive() {
    const ed = this.editor;
    const activeId = settings.get('activePresetId');
    this.root.querySelectorAll('.tool-btn').forEach(b => {
      if (b.dataset.kitSize !== undefined || b.dataset.kitColor !== undefined) return; // marcan el hueco elegido, no la herramienta
    let on = b.dataset.preset ? ed.tool === 'pen' && b.dataset.preset === activeId
      : b.dataset.kit ? ed.tool === 'pen' && b.dataset.kit === settings.get('kit').tool
      : b.dataset.tool === ed.tool;
      if (b.dataset.tool === 'instruments') on = ed.tool === 'compass' || ed.instrumentsShown();
      b.classList.toggle('active', !!on);
    });
  }

  // ------------------------------------------------------------------
  // Instrumentos de dibujo técnico
  // ------------------------------------------------------------------

  openInstrumentsPanel(anchor) {
    const ed = this.editor;
    const panel = h('div.tool-panel');
    const grid = h('div.instr-grid');
    const sync = () => {
      grid.querySelectorAll('[data-instr]').forEach(b => {
        const id = b.dataset.instr;
        b.classList.toggle('active', id === 'compass' ? ed.tool === 'compass' : ed.instrumentShown(id));
      });
      this.syncActive();
    };
    const items = [...INSTRUMENTS, { id: 'compass', name: 'Compás', hint: 'Arcos y círculos', icon: 'compass' }];
    for (const it of items) {
      const b = h('button.instr-btn', { type: 'button', dataset: { instr: it.id } }, iconEl(it.icon), h('span.instr-name', it.name), it.hint ? h('span.instr-hint', it.hint) : null);
      b.addEventListener('click', () => {
        if (it.id === 'compass') {
          ed.setTool(ed.tool === 'compass' ? 'pen' : 'compass');
          return; // setTool cierra el panel
        }
        ed.toggleInstrument(it.id);
        sync();
      });
      grid.appendChild(b);
    }
    const clearBtn = h('button.btn.btn-sm.btn-ghost', { type: 'button' }, iconEl('x'), 'Quitar todos');
    clearBtn.addEventListener('click', () => {
      ed.clearInstruments();
      if (ed.tool === 'compass') ed.setTool('pen');
      else sync();
    });
    panel.append(
      h('h3', 'Instrumentos'),
      grid,
      h('div.hint', { style: { margin: '10px 0 6px' } }, 'Muévelos con un dedo y gíralos con dos (se quedan fijos cada 15°). Escribe con el lápiz pegado a un borde para trazar recto (o en arco con el transportador).'),
      h('div.hint', { style: { margin: '0 0 8px' } }, 'Compás: toca para clavar la punta y arrastra para abrirlo; luego gira el lápiz alrededor de la circunferencia. Tocando la punta cambias el radio; lejos, pones otro centro.'),
      clearBtn
    );
    sync();
    openPopover(anchor, panel);
  }

  syncDisabled() {
    const ro = this.editor.isReadOnly();
    this.root.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('disabled', ro));
  }

  // ------------------------------------------------------------------
  // Plumas
  // ------------------------------------------------------------------

  /** Selector de tipo de línea (continuo, guiones, puntos, guion y punto) con una muestra de cada uno. */
  dashSeg(value, onPick) {
    const seg = h('div.segmented.dash-seg');
    for (const d of DASHES) {
      const b = h('button', { type: 'button', title: d.name, 'aria-label': d.name });
      const pat = dashPattern(d.id, 3);
      b.innerHTML = `<svg viewBox="0 0 48 10" width="48" height="10" aria-hidden="true"><path d="M4 5H44" stroke="currentColor" stroke-width="3" stroke-linecap="round"${pat ? ` stroke-dasharray="${pat.join(' ')}"` : ''}/></svg>`;
      if ((value || 'solid') === d.id) b.classList.add('active');
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        onPick(d.id);
      });
      seg.appendChild(b);
    }
    return seg;
  }

  // ------------------------------------------------------------------
  // Modo por herramientas: cambiar un grosor, un color o el tipo de línea
  // ------------------------------------------------------------------

  openKitSizePanel(anchor, i) {
    const ed = this.editor;
    const kit = settings.get('kit');
    const type = kit.tool;
    const cur = kit[type].sizes[i];
    const ctl = sizeControl(type, cur, w => {
      const sizes = settings.get('kit')[type].sizes.slice();
      sizes[i] = w;
      ed.updateKit({ sizes, si: i }, type);
    });
    const panel = h('div.tool-panel',
      h('h3', `${BRUSHES[type].name} · grosor ${i + 1}`),
      h('div.panel-section', ctl.el),
      h('p.panel-hint', 'Se queda guardado para esta herramienta.'));
    openPopover(anchor, panel, { onClose: () => this.render() });
  }

  openKitColorPanel(anchor, i) {
    const ed = this.editor;
    const type = settings.get('kit').tool;
    const setColor = c => {
      const colors = settings.get('kit')[type].colors.slice();
      colors[i] = c;
      ed.updateKit({ colors, ci: i }, type);
    };
    const panel = h('div.tool-panel', h('h3', `${BRUSHES[type].name} · color ${i + 1}`));
    const wrap = h('div');
    const renderColors = () => {
      clear(wrap);
      const now = settings.get('kit')[type].colors[i].toLowerCase();
      const base = type === 'highlighter' ? HIGHLIGHT_COLORS : INK_COLORS;
      const favs = settings.get('favColors');
      const grid = h('div.swatches');
      for (const c of [...base, ...favs.filter(f => !base.includes(f))]) {
        const sw = h('button.swatch', { type: 'button', title: c, style: { background: c } });
        if (c.toLowerCase() === now) sw.classList.add('active');
        sw.addEventListener('click', () => {
          setColor(c);
          closePopover();
        });
        grid.appendChild(sw);
      }
      const addBtn = h('button.swatch.add', { type: 'button', title: 'Color personalizado' }, iconEl('plus'));
      addBtn.addEventListener('click', () => {
        if (wrap.querySelector('.color-picker')) return;
        addBtn.classList.add('active');
        const picker = createColorPicker({
          value: settings.get('kit')[type].colors[i],
          onInput: c => setColor(c),
          onSave: c => {
            rememberColor(c);
            setColor(c);
            closePopover();
          },
          onCancel: () => renderColors()
        });
        wrap.appendChild(picker.el);
      });
      grid.appendChild(addBtn);
      wrap.appendChild(grid);
    };
    renderColors();
    panel.append(h('div.panel-section', wrap), h('p.panel-hint', 'Se queda guardado para esta herramienta.'));
    openPopover(anchor, panel, { onClose: () => this.render() });
  }

  openKitLinePanel(anchor) {
    const ed = this.editor;
    const kit = settings.get('kit');
    const type = kit.tool;
    const panel = h('div.tool-panel',
      h('h3', BRUSHES[type].name),
      h('div.panel-section', h('div.panel-label', 'Línea'), this.dashSeg(kit[type].ds, ds => ed.updateKit({ ds: ds === 'solid' ? undefined : ds }, type))));
    openPopover(anchor, panel, { onClose: () => this.render() });
  }

  addPreset(anchor) {
    const presets = settings.get('presets').slice();
    const cur = presets.find(p => p.id === settings.get('activePresetId')) || presets[0];
    const np = { id: uid('pr'), t: cur && cur.t !== 'highlighter' ? cur.t : 'pen', c: '#2563eb', w: 2.2 };
    presets.push(np);
    settings.set('presets', presets);
    this.editor.selectPreset(np.id);
    const btn = this.root.querySelector(`[data-preset="${np.id}"]`);
    this.openPresetPanel(btn || anchor, np.id);
  }

  updatePreset(id, patch) {
    const presets = settings.get('presets').map(p => (p.id === id ? { ...p, ...patch } : p));
    settings.set('presets', presets);
  }

  openPresetPanel(anchor, id) {
    const getP = () => settings.get('presets').find(p => p.id === id);
    let p = getP();
    if (!p) return;
    const panel = h('div.tool-panel');
    const preview = h('canvas.brush-preview');
    const drawPreview = () => {
      p = getP();
      if (!p) return;
      const dpr = Math.min(devicePixelRatio || 1, 2);
      const w = preview.clientWidth || 290;
      const hh = preview.clientHeight || 54;
      preview.width = Math.round(w * dpr);
      preview.height = Math.round(hh * dpr);
      const ctx = preview.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, hh);
      const pts = [];
      for (let i = 0; i <= 60; i++) {
        const t = i / 60;
        const x = 18 + t * (w - 36);
        const y = hh / 2 + Math.sin(t * Math.PI * 2) * (hh * 0.22);
        pts.push(x, y, 0.25 + 0.6 * Math.sin(t * Math.PI));
      }
      drawLiveStroke(ctx, { t: p.t, c: p.c, w: p.w, pts, np: 0, ds: p.ds });
    };

    // Tipo de pluma
    const typeSeg = h('div.segmented');
    for (const t of ['pen', 'fountain', 'brush', 'pencil', 'highlighter']) {
      const b = h('button', { type: 'button', title: BRUSHES[t].name }, iconEl(BRUSH_ICONS[t]), h('span', BRUSHES[t].name));
      if (p.t === t) b.classList.add('active');
      b.addEventListener('click', () => {
        const wasHl = getP().t === 'highlighter';
        const isHl = t === 'highlighter';
        const patch = { t };
        if (wasHl !== isHl) {
          patch.w = isHl ? 16 : 2.2;
          patch.c = isHl ? '#facc15' : '#0f172a';
        }
        this.updatePreset(id, patch);
        typeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        renderColors();
        renderSizes();
        dashSection.hidden = isHl;
        drawPreview();
      });
      typeSeg.appendChild(b);
    }

    // Colores
    const colorsWrap = h('div');
    const renderColors = () => {
      clear(colorsWrap);
      const cur = getP();
      const base = cur.t === 'highlighter' ? HIGHLIGHT_COLORS : INK_COLORS;
      const favs = settings.get('favColors');
      const grid = h('div.swatches');
      for (const c of [...base, ...favs.filter(f => !base.includes(f))]) {
        const sw = h('button.swatch', { type: 'button', title: c, style: { background: c } });
        if (c.toLowerCase() === cur.c.toLowerCase()) sw.classList.add('active');
        if (favs.includes(c) && !base.includes(c)) {
          const del = h('span.swatch-del', '×');
          del.addEventListener('click', e => {
            e.stopPropagation();
            settings.set('favColors', settings.get('favColors').filter(x => x !== c));
            renderColors();
          });
          sw.appendChild(del);
        }
        sw.addEventListener('click', () => {
          this.updatePreset(id, { c });
          renderColors();
          drawPreview();
        });
        grid.appendChild(sw);
      }
      const addBtn = h('button.swatch.add', { type: 'button', title: 'Color personalizado' }, iconEl('plus'));
      grid.appendChild(addBtn);
      colorsWrap.append(grid);
      if (favs.length) {
        const edit = h('button.btn.btn-ghost.btn-sm', { type: 'button', style: { marginTop: '8px' } }, 'Editar colores');
        edit.addEventListener('click', () => grid.classList.toggle('editing'));
        colorsWrap.append(edit);
      }
      addBtn.addEventListener('click', () => {
        if (colorsWrap.querySelector('.color-picker')) return;
        addBtn.classList.add('active');
        const picker = createColorPicker({
          value: getP().c,
          // Vista previa en vivo en la pluma (sin rehacer el panel para no cortar el arrastre).
          onInput: c => {
            this.updatePreset(id, { c });
            drawPreview();
          },
          onSave: c => {
            rememberColor(c);
            this.updatePreset(id, { c });
            renderColors();
            drawPreview();
          },
          onCancel: () => renderColors()
        });
        colorsWrap.appendChild(picker.el);
      });
    };

    // Grosor
    const sizeWrap = h('div');
    const renderSizes = () => {
      clear(sizeWrap);
      const cur = getP();
      const isHl = cur.t === 'highlighter';
      const presetsS = isHl ? HL_SIZES : PEN_SIZES;
      const ctl = sizeControl(cur.t, cur.w, w => {
        this.updatePreset(id, { w });
        row.querySelectorAll('.size-preset').forEach(b => b.classList.toggle('active', Math.abs(parseFloat(b.dataset.w) - w) < 0.05));
        drawPreview();
      });
      const row = h('div.size-presets');
      for (const w of presetsS) {
        const dot = Math.max(2, Math.min(26, isHl ? w * 0.7 : w * 2.4));
        const b = h('button.size-preset', { type: 'button', dataset: { w: String(w) } }, h('i', { style: { width: isHl ? `${dot * 1.8}px` : `${dot}px`, height: `${dot}px`, borderRadius: isHl ? '3px' : '99px' } }));
        if (Math.abs(cur.w - w) < 0.05) b.classList.add('active');
        b.addEventListener('click', () => ctl.set(w));
        row.appendChild(b);
      }
      sizeWrap.append(ctl.el, row);
    };

    renderColors();
    renderSizes();

    // Tipo de línea (el subrayador siempre es continuo)
    const dashSection = h('div.panel-section', h('div.panel-label', 'Línea'), this.dashSeg(p.ds, ds => {
      this.updatePreset(id, { ds: ds === 'solid' ? undefined : ds });
      drawPreview();
    }));
    dashSection.hidden = p.t === 'highlighter';

    const presets = settings.get('presets');
    const idx = presets.findIndex(x => x.id === id);
    const moveBtn = dir => {
      const b = h('button.btn.btn-outline', { type: 'button', title: dir < 0 ? 'Mover a la izquierda' : 'Mover a la derecha' }, iconEl(dir < 0 ? 'chevronLeft' : 'chevronRight'));
      b.disabled = dir < 0 ? idx <= 0 : idx >= presets.length - 1;
      b.addEventListener('click', () => {
        const list = settings.get('presets').slice();
        const i = list.findIndex(x => x.id === id);
        const j = i + dir;
        if (i < 0 || j < 0 || j >= list.length) return;
        [list[i], list[j]] = [list[j], list[i]];
        settings.set('presets', list);
        closePopover();
      });
      return b;
    };
    const del = h('button.btn.btn-danger-ghost', { type: 'button' }, iconEl('trash'), 'Quitar');
    del.disabled = presets.length <= 1;
    del.addEventListener('click', () => {
      const list = settings.get('presets').filter(x => x.id !== id);
      if (!list.length) return;
      settings.set('presets', list);
      if (settings.get('activePresetId') === id) this.editor.selectPreset(list[0].id);
      closePopover();
    });

    panel.append(
      h('div.panel-section', preview),
      h('div.panel-section', h('div.panel-label', 'Tipo'), typeSeg),
      h('div.panel-section', h('div.panel-label', 'Color'), colorsWrap),
      h('div.panel-section', h('div.panel-label', 'Grosor'), sizeWrap),
      dashSection,
      h('div.panel-actions', moveBtn(-1), moveBtn(1), del)
    );
    openPopover(anchor, panel, { onClose: () => this.render() });
    requestAnimationFrame(drawPreview);
  }

  // ------------------------------------------------------------------
  // Borrador
  // ------------------------------------------------------------------

  openEraserPanel(anchor) {
    const cfg = settings.get('eraser');
    const panel = h('div.tool-panel');
    const seg = h('div.segmented');
    for (const [mode, label] of [['stroke', 'Trazo completo'], ['precision', 'Precisión']]) {
      const b = h('button', { type: 'button' }, label);
      if (cfg.mode === mode) b.classList.add('active');
      b.addEventListener('click', () => {
        settings.update('eraser', { mode });
        seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      });
      seg.appendChild(b);
    }
    const slider = h('input', { type: 'range', min: 6, max: 90, step: 1, value: cfg.size });
    const val = h('span.size-value', formatLength(cfg.size));
    slider.addEventListener('input', () => {
      val.textContent = formatLength(parseInt(slider.value, 10));
      settings.update('eraser', { size: parseInt(slider.value, 10) });
    });
    const clearBtn = h('button.btn.btn-danger-ghost.btn-block', { type: 'button' }, iconEl('trash'), 'Borrar todo en esta página');
    clearBtn.addEventListener('click', () => {
      closePopover();
      this.editor.clearCurrentPage();
    });
    panel.append(
      h('h3', 'Borrador'),
      h('div.panel-section', h('div.panel-label', 'Modo'), seg, h('div.hint', { style: { marginTop: '6px' } }, 'Precisión corta solo la parte que tocas; trazo completo elimina el trazo entero.')),
      h('div.panel-section', h('div.panel-label', 'Tamaño'), h('div.size-row', slider, val)),
      h('div.panel-actions', clearBtn)
    );
    openPopover(anchor, panel);
  }

  // ------------------------------------------------------------------
  // Formas
  // ------------------------------------------------------------------

  openShapePanel(anchor) {
    const panel = h('div.tool-panel');
    const cfg = () => settings.get('shape');
    const typeSeg = h('div.segmented');
    for (const s of SHAPES) {
      const b = h('button', { type: 'button', title: s.name }, iconEl(s.icon));
      if (cfg().type === s.id) b.classList.add('active');
      b.addEventListener('click', () => {
        settings.update('shape', { type: s.id });
        typeSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      });
      typeSeg.appendChild(b);
    }
    const fillSeg = h('div.segmented');
    for (const [f, label] of [['none', 'Sin relleno'], ['semi', 'Translúcido'], ['solid', 'Sólido']]) {
      const b = h('button', { type: 'button' }, label);
      if (cfg().fill === f) b.classList.add('active');
      b.addEventListener('click', () => {
        settings.update('shape', { fill: f });
        fillSeg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      });
      fillSeg.appendChild(b);
    }
    const grid = h('div.swatches');
    const renderColors = () => {
      clear(grid);
      for (const c of [...INK_COLORS, ...settings.get('favColors')]) {
        const sw = h('button.swatch', { type: 'button', style: { background: c } });
        if (c === cfg().color) sw.classList.add('active');
        sw.addEventListener('click', () => {
          settings.update('shape', { color: c });
          renderColors();
          this.render();
        });
        grid.appendChild(sw);
      }
      const addBtn = h('button.swatch.add', { type: 'button', title: 'Color personalizado' }, iconEl('plus'));
      addBtn.addEventListener('click', () => {
        if (grid.nextElementSibling && grid.nextElementSibling.classList.contains('color-picker')) return;
        addBtn.classList.add('active');
        const picker = createColorPicker({
          value: cfg().color,
          onInput: c => settings.update('shape', { color: c }),
          onSave: c => {
            rememberColor(c);
            settings.update('shape', { color: c });
            picker.el.remove();
            renderColors();
            this.render();
          },
          onCancel: () => {
            picker.el.remove();
            renderColors();
          }
        });
        grid.after(picker.el);
      });
      grid.appendChild(addBtn);
    };
    renderColors();
    const slider = h('input', { type: 'range', min: 0.5, max: 14, step: 0.5, value: cfg().w });
    const val = h('span.size-value', formatLength(cfg().w));
    slider.addEventListener('input', () => {
      val.textContent = formatLength(parseFloat(slider.value));
      settings.update('shape', { w: parseFloat(slider.value) });
    });
    panel.append(
      h('h3', 'Formas'),
      h('div.panel-section', h('div.panel-label', 'Forma'), typeSeg),
      h('div.panel-section', h('div.panel-label', 'Relleno'), fillSeg),
      h('div.panel-section', h('div.panel-label', 'Color'), grid),
      h('div.panel-section', h('div.panel-label', 'Grosor de línea'), h('div.size-row', slider, val)),
      h('div.panel-section', h('div.panel-label', 'Línea'), this.dashSeg(cfg().ds, ds => settings.update('shape', { ds })))
    );
    openPopover(anchor, panel);
  }
}
