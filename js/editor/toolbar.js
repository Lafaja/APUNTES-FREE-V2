// Barra de herramientas del editor y paneles de ajustes de cada herramienta.

import { settings, INK_COLORS, HIGHLIGHT_COLORS, formatLength } from '../core/settings.js';
import { uid } from '../core/util.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openPopover, closePopover } from '../ui/popover.js';
import { BRUSHES, drawLiveStroke } from '../render/ink.js';
import { SHAPES } from './tools.js';
import { createColorPicker } from '../ui/colorpicker.js';

/** Guarda un color en "mis colores" (máximo 16, sin repetir los de serie). */
function rememberColor(c) {
  const fav = settings.get('favColors');
  if (!fav.includes(c) && !INK_COLORS.includes(c) && !HIGHLIGHT_COLORS.includes(c)) settings.set('favColors', [...fav, c].slice(-16));
}

const BRUSH_ICONS = { pen: 'pen', fountain: 'fountain', brush: 'brush', pencil: 'pencil', highlighter: 'highlighter' };
const PEN_SIZES = [1.2, 2.2, 3.5, 6];
const HL_SIZES = [10, 16, 24, 34];

export class Toolbar {
  constructor(editor, root) {
    this.editor = editor;
    this.root = root;
    this.render();
    settings.on('change', ({ key }) => {
      if (key === 'presets' || key === 'activePresetId' || key === '*') this.render();
    });
  }

  render() {
    const ed = this.editor;
    clear(this.root);
    const presets = settings.get('presets');
    const activeId = settings.get('activePresetId');
    for (const p of presets) {
      const b = h('button.tool-btn', { type: 'button', title: `${BRUSHES[p.t]?.name || 'Pluma'} (toca otra vez para ajustes)`, dataset: { preset: p.id } });
      b.innerHTML = icon(BRUSH_ICONS[p.t] || 'pen');
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
    this.root.appendChild(h('span.tool-sep'));

    const tools = [
      { id: 'eraser', icon: 'eraser', title: 'Borrador (toca otra vez para ajustes)' },
      { id: 'lasso', icon: 'lasso', title: 'Lazo: seleccionar, mover y copiar' },
      { id: 'shape', icon: 'shapes', title: 'Formas (toca otra vez para ajustes)' },
      { id: 'image', icon: 'image', title: 'Insertar imagen o foto' }
    ];
    for (const t of tools) {
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
        if (ed.tool === t.id) {
          if (t.id === 'eraser') this.openEraserPanel(b);
          else if (t.id === 'shape') this.openShapePanel(b);
        } else {
          ed.setTool(t.id);
        }
      });
      this.root.appendChild(b);
    }
    this.syncDisabled();
  }

  syncActive() {
    const ed = this.editor;
    const activeId = settings.get('activePresetId');
    this.root.querySelectorAll('.tool-btn').forEach(b => {
      const on = b.dataset.preset ? ed.tool === 'pen' && b.dataset.preset === activeId : b.dataset.tool === ed.tool;
      b.classList.toggle('active', !!on);
    });
  }

  syncDisabled() {
    const ro = this.editor.isReadOnly();
    this.root.querySelectorAll('.tool-btn').forEach(b => b.classList.toggle('disabled', ro));
  }

  // ------------------------------------------------------------------
  // Plumas
  // ------------------------------------------------------------------

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
      drawLiveStroke(ctx, { t: p.t, c: p.c, w: p.w, pts, np: 0 });
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
      const slider = h('input', { type: 'range', min: isHl ? 4 : 0.5, max: isHl ? 48 : 16, step: isHl ? 1 : 0.1, value: cur.w });
      // Grosor real del trazo tal y como se ve (perfect-freehand dibuja ~√2 × tamaño × multiplicador).
      const visual = w => w * ((BRUSHES[getP().t] || BRUSHES.pen).sizeMul || 1) * Math.SQRT2;
      const val = h('span.size-value', formatLength(visual(cur.w)));
      slider.addEventListener('input', () => {
        const w = parseFloat(slider.value);
        val.textContent = formatLength(visual(w));
        this.updatePreset(id, { w });
        row.querySelectorAll('.size-preset').forEach(b => b.classList.toggle('active', Math.abs(parseFloat(b.dataset.w) - w) < 0.05));
        drawPreview();
      });
      const row = h('div.size-presets');
      for (const w of presetsS) {
        const dot = Math.max(2, Math.min(26, isHl ? w * 0.7 : w * 2.4));
        const b = h('button.size-preset', { type: 'button', dataset: { w: String(w) } }, h('i', { style: { width: isHl ? `${dot * 1.8}px` : `${dot}px`, height: `${dot}px`, borderRadius: isHl ? '3px' : '99px' } }));
        if (Math.abs(cur.w - w) < 0.05) b.classList.add('active');
        b.addEventListener('click', () => {
          slider.value = w;
          slider.dispatchEvent(new Event('input'));
        });
        row.appendChild(b);
      }
      sizeWrap.append(h('div.size-row', slider, val), row);
    };

    renderColors();
    renderSizes();

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
      h('div.panel-section', h('div.panel-label', 'Grosor de línea'), h('div.size-row', slider, val))
    );
    openPopover(anchor, panel);
  }
}
