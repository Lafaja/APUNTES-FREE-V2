// Panel de páginas (miniaturas, marcadores e índice del PDF) y diálogo de fondo de página.

import { h, iconEl, clear } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { openMenu } from '../ui/popover.js';
import { renderPageImage } from '../render/thumbs.js';
import { getOutline } from '../render/pdfnav.js';
import { TEMPLATES, PAPER_COLORS, paperSvgDataUri } from '../model/paper.js';
import { formatLength } from '../core/settings.js';
import { createColorPicker } from '../ui/colorpicker.js';

export function openPagesPanel(editor, pane, { tab = 'pages' } = {}) {
  const session = pane.session;
  const viewer = pane.viewer;
  const ro = session.readOnly;
  const blobId = session.node.pdf && session.node.pdf.blobId ? session.node.pdf.blobId : null;
  const content = h('div.panel-content');
  let modal = null;
  let current = tab === 'toc' && !blobId ? 'pages' : tab;
  let tocToken = 0;
  const io = new IntersectionObserver(entries => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      drawThumb(en.target);
    }
  }, { rootMargin: '200px' });

  async function drawThumb(card) {
    const id = card.dataset.pageId;
    const box = card.querySelector('.pt-box');
    try {
      const page = await session.getPage(id);
      const c = await renderPageImage(page, 150 * Math.min(2, devicePixelRatio || 1));
      c.style.width = '100%';
      c.style.height = 'auto';
      c.style.display = 'block';
      if (box.isConnected) box.replaceWith(c);
    } catch (err) {
      box.textContent = '⚠';
    }
  }

  // ---------------- Pestañas ----------------

  const tabs = h('div.segmented.panel-tabs', { role: 'tablist' });
  const tabButtons = {};
  const addTab = (id, label) => {
    const b = h('button', { type: 'button', role: 'tab', dataset: { tab: id } }, label);
    b.addEventListener('click', () => setTab(id));
    tabButtons[id] = b;
    tabs.appendChild(b);
  };
  addTab('pages', 'Páginas');
  addTab('bookmarks', 'Marcadores');
  if (blobId) addTab('toc', 'Índice del PDF');

  function updateTabs() {
    const n = session.bookmarkedPageIds().length;
    tabButtons.bookmarks.textContent = n ? `Marcadores (${n})` : 'Marcadores';
    for (const [id, b] of Object.entries(tabButtons)) {
      b.classList.toggle('active', id === current);
      b.setAttribute('aria-selected', id === current ? 'true' : 'false');
    }
    addEnd.hidden = current !== 'pages';
  }

  function setTab(id) {
    if (id === current) return;
    current = id;
    render();
  }

  function render() {
    updateTabs();
    io.disconnect();
    tocToken++;
    clear(content);
    if (current === 'pages') renderGrid(session.node.pages.map((_, i) => i));
    else if (current === 'bookmarks') renderBookmarks();
    else renderToc();
  }

  // ---------------- Miniaturas (todas o solo las marcadas) ----------------

  function renderGrid(indices) {
    const grid = h('div.pages-grid');
    const refs = session.node.pages;
    for (const i of indices) {
      const ref = refs[i];
      if (!ref) continue;
      const ratio = ref.h / ref.w;
      const card = h('div.page-thumb-card', { role: 'button', tabindex: '0', dataset: { pageId: ref.id } });
      if (i === viewer.currentPage) card.classList.add('current');
      const box = h('div.pt-box', { style: { width: '100%', aspectRatio: `${ref.w} / ${ref.h}`, maxHeight: `${Math.round(150 * ratio)}px` } });
      const frame = h('div.pt-frame', box);
      if (session.isBookmarked(ref.id)) frame.appendChild(h('span.pt-bookmark', { title: 'Página marcada' }));
      const label = h('span.pt-label', `Página ${i + 1}`);
      card.append(frame, label);
      card.addEventListener('click', () => {
        modal.close(null);
        viewer.scrollToPage(i);
      });
      card.addEventListener('keydown', e => {
        if (e.key === 'Enter') card.click();
      });
      card.addEventListener('contextmenu', e => {
        e.preventDefault();
        pageMenu(card, i);
      });
      const more = h('span.btn.btn-icon.btn-sm', { role: 'button', title: 'Opciones de la página', style: { marginTop: '-4px' } }, iconEl('more'));
      more.addEventListener('click', e => {
        e.stopPropagation();
        pageMenu(more, i);
      });
      card.appendChild(more);
      grid.appendChild(card);
      io.observe(card);
    }
    content.appendChild(grid);
    return grid;
  }

  function renderBookmarks() {
    const ids = session.bookmarkedPageIds();
    if (!ids.length) {
      content.appendChild(h('div.panel-empty',
        iconEl('bookmark'),
        h('strong', 'Aún no hay páginas marcadas'),
        h('p', 'Toca el marcador de la barra superior para marcar la página que estás viendo. Aquí tendrás todas tus páginas importantes a mano.')));
      return;
    }
    renderGrid(ids.map(id => session.pageIndex(id)).filter(i => i >= 0));
  }

  // ---------------- Índice del PDF ----------------

  async function renderToc() {
    const token = tocToken;
    content.appendChild(h('div.text-results-status', h('span.mini-spinner'), 'Leyendo el índice del PDF…'));
    let items;
    let map;
    try {
      items = await getOutline(blobId);
      // Página del documento que muestra cada página del PDF.
      const pages = await session.loadAllPages();
      map = new Map();
      pages.forEach((p, i) => {
        if (p && p.pdf && p.pdf.blobId === blobId && !map.has(p.pdf.index)) map.set(p.pdf.index, i);
      });
    } catch (err) {
      console.warn(err);
      if (token !== tocToken) return;
      clear(content);
      content.appendChild(h('div.panel-empty', iconEl('alert'), h('strong', 'No se pudo leer el índice'), h('p', String(err && err.message || err))));
      return;
    }
    if (token !== tocToken) return;
    clear(content);
    if (!items.length) {
      content.appendChild(h('div.panel-empty',
        iconEl('toc'),
        h('strong', 'Este PDF no trae índice'),
        h('p', 'Algunos PDF incluyen un índice de capítulos; este no. Puedes usar los marcadores para señalar tus páginas importantes.')));
      return;
    }
    const list = h('div.toc-list', { role: 'tree' });
    const rows = [];
    const addItems = (arr, container, depth) => {
      for (const it of arr) {
        const docIndex = it.dest ? map.get(it.dest.pageIndex) : undefined;
        const hasKids = it.items.length > 0;
        const row = h('div.toc-row', { style: { paddingLeft: `${4 + depth * 18}px` } });
        const toggle = hasKids
          ? h('button.toc-toggle', { type: 'button', 'aria-label': 'Desplegar' }, iconEl('chevronRight'))
          : h('span.toc-toggle-spacer');
        const usable = docIndex !== undefined || !!it.url;
        const item = h(`button.toc-item${it.bold ? '.bold' : ''}${it.italic ? '.italic' : ''}`, { type: 'button', role: 'treeitem', disabled: !usable },
          h('span.toc-title', it.title),
          h('span.toc-page', docIndex !== undefined ? String(docIndex + 1) : it.url ? '↗' : ''));
        item.addEventListener('click', () => {
          modal.close(null);
          if (docIndex !== undefined) editor.goToPdfDest(pane, blobId, it.dest, { docIndex });
          else if (it.url) editor.openExternalUrl(it.url);
        });
        row.append(toggle, item);
        container.appendChild(row);
        rows.push({ row, docIndex, container });
        if (hasKids) {
          const kids = h('div.toc-children', { role: 'group' });
          const open = depth === 0 && arr.length <= 30;
          kids.hidden = !open;
          toggle.classList.toggle('open', open);
          toggle.addEventListener('click', () => {
            kids.hidden = !kids.hidden;
            toggle.classList.toggle('open', !kids.hidden);
          });
          container.appendChild(kids);
          addItems(it.items, kids, depth + 1);
        }
      }
    };
    addItems(items, list, 0);
    content.appendChild(list);
    // Resaltar la sección en la que se está (la última que empieza en la página actual o antes).
    let here = null;
    for (const r of rows) if (r.docIndex !== undefined && r.docIndex <= viewer.currentPage && (!here || r.docIndex >= here.docIndex)) here = r;
    if (here) {
      here.row.classList.add('current');
      for (let el = here.container; el && el !== list; el = el.parentElement) {
        if (el.classList.contains('toc-children') && el.hidden) {
          el.hidden = false;
          const t = el.previousElementSibling && el.previousElementSibling.querySelector('.toc-toggle');
          if (t) t.classList.add('open');
        }
      }
      setTimeout(() => here.row.scrollIntoView({ block: 'center' }), 60);
    }
  }

  // ---------------- Acciones de página ----------------

  function pageMenu(anchor, i) {
    const refs = session.node.pages;
    const marked = session.isBookmarked(refs[i].id);
    openMenu(anchor, [
      { label: 'Ir a esta página', icon: 'chevronRight', onClick: () => { modal.close(null); viewer.scrollToPage(i); } },
      { label: marked ? 'Quitar marcador' : 'Marcar página', icon: 'bookmark', disabled: ro, onClick: () => { session.toggleBookmark(refs[i].id); render(); } },
      'sep',
      { label: 'Insertar página antes', icon: 'filePlus', disabled: ro, onClick: () => insert(i, true) },
      { label: 'Insertar página después', icon: 'filePlus', disabled: ro, onClick: () => insert(i, false) },
      { label: 'Duplicar', icon: 'copy', disabled: ro, onClick: async () => { await session.duplicatePage(refs[i].id); render(); } },
      { label: 'Mover hacia arriba', icon: 'chevronUp', disabled: ro || i === 0, onClick: () => { session.movePage(i, i - 1); render(); } },
      { label: 'Mover hacia abajo', icon: 'chevronDown', disabled: ro || i === refs.length - 1, onClick: () => { session.movePage(i, i + 1); render(); } },
      { label: 'Fondo de página…', icon: 'grid', disabled: ro, onClick: () => { modal.close(null); openPageBackgroundDialog(editor, pane, i); } },
      'sep',
      { label: 'Borrar página', icon: 'trash', danger: true, disabled: ro || refs.length <= 1, onClick: async () => { await editor.deletePage(pane, i); render(); } }
    ]);
  }

  async function insert(i, before) {
    const tpl = await editor.newPageLike(session, i);
    session.insertPage(before ? i : i + 1, tpl);
    render();
  }

  const addEnd = h('button.btn.btn-outline.btn-sm', { type: 'button', disabled: ro }, iconEl('plus'), 'Añadir al final');
  addEnd.addEventListener('click', async () => {
    const tpl = await editor.newPageLike(session, session.node.pages.length - 1);
    session.insertPage(session.node.pages.length, tpl);
    render();
    const grid = content.querySelector('.pages-grid');
    if (grid && grid.lastElementChild) grid.lastElementChild.scrollIntoView({ block: 'nearest' });
  });

  render();
  modal = openModal({ title: `Páginas (${session.node.pages.length})`, body: h('div', tabs, content), xwide: true, headerExtra: addEnd, buttons: [] });
  modal.promise.then(() => {
    io.disconnect();
    tocToken++;
  });
  // Llevar a la vista la página actual.
  setTimeout(() => {
    const cur = content.querySelector('.page-thumb-card.current');
    if (cur) cur.scrollIntoView({ block: 'center' });
  }, 60);
  return modal.promise;
}

