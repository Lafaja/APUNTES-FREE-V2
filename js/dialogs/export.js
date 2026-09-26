// Diálogo de exportación: PDF (vectorial) o imágenes PNG, con rango de páginas.

import { h, iconEl, clear } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { sanitizeFileName, formatBytes } from '../core/util.js';
import { saveBlob, shareBlob, canShareFiles } from '../export/save.js';
import { renderPageImage, canvasToBlob } from '../render/thumbs.js';
import { ZipWriter, blobSink } from '../core/zip.js';

/** Interpreta "1-3, 5, 8-" → índices base 0 válidos y ordenados. */
export function parseRange(text, total) {
  const out = new Set();
  for (const part of String(text || '').split(/[,;\s]+/)) {
    if (!part) continue;
    const m = /^(\d*)\s*-\s*(\d*)$/.exec(part);
    if (m) {
      const a = m[1] ? parseInt(m[1], 10) : 1;
      const b = m[2] ? parseInt(m[2], 10) : total;
      for (let i = Math.max(1, Math.min(a, b)); i <= Math.min(total, Math.max(a, b)); i++) out.add(i - 1);
    } else if (/^\d+$/.test(part)) {
      const n = parseInt(part, 10);
      if (n >= 1 && n <= total) out.add(n - 1);
    }
  }
  return [...out].sort((x, y) => x - y);
}

