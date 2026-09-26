// Importar PDF: vista previa, rotación y márgenes laterales para tomar notas.
// El PDF original se guarda intacto (una sola vez); las anotaciones van aparte.

import * as repo from '../core/repo.js';
import { openPdfBytes, pdfPageSizes, closePdf } from '../render/pdf.js';
import { queueIndex } from '../core/textindex.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, alertDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { isPdfBytes, cleanName } from '../core/util.js';
import { normalizeBg, paperSvgDataUri, PAPER_COLORS, TEMPLATES } from '../model/paper.js';

const PX_PER_PT = 4 / 3;

async function readFile(file) {
  const buf = await file.arrayBuffer();
  if (!buf.byteLength) throw new Error('El archivo está vacío.');
  if (!isPdfBytes(new Uint8Array(buf, 0, Math.min(1024, buf.byteLength)))) throw new Error('El archivo no parece un PDF válido.');
  return buf;
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

/** Diálogo de opciones con vista previa. Devuelve la configuración o null. */
function importOptionsDialog(file, doc) {
  const state = {
    name: file.name.replace(/\.pdf$/i, ''),
    rotation: 0,
    margin: 'none', // none | left | right | both
    marginWidth: 280,
    template: 'grid',
    color: '#ffffff',
    spacing: 28,
    page: 1
  };
  const total = doc.numPages;
  const nameInput = h('input.text-input', { type: 'text', value: state.name, autocomplete: 'off' });
  nameInput.addEventListener('input', () => { state.name = nameInput.value; });

  const stage = h('div.pdf-preview-stage');
  const navLabel = h('span', `Página 1 de ${total}`);
  const prev = h('button.btn.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Página anterior' }, iconEl('chevronLeft'));
  const next = h('button.btn.btn-icon.btn-sm', { type: 'button', 'aria-label': 'Página siguiente' }, iconEl('chevronRight'));
  let renderTask = null;
  let token = 0;

  async function renderPreview() {
    const my = ++token;
    prev.disabled = state.page <= 1;
    next.disabled = state.page >= total;
    navLabel.textContent = `Página ${state.page} de ${total}`;
    try {
      if (renderTask) {
        try { renderTask.cancel(); } catch {}
      }
      const page = await doc.getPage(state.page);
      const rot = ((page.rotate || 0) + state.rotation) % 360;
      const base = page.getViewport({ scale: 1, rotation: rot });
      const maxH = 340;
      const maxW = 420;
      const marginPts = state.margin === 'none' ? 0 : state.marginWidth / PX_PER_PT;
      const totalW = base.width + marginPts * (state.margin === 'both' ? 2 : 1);
      const scale = Math.min(maxH / base.height, maxW / totalW);
      const vp = page.getViewport({ scale: scale * Math.min(2, devicePixelRatio || 1), rotation: rot });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = `${Math.round(base.width * scale)}px`;
      canvas.style.height = `${Math.round(base.height * scale)}px`;
      renderTask = page.render({ canvas, viewport: vp, background: '#ffffff' });
      await renderTask.promise;
      if (my !== token) return;
      clear(stage);
      const mw = Math.round(marginPts * scale);
      const mh = Math.round(base.height * scale);
      const margin = () => {
        const el = h('div.pdf-preview-margin', { style: { width: `${mw}px`, height: `${mh}px`, backgroundColor: state.color } });
        if (state.template !== 'blank') el.style.backgroundImage = paperSvgDataUri({ template: state.template, color: state.color, spacing: Math.max(4, (state.spacing / PX_PER_PT) * scale) }, mw, mh);
        return el;
      };
      if (state.margin === 'left' || state.margin === 'both') stage.appendChild(margin());
      stage.appendChild(canvas);
      if (state.margin === 'right' || state.margin === 'both') stage.appendChild(margin());
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return;
      console.warn(err);
    }
  }
  prev.addEventListener('click', () => { if (state.page > 1) { state.page--; renderPreview(); } });
  next.addEventListener('click', () => { if (state.page < total) { state.page++; renderPreview(); } });

  const marginOpts = h('div');
  const renderMarginOpts = () => {
    clear(marginOpts);
    if (state.margin === 'none') return;
    const slider = h('input', { type: 'range', min: 120, max: 600, step: 10, value: state.marginWidth });
    const val = h('span.size-value', `${Math.round(state.marginWidth / 3.78)} mm`);
    slider.addEventListener('input', () => {
      state.marginWidth = parseInt(slider.value, 10);
      val.textContent = `${Math.round(state.marginWidth / 3.78)} mm`;
    });
    slider.addEventListener('change', renderPreview);
    const tpl = segmented(TEMPLATES.filter(t => t.id !== 'cornell').map(t => ({ id: t.id, label: t.name })), state.template, v => {
      state.template = v;
      renderPreview();
    });
    const colors = h('div.color-choices');
    for (const c of PAPER_COLORS) {
      const b = h('button.color-choice', { type: 'button', style: { background: c.id }, title: c.name });
      if (c.id === state.color) b.classList.add('active');
      b.addEventListener('click', () => {
        state.color = c.id;
        colors.querySelectorAll('.color-choice').forEach(x => x.classList.toggle('active', x === b));
        renderPreview();
      });
      colors.appendChild(b);
    }
    marginOpts.append(
      h('div.field', h('span', 'Ancho del margen'), h('div.size-row', slider, val)),
      h('div.field', h('span', 'Fondo del margen'), tpl),
      h('div.field', h('span', 'Color del margen'), colors)
    );
  };
  renderMarginOpts();

  const body = h('div.pdf-import-layout',
    h('div.pdf-preview-box', stage, h('div.pdf-preview-nav', prev, navLabel, next)),
    h('div',
      h('label.field', h('span', 'Nombre'), nameInput),
      h('div.field', h('span', 'Girar páginas'), segmented([
        { id: 0, label: '0°' }, { id: 90, label: '90°' }, { id: 180, label: '180°' }, { id: 270, label: '270°' }
      ], 0, v => {
        state.rotation = v;
        renderPreview();
      })),
      h('div.field', h('span', 'Espacio extra para notas'), segmented([
        { id: 'none', label: 'Ninguno' }, { id: 'left', label: 'Izquierda' }, { id: 'right', label: 'Derecha' }, { id: 'both', label: 'Ambos' }
      ], state.margin, v => {
        state.margin = v;
        renderMarginOpts();
        renderPreview();
      })),
      marginOpts,
      h('p.hint', `${total} página${total === 1 ? '' : 's'}. El PDF original se conserva intacto; tus anotaciones se guardan aparte.`)
    )
  );
  const m = openModal({
    title: 'Importar PDF',
    body,
    xwide: true,
    cancelValue: null,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: 'Importar', value: () => ({ ...state, name: cleanName(state.name, 'Documento PDF') }), variant: 'btn-primary', icon: 'fileUp' }
    ]
  });
  renderPreview();
  return m.promise;
}