export function openPageBackgroundDialog(editor, pane, index = pane.viewer.currentPage) {
  const session = pane.session;
  const ref = session.node.pages[index];
  const page = session.getPageSync(ref.id);
  if (!page) return null;
  const state = { template: page.bg.template, color: page.bg.color, spacing: page.bg.spacing, scope: 'page' };
  const tplGrid = h('div.choice-grid');
  const renderTemplates = () => {
    clear(tplGrid);
    const k = 58 / page.w;
    for (const t of TEMPLATES) {
      const b = h('button.choice', { type: 'button' });
      const pv = h('div.tpl-preview', { style: { height: `${Math.round(page.h * k)}px`, backgroundColor: state.color, backgroundImage: t.id === 'blank' ? 'none' : paperSvgDataUri({ template: t.id, color: state.color, spacing: Math.max(5, state.spacing * k * 1.6) }, page.w * k, page.h * k) } });
      b.append(pv, h('span', t.name));
      if (t.id === state.template) b.classList.add('active');
      b.addEventListener('click', () => {
        state.template = t.id;
        renderTemplates();
      });
      tplGrid.appendChild(b);
    }
  };
  renderTemplates();
  const colors = h('div.color-choices');
  const allColors = PAPER_COLORS.map(c => c.id);
  if (!allColors.includes(state.color)) allColors.push(state.color);
  for (const c of allColors) {
    const b = h('button.color-choice', { type: 'button', style: { background: c } });
    if (c === state.color) b.classList.add('active');
    b.addEventListener('click', () => {
      state.color = c;
      colors.querySelectorAll('.color-choice').forEach(x => x.classList.toggle('active', x === b));
      renderTemplates();
    });
    colors.appendChild(b);
  }
  const custom = h('button.color-choice.add', { type: 'button', title: 'Otro color' }, iconEl('plus'));
  const pickerSlot = h('div');
  custom.addEventListener('click', () => {
    if (pickerSlot.firstChild) return;
    const before = state.color;
    const picker = createColorPicker({
      value: state.color,
      saveLabel: 'Usar este color',
      onInput: c => {
        state.color = c;
        colors.querySelectorAll('.color-choice').forEach(x => x.classList.remove('active'));
        renderTemplates();
      },
      onSave: c => {
        state.color = c;
        pickerSlot.replaceChildren();
        renderTemplates();
      },
      onCancel: () => {
        state.color = before;
        pickerSlot.replaceChildren();
        renderTemplates();
      }
    });
    pickerSlot.appendChild(picker.el);
  });
  colors.appendChild(custom);
  const slider = h('input', { type: 'range', min: 16, max: 60, step: 1, value: state.spacing });
  const val = h('span.size-value', formatLength(state.spacing));
  slider.addEventListener('input', () => {
    state.spacing = parseInt(slider.value, 10);
    val.textContent = formatLength(state.spacing);
  });
  slider.addEventListener('change', renderTemplates);
  const scope = h('div.segmented');
  for (const [id, label] of [['page', `Solo página ${index + 1}`], ['all', 'Todas las páginas']]) {
    const b = h('button', { type: 'button' }, label);
    if (state.scope === id) b.classList.add('active');
    b.addEventListener('click', () => {
      state.scope = id;
      scope.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
    });
    scope.appendChild(b);
  }
  const body = h('div',
    page.pdf ? h('p', 'En las páginas de un PDF el fondo se ve en los márgenes añadidos para tomar notas.') : null,
    h('div.field', h('span', 'Plantilla'), tplGrid),
    h('div.field', h('span', 'Color'), colors, pickerSlot),
    h('div.field', h('span', 'Separación'), h('div.size-row', slider, val)),
    h('div.field', h('span', 'Aplicar a'), scope)
  );
  const m = openModal({
    title: 'Fondo de página',
    body,
    wide: true,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: 'Aplicar', variant: 'btn-primary', value: true, onClick: async () => {
        const bg = { template: state.template, color: state.color, spacing: state.spacing };
        if (state.scope === 'all') await session.setAllPagesBg(bg);
        else session.setPageBg(ref.id, bg);
      } }
    ]
  });
  return m.promise;
}