export function openExportDialog(session, currentPage = 0) {
  const total = session.node.pages.length;
  const state = { format: 'pdf', range: 'all', custom: '', withBackground: true, scale: 2 };
  const baseName = sanitizeFileName(session.node.name, 'documento');

  const seg = (options, key, onChange) => {
    const s = h('div.segmented');
    for (const o of options) {
      const b = h('button', { type: 'button' }, o.icon ? iconEl(o.icon) : null, o.label);
      if (state[key] === o.id) b.classList.add('active');
      b.addEventListener('click', () => {
        state[key] = o.id;
        s.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
        if (onChange) onChange();
      });
      s.appendChild(b);
    }
    return s;
  };

  const customInput = h('input.text-input', { type: 'text', placeholder: `Ej.: 1-3, 5 (de ${total})`, inputmode: 'numeric', autocomplete: 'off' });
  customInput.addEventListener('input', () => { state.custom = customInput.value; });
  const customWrap = h('div.field', { style: { marginTop: '8px' } }, customInput);
  customWrap.hidden = true;
  const bgCheck = h('input', { type: 'checkbox', checked: true });
  bgCheck.addEventListener('change', () => { state.withBackground = bgCheck.checked; });
  const scaleWrap = h('div.field');
  const renderScale = () => {
    clear(scaleWrap);
    if (state.format !== 'png') return;
    scaleWrap.append(h('span', 'Resolución'), seg([{ id: 1, label: 'Normal' }, { id: 2, label: 'Alta' }, { id: 3, label: 'Máxima' }], 'scale'));
  };
  renderScale();

  const status = h('div.hint', { style: { marginTop: '6px' } });
  const progress = h('div.progress', h('i'));
  progress.hidden = true;
  const resultBox = h('div');

  const body = h('div',
    h('div.field', h('span', 'Formato'), seg([{ id: 'pdf', label: 'PDF', icon: 'fileText' }, { id: 'png', label: 'Imagen PNG', icon: 'image' }], 'format', renderScale)),
    h('div.field', h('span', 'Páginas'), seg([
      { id: 'all', label: `Todas (${total})` },
      { id: 'current', label: `Actual (${currentPage + 1})` },
      { id: 'custom', label: 'Elegir…' }
    ], 'range', () => {
      customWrap.hidden = state.range !== 'custom';
      if (state.range === 'custom') setTimeout(() => customInput.focus(), 30);
    }), customWrap),
    h('label.settings-row', { style: { borderTop: '0', padding: '4px 0 10px' } }, h('div.row-text', h('div.row-title', 'Incluir fondo del papel'), h('div.row-sub', 'Cuadrícula, líneas o puntos y color de la hoja')), h('span.switch', bgCheck, h('span'))),
    scaleWrap,
    progress,
    status,
    resultBox
  );

  let busy = false;
  let result = null;
  const m = openModal({
    title: 'Exportar',
    body,
    wide: false,
    buttons: [
      { label: 'Cancelar', value: null, variant: 'btn-ghost' },
      { label: 'Generar', variant: 'btn-primary', icon: 'download', id: 'go', onClick: async btn => {
        if (busy) return false;
        await generate(btn);
        return false;
      } }
    ]
  });

  async function generate(btn) {
    const indices = state.range === 'all' ? [...Array(total).keys()] : state.range === 'current' ? [currentPage] : parseRange(state.custom, total);
    if (!indices.length) {
      status.textContent = 'Indica un rango de páginas válido (por ejemplo 1-3, 5).';
      return;
    }
    busy = true;
    btn.disabled = true;
    progress.hidden = false;
    const bar = progress.firstChild;
    bar.style.width = '0%';
    clear(resultBox);
    try {
      if (state.format === 'pdf') {
        status.textContent = 'Generando PDF…';
        const { exportPdf } = await import('../export/pdf-export.js');
        const blob = await exportPdf(session, indices, {
          withBackground: state.withBackground,
          onProgress: (d, t) => {
            bar.style.width = `${Math.round((d / t) * 100)}%`;
            status.textContent = `Generando PDF… página ${d} de ${t}`;
          }
        });
        const suffix = indices.length === total ? '' : indices.length === 1 ? ` - pág ${indices[0] + 1}` : ' - selección';
        result = { blob, name: `${baseName}${suffix}.pdf`, type: 'application/pdf' };
      } else {
        status.textContent = 'Generando imágenes…';
        const images = [];
        let d = 0;
        for (const i of indices) {
          const page = await session.getPage(session.node.pages[i].id);
          const canvas = await renderPageImage(page, page.w * state.scale, { withBackground: state.withBackground });
          images.push({ blob: await canvasToBlob(canvas, 'image/png'), name: `${baseName} - pág ${i + 1}.png` });
          canvas.width = canvas.height = 0;
          d++;
          bar.style.width = `${Math.round((d / indices.length) * 100)}%`;
          status.textContent = `Generando imágenes… ${d} de ${indices.length}`;
        }
        if (images.length === 1) result = { blob: images[0].blob, name: images[0].name, type: 'image/png' };
        else {
          const sink = blobSink();
          const zw = new ZipWriter(sink);
          for (const im of images) await zw.add(im.name, new Uint8Array(await im.blob.arrayBuffer()), { compress: false });
          await zw.finish();
          result = { blob: sink.toBlob(), name: `${baseName} - imágenes.zip`, type: 'application/zip' };
        }
      }
      bar.style.width = '100%';
      status.textContent = '';
      showResult();
    } catch (err) {
      console.error(err);
      status.textContent = `No se pudo exportar: ${err.message || err}`;
    } finally {
      busy = false;
      btn.disabled = false;
    }
  }

  function showResult() {
    clear(resultBox);
    const save = h('button.btn.btn-primary', { type: 'button' }, iconEl('download'), 'Guardar');
    save.addEventListener('click', async () => {
      const r = await saveBlob(result.blob, result.name, { description: result.type === 'application/pdf' ? 'Documento PDF' : 'Archivo' });
      if (r !== 'cancelled') {
        toast(r === 'saved' ? 'Archivo guardado' : 'Descarga iniciada', { type: 'success' });
        m.close(true);
      }
    });
    const row = h('div.btn-row', { style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap' } });
    row.appendChild(save);
    if (canShareFiles()) {
      const share = h('button.btn.btn-outline', { type: 'button' }, iconEl('share'), 'Compartir…');
      share.addEventListener('click', async () => {
        try {
          await shareBlob(result.blob, result.name, session.node.name);
          m.close(true);
        } catch (err) {
          if (err && err.name !== 'AbortError') toast(`No se pudo compartir: ${err.message}`, { type: 'error' });
        }
      });
      row.appendChild(share);
    }
    resultBox.append(h('div.banner.info', { style: { margin: '10px 0 0' } }, iconEl('check'), h('div.banner-text', h('strong', result.name), formatBytes(result.blob.size))), row);
  }

  return m.promise;
}