/** Flujo completo de importación. Devuelve el id del documento creado o null. */
export async function importPdfFlow(file, parentId, { single = true } = {}) {
  let buf;
  try {
    buf = await readFile(file);
  } catch (err) {
    await alertDialog(`No se pudo leer «${file.name}»: ${err.message}`, 'PDF no válido');
    return null;
  }
  let doc;
  try {
    doc = await openPdfBytes(new Uint8Array(buf.slice(0)));
  } catch (err) {
    const msg = err && err.name === 'PasswordException'
      ? 'Este PDF está protegido con contraseña. Ábrelo con la contraseña y guárdalo sin protección (por ejemplo, «Imprimir → Guardar como PDF») y vuelve a importarlo.'
      : `El PDF parece dañado o no es compatible: ${err.message || err}`;
    await alertDialog(msg, `No se pudo abrir «${file.name}»`);
    return null;
  }
  let cfg;
  try {
    cfg = single
      ? await importOptionsDialog(file, doc)
      : { name: cleanName(file.name.replace(/\.pdf$/i, ''), 'Documento PDF'), rotation: 0, margin: 'none', marginWidth: 280, template: 'grid', color: '#ffffff', spacing: 28 };
    if (!cfg) {
      closePdf(doc);
      return null;
    }
  } catch (err) {
    console.error(err);
    closePdf(doc);
    return null;
  }
  const stop = toast(`Importando «${cfg.name}»…`, { duration: 0 });
  try {
    const sizes = await pdfPageSizes(doc, cfg.rotation);
    const blobId = await repo.putBlob(buf, 'application/pdf');
    const left = cfg.margin === 'left' || cfg.margin === 'both' ? cfg.marginWidth : 0;
    const right = cfg.margin === 'right' || cfg.margin === 'both' ? cfg.marginWidth : 0;
    const bg = normalizeBg({ template: cfg.margin === 'none' ? 'blank' : cfg.template, color: cfg.color, spacing: cfg.spacing });
    const pages = sizes.map((s, i) => {
      const pw = Math.round(s.w * PX_PER_PT * 100) / 100;
      const ph = Math.round(s.h * PX_PER_PT * 100) / 100;
      return {
        w: left + pw + right,
        h: ph,
        bg,
        pdf: { blobId, index: i, rotation: cfg.rotation, x: left, y: 0, w: pw, h: ph }
      };
    });
    const { node } = await repo.createDocument({
      name: cfg.name,
      parentId,
      source: 'pdf',
      pdf: { blobId, fileName: file.name, pageCount: sizes.length },
      paper: { size: 'a4', orientation: 'portrait', template: cfg.margin === 'none' ? 'grid' : cfg.template, color: cfg.color, spacing: cfg.spacing },
      pages,
      autoAddPages: false
    });
    toast(`PDF importado: ${sizes.length} página${sizes.length === 1 ? '' : 's'}`, { type: 'success' });
    queueIndex([blobId]); // para poder buscar en su texto desde la biblioteca
    return node.id;
  } catch (err) {
    console.error(err);
    await alertDialog(`No se pudo importar el PDF: ${err.message || err}`, 'Error');
    return null;
  } finally {
    stop();
    closePdf(doc);
  }
}
