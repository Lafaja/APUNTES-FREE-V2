// Diálogos: nuevo apunte, carpeta, selector de carpeta y selector de documento.

import { PAPER_SIZES, TEMPLATES, PAPER_COLORS, pageSizeFor, paperSvgDataUri } from '../model/paper.js';
import { settings, formatLength } from '../core/settings.js';
import { formatDate } from '../core/util.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { openModal } from '../ui/modal.js';
import { FOLDER_COLORS } from '../library/library.js';

function choiceGroup(options, value, onPick, render) {
  const wrap = h('div.choice-grid');
  const items = [];
  for (const o of options) {
    const b = h('button.choice', { type: 'button' });
    render(b, o);
    if (o.id === value) b.classList.add('active');
    b.addEventListener('click', () => {
      items.forEach(x => x.classList.toggle('active', x === b));
      onPick(o.id);
    });
    items.push(b);
    wrap.appendChild(b);
  }
  return wrap;
}

function segmented(options, value, onPick) {
  const seg = h('div.segmented');
  for (const o of options) {
    const b = h('button', { type: 'button' }, o.icon ? iconEl(o.icon) : null, o.label);
    if (o.id === value) b.classList.add('active');
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      onPick(o.id);
    });
    seg.appendChild(b);
  }
  return seg;
}

/** Diálogo de nuevo apunte. Devuelve { name, paper } o null. */
export function newNoteDialog() {
  const def = { ...settings.get('defaultPaper') };
  const state = { ...def };
  const name = h('input.text-input', { type: 'text', placeholder: 'Nombre del apunte', autocomplete: 'off', enterkeyhint: 'done' });
  const tplWrap = h('div');
  const orientWrap = h('div.field');
  const spacingWrap = h('div.field');

  const renderTemplates = () => {
    clear(tplWrap);
    const size = pageSizeFor(state.size, state.orientation);
    tplWrap.appendChild(choiceGroup(TEMPLATES, state.template, id => {
      state.template = id;
      renderSpacing();
    }, (b, t) => {
      // Vista previa a escala real de la miniatura (si no, las líneas de 1 px desaparecen).
      const pw = size.w > size.h ? 76 : 58;
      const k = pw / size.w;
      const spacing = Math.max(5, state.spacing * k * 1.6);
      const pv = h('div.tpl-preview', { style: { backgroundColor: state.color, backgroundImage: t.id === 'blank' ? 'none' : paperSvgDataUri({ template: t.id, color: state.color, spacing }, size.w * k, size.h * k) } });
      if (size.w > size.h) pv.classList.add('landscape');
      b.append(pv, h('span', t.name));
    }));
  };
  const renderOrient = () => {
    clear(orientWrap);
    if (state.size === 'infinite' || state.size === 'square') return;
    orientWrap.append(h('span', 'Orientación'), segmented([
      { id: 'portrait', label: 'Vertical' },
      { id: 'landscape', label: 'Horizontal' }
    ], state.orientation, v => {
      state.orientation = v;
      renderTemplates();
    }));
  };
  const renderSpacing = () => {
    clear(spacingWrap);
    if (state.template === 'blank') return;
    const slider = h('input', { type: 'range', min: 16, max: 60, step: 1, value: state.spacing });
    const val = h('span.size-value', formatLength(state.spacing));
    slider.addEventListener('input', () => {
      state.spacing = parseInt(slider.value, 10);
      val.textContent = formatLength(state.spacing);
    });
    slider.addEventListener('change', renderTemplates);
    spacingWrap.append(h('span', 'Separación de líneas'), h('div.size-row', slider, val));
  };

  const sizes = Object.entries(PAPER_SIZES).map(([id, p]) => ({ id, ...p }));
  const sizeGroup = choiceGroup(sizes, state.size, id => {
    state.size = id;
    renderOrient();
    renderTemplates();
  }, (b, s) => {
    const r = s.id === 'infinite' ? 1 : s.w / s.h;
    const hh = 40;
    const w = s.id === 'infinite' ? 40 : Math.round(hh * r);
    b.append(h('div', { style: { width: `${w}px`, height: `${hh}px`, border: '1.5px solid currentColor', borderRadius: '3px', opacity: '0.6', borderStyle: s.id === 'infinite' ? 'dashed' : 'solid' } }), h('span', s.name));
  });

  const colors = h('div.color-choices');
  for (const c of PAPER_COLORS) {
    const b = h('button.color-choice', { type: 'button', title: c.name, style: { background: c.id } });
    if (c.id === state.color) b.classList.add('active');
    b.addEventListener('click', () => {
      state.color = c.id;
      colors.querySelectorAll('.color-choice').forEach(x => x.classList.toggle('active', x === b));
      renderTemplates();
    });
    colors.appendChild(b);
  }

  renderOrient();
  renderTemplates();
  renderSpacing();

  const body = h('div',
    h('label.field', h('span', 'Nombre'), name),
    h('div.field', h('span', 'Tamaño'), sizeGroup),
    orientWrap,
    h('div.field', h('span', 'Plantilla'), tplWrap),
    h('div.field', h('span', 'Color del papel'), colors),
    spacingWrap
  );
  const m = openModal({
    title: 'Nuevo apunte',
    body,
    wide: true,
    cancelValue: null,
    enterValue: () => build(),
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: 'Crear apunte', value: () => build(), variant: 'btn-primary' }
    ]
  });
  function build() {
    const paper = { size: state.size, orientation: state.orientation, template: state.template, color: state.color, spacing: state.spacing };
    settings.set('defaultPaper', paper);
    return { name: name.value.trim() || `Apunte ${formatDate(Date.now())}`, paper };
  }
  setTimeout(() => name.focus(), 50);
  return m.promise;
}

