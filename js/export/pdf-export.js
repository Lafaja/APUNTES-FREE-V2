// Exportación a PDF con pdf-lib: páginas PDF originales incrustadas como vectores (texto seleccionable)
// y la tinta como trazados vectoriales. Si un PDF original no se puede incrustar (p. ej. cifrado),
// esa página se rasteriza a alta resolución para no fallar nunca.

import { PDFDocument, rgb, BlendMode, LineCapStyle, LineJoinStyle, degrees } from '../../libs/pdf-lib/pdf-lib.esm.min.js';
import * as repo from '../core/repo.js';
import { strokeSpec } from '../render/ink.js';
import { normalizeBg, templatePrimitives, templateInk, isDarkColor, hexToRgb, PT_PER_PX } from '../model/paper.js';
import { renderPdfPage } from '../render/pdf.js';
import { canvasToBlob } from '../render/thumbs.js';

const K = PT_PER_PX;

function color(hex) {
  const { r, g, b } = hexToRgb(hex);
  return rgb(r / 255, g / 255, b / 255);
}

/**
 * Genera un PDF de las páginas indicadas (índices base 0) de una sesión.
 * Devuelve un Blob.
 */
export async function exportPdf(session, pageIndices, { withBackground = true, onProgress = null, signal = null } = {}) {
  const out = await PDFDocument.create();
  out.setTitle(session.node.name);
  out.setCreator('Tablet Studio');
  out.setProducer('Tablet Studio (pdf-lib)');
  const srcCache = new Map(); // blobId -> PDFDocument | Error
  const imgCache = new Map(); // blobId -> PDFImage

  const loadSrc = async blobId => {
    if (srcCache.has(blobId)) return srcCache.get(blobId);
    let v;
    try {
      const b = await repo.getBlob(blobId);
      if (!b) throw new Error('PDF original no encontrado');
      v = await PDFDocument.load(b.data, { ignoreEncryption: false, updateMetadata: false });
    } catch (err) {
      v = err instanceof Error ? err : new Error(String(err));
    }
    srcCache.set(blobId, v);
    return v;
  };

  const loadImg = async blobId => {
    if (imgCache.has(blobId)) return imgCache.get(blobId);
    const b = await repo.getBlob(blobId);
    if (!b) throw new Error('Imagen no encontrada');
    let img;
    if (/png/i.test(b.type)) img = await out.embedPng(b.data);
    else if (/jpe?g/i.test(b.type)) img = await out.embedJpg(b.data);
    else {
      // Otros formatos (webp, gif): convertir a PNG vía canvas.
      const bmp = await createImageBitmap(new Blob([b.data], { type: b.type }));
      const c = document.createElement('canvas');
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext('2d').drawImage(bmp, 0, 0);
      const png = await canvasToBlob(c, 'image/png');
      img = await out.embedPng(await png.arrayBuffer());
    }
    imgCache.set(blobId, img);
    return img;
  };

  let done = 0;
  for (const idx of pageIndices) {
    if (signal && signal.aborted) throw new DOMException('Cancelado', 'AbortError');
    const ref = session.node.pages[idx];
    if (!ref) continue;
    const page = await session.getPage(ref.id);
    const W = page.w * K;
    const H = page.h * K;
    const p = out.addPage([W, H]);
    const bg = normalizeBg(page.bg);
    const dark = isDarkColor(bg.color);

    // Fondo del papel
    if (withBackground || dark) {
      p.drawRectangle({ x: 0, y: 0, width: W, height: H, color: color(bg.color) });
    }
    if (withBackground && bg.template !== 'blank') {
      const ink = templateInk(bg.color);
      const prim = templatePrimitives(bg.template, bg.spacing, { x: 0, y: 0, w: page.w, h: page.h });
      for (const [x1, y1, x2, y2, kind] of prim.lines) {
        const c = kind === 'margin' ? ink.marginRgb : ink.lineRgb;
        p.drawLine({
          start: { x: x1 * K, y: H - y1 * K },
          end: { x: x2 * K, y: H - y2 * K },
          thickness: (kind === 'line' ? 0.8 : 1.2) * K,
          color: rgb(c[0], c[1], c[2]),
          opacity: kind === 'margin' ? ink.marginAlpha : kind === 'strong' ? Math.min(1, ink.lineAlpha * 1.6) : ink.lineAlpha
        });
      }
      for (const [x, y] of prim.dots) {
        p.drawCircle({ x: x * K, y: H - y * K, size: 1.3 * K, color: rgb(ink.lineRgb[0], ink.lineRgb[1], ink.lineRgb[2]), opacity: ink.dotAlpha });
      }
    }

    // Página del PDF original
    if (page.pdf && page.pdf.blobId) {
      const r = page.pdf;
      const px = (r.x || 0) * K;
      const pw = r.w * K;
      const ph = r.h * K;
      const py = H - ((r.y || 0) + r.h) * K;
      const src = await loadSrc(r.blobId);
      let embedded = false;
      if (!(src instanceof Error)) {
        try {
          const srcPage = src.getPage(r.index);
          const R = ((((srcPage.getRotation().angle || 0) + (r.rotation || 0)) % 360) + 360) % 360;
          const [emb] = await out.embedPages([srcPage]);
          const w0 = emb.width;
          const h0 = emb.height;
          const s = R % 180 === 0 ? pw / w0 : pw / h0;
          const opts = { width: w0 * s, height: h0 * s, rotate: degrees(-R) };
          if (R === 0) Object.assign(opts, { x: px, y: py });
          else if (R === 90) Object.assign(opts, { x: px, y: py + ph });
          else if (R === 180) Object.assign(opts, { x: px + pw, y: py + ph });
          else Object.assign(opts, { x: px + pw, y: py });
          // Fondo blanco bajo la página PDF (como en pantalla): la cuadrícula del margen no debe verse a través.
          p.drawRectangle({ x: px, y: py, width: pw, height: ph, color: rgb(1, 1, 1) });
          p.drawPage(emb, opts);
          embedded = true;
        } catch (err) {
          console.warn('No se pudo incrustar la página como vector; se rasteriza', err);
        }
      }
      if (!embedded) {
        // Plan B: imagen a ~200 ppp.
        const targetWidth = Math.min(4000, (r.w / 96) * 200);
        const canvas = await renderPdfPage({ blobId: r.blobId, index: r.index, rotation: r.rotation || 0, targetWidth });
        const jpg = await canvasToBlob(canvas, 'image/jpeg', 0.9);
        canvas.width = canvas.height = 0;
        const img = await out.embedJpg(await jpg.arrayBuffer());
        p.drawImage(img, { x: px, y: py, width: pw, height: ph });
      }
    }

    // Imágenes insertadas
    for (const im of page.images || []) {
      try {
        const img = await loadImg(im.blobId);
        const w = im.w * K;
        const hh = im.h * K;
        const cx = (im.x + im.w / 2) * K;
        const cy = H - (im.y + im.h / 2) * K;
        const rot = -(im.rot || 0);
        const rad = (rot * Math.PI) / 180;
        // drawImage rota alrededor de (x, y) = esquina inferior izquierda: se calcula para rotar sobre el centro.
        const x = cx - (w / 2) * Math.cos(rad) + (hh / 2) * Math.sin(rad);
        const y = cy - (w / 2) * Math.sin(rad) - (hh / 2) * Math.cos(rad);
        p.drawImage(img, { x, y, width: w, height: hh, rotate: degrees(rot) });
      } catch (err) {
        console.warn('Imagen omitida en la exportación', err);
      }
    }

    // Tinta: primero subrayadores, después el resto (igual que en pantalla).
    const strokes = page.strokes || [];
    for (let pass = 0; pass < 2; pass++) {
      for (const s of strokes) {
        const isHl = s.t === 'highlighter';
        if ((pass === 0) !== isHl) continue;
        const spec = strokeSpec(s);
        for (const op of spec.ops) {
          const d = op.svg();
          if (!d) continue;
          const common = { x: 0, y: H, scale: K };
          if (isHl && !dark) common.blendMode = BlendMode.Multiply;
          if (op.kind === 'fill') {
            p.drawSvgPath(d, { ...common, color: color(op.color), opacity: Math.min(1, op.alpha * (isHl && !dark ? 1.35 : 1)) });
          } else {
            p.drawSvgPath(d, {
              ...common,
              borderColor: color(op.color),
              borderWidth: op.width,
              borderOpacity: op.alpha,
              borderLineCap: LineCapStyle.Round,
              borderLineJoin: LineJoinStyle ? LineJoinStyle.Round : undefined
            });
          }
        }
      }
    }
    done++;
    if (onProgress) onProgress(done, pageIndices.length);
    // Ceder el hilo de vez en cuando para mantener la interfaz fluida.
    if (done % 3 === 0) await new Promise(r => setTimeout(r, 0));
  }
  const bytes = await out.save({ useObjectStreams: true });
  return new Blob([bytes], { type: 'application/pdf' });
}