/** Diálogo de carpeta (crear o editar). Devuelve { name, color } o null. */
export function folderDialog({ title = 'Nueva carpeta', name = '', color = FOLDER_COLORS[0], confirmLabel = 'Crear carpeta' } = {}) {
  let chosen = color;
  const input = h('input.text-input', { type: 'text', value: name, placeholder: 'Nombre de la carpeta', autocomplete: 'off', enterkeyhint: 'done' });
  const colors = h('div.color-choices');
  for (const c of FOLDER_COLORS) {
    const b = h('button.color-choice', { type: 'button', style: { background: c } });
    if (c === chosen) b.classList.add('active');
    b.addEventListener('click', () => {
      chosen = c;
      colors.querySelectorAll('.color-choice').forEach(x => x.classList.toggle('active', x === b));
    });
    colors.appendChild(b);
  }
  const m = openModal({
    title,
    body: h('div', h('label.field', h('span', 'Nombre'), input), h('div.field', h('span', 'Color'), colors)),
    cancelValue: null,
    enterValue: () => ({ name: input.value, color: chosen }),
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: confirmLabel, value: () => ({ name: input.value, color: chosen }), variant: 'btn-primary' }
    ]
  });
  setTimeout(() => {
    input.focus();
    input.select();
  }, 50);
  return m.promise;
}

/**
 * Selector de carpeta de destino. Devuelve el id (null = raíz) o undefined si se cancela.
 */
export function pickFolderDialog(nodes, { title = 'Mover a…', excludeIds = [], current = null } = {}) {
  const alive = id => {
    let cur = nodes.get(id);
    const seen = new Set();
    while (cur) {
      if (cur.deletedAt || seen.has(cur.id)) return false;
      seen.add(cur.id);
      if (!cur.parentId) return true;
      cur = nodes.get(cur.parentId);
    }
    return false;
  };
  const excluded = new Set(excludeIds);
  // Excluir también las subcarpetas de las carpetas que se mueven.
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of nodes.values()) {
      if (n.kind === 'folder' && n.parentId && excluded.has(n.parentId) && !excluded.has(n.id)) {
        excluded.add(n.id);
        grew = true;
      }
    }
  }
  const folders = [...nodes.values()].filter(n => n.kind === 'folder' && alive(n.id));
  const byParent = new Map();
  for (const f of folders) {
    const k = f.parentId || null;
    if (!byParent.has(k)) byParent.set(k, []);
    byParent.get(k).push(f);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.name.localeCompare(b.name, 'es', { numeric: true }));
  let selected = current;
  const list = h('div.dest-list');
  const rows = [];
  const addRow = (id, label, depth, color) => {
    const b = h('button.dest-row', { type: 'button', style: { paddingLeft: `${12 + depth * 22}px` } });
    b.appendChild(h('span.dest-icon', { style: { color: color || 'var(--text-2)' }, html: icon(id ? 'folder' : 'hardDrive') }));
    b.appendChild(h('span', label));
    if (id !== null && excluded.has(id)) b.disabled = true;
    if (id === selected) b.classList.add('active');
    b.addEventListener('click', () => {
      selected = id;
      rows.forEach(r => r.classList.toggle('active', r === b));
    });
    rows.push(b);
    list.appendChild(b);
  };
  addRow(null, 'Documentos (inicio)', 0);
  const walk = (parent, depth) => {
    for (const f of byParent.get(parent) || []) {
      addRow(f.id, f.name, depth, f.color);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 1);
  const m = openModal({
    title,
    body: list,
    cancelValue: undefined,
    buttons: [
      { label: 'Cancelar', value: undefined, variant: 'btn-ghost' },
      { label: 'Mover aquí', value: () => selected, variant: 'btn-primary' }
    ]
  });
  return m.promise;
}

/** Selector de documento (pantalla dividida). Devuelve el id o null. */
export function pickDocumentDialog(nodes, { title = 'Elegir documento', hint = '', exclude = null } = {}) {
  const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const alive = id => {
    let cur = nodes.get(id);
    const seen = new Set();
    while (cur) {
      if (cur.deletedAt || seen.has(cur.id)) return false;
      seen.add(cur.id);
      if (!cur.parentId) return true;
      cur = nodes.get(cur.parentId);
    }
    return false;
  };
  const docs = [...nodes.values()].filter(n => n.kind === 'doc' && n.id !== exclude && alive(n.id)).sort((a, b) => (b.openedAt || b.updatedAt || 0) - (a.openedAt || a.updatedAt || 0));
  const search = h('input.text-input', { type: 'search', placeholder: 'Buscar documento', autocomplete: 'off' });
  const list = h('div.dest-list');
  let resolveSel = null;
  const render = () => {
    clear(list);
    const q = norm(search.value.trim());
    for (const d of docs) {
      if (q && !norm(d.name).includes(q)) continue;
      const b = h('button.dest-row', { type: 'button' }, h('span.dest-icon', { html: icon(d.source === 'pdf' ? 'fileText' : 'edit') }), h('span', d.name), h('span.muted', { style: { marginLeft: 'auto', fontSize: '12px' } }, formatDate(d.updatedAt)));
      b.addEventListener('click', () => resolveSel && resolveSel(d.id));
      list.appendChild(b);
    }
    if (!list.children.length) list.appendChild(h('p.muted', 'No hay documentos.'));
  };
  search.addEventListener('input', render);
  render();
  const m = openModal({ title, body: h('div', hint ? h('p.hint', hint) : null, h('div.field', search), list), cancelValue: null, buttons: [{ label: 'Cancelar', value: null, variant: 'btn-ghost' }] });
  resolveSel = id => m.close(id);
  return m.promise;
}
