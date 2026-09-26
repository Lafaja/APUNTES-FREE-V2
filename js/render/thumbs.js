// Renderizado de una página completa a imagen (miniaturas, panel de páginas, exportar imagen).

import { drawPaper } from '../model/paper.js';
import { drawStrokes } from './ink.js';
import { renderPdfPage } from './pdf.js';
import { loadImage } from './images.js';
import * as repo from '../core/repo.js';

/**
 * Dibuja una página (registro completo) en un canvas nuevo de `targetWidth` píxeles de ancho.
 * Nunca falla por un PDF o imagen dañados: dibuja lo que pueda.
 */
export async function renderPageImage(page, targetWidth, { withBackground = true, signal = null, maxPixels = 40e6 } = {}) {
  let scale = targetWidth / page.w;
  if (page.w * page.h * scale * scale > maxPixels) scale = Math.sqrt(maxPixels / (page.w * page.h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(page.w * scale));
  canvas.height = Math.max(1, Math.round(page.h * scale));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  const full = { x: 0, y: 0, w: page.w, h: page.h };
  if (withBackground) drawPaper(ctx, page.bg, full);
  else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, page.w, page.h);
  }
  if (page.pdf && page.pdf.blobId) {
    try {
      const pc = await renderPdfPage({
        blobId: page.pdf.blobId,
        index: page.pdf.index,
        rotation: page.pdf.rotation || 0,
        targetWidth: Math.max(1, page.pdf.w * scale),
        signal
      });
      ctx.drawImage(pc, page.pdf.x || 0, page.pdf.y || 0, page.pdf.w, page.pdf.h);
      pc.width = pc.height = 0;
    } catch (err) {
      if (err && err.name === 'AbortError') throw err;
      ctx.fillStyle = '#fee2e2';
      ctx.fillRect(page.pdf.x || 0, page.pdf.y || 0, page.pdf.w, page.pdf.h);
    }
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, page.w, page.h);
  ctx.clip();
  for (const img of page.images || []) {
    try {
      const bmp = await loadImage(img.blobId);
      ctx.save();
      ctx.translate(img.x + img.w / 2, img.y + img.h / 2);
      if (img.rot) ctx.rotate((img.rot * Math.PI) / 180);
      if (img.crop) ctx.drawImage(bmp, img.crop.x, img.crop.y, img.crop.w, img.crop.h, -img.w / 2, -img.h / 2, img.w, img.h);
      else ctx.drawImage(bmp, -img.w / 2, -img.h / 2, img.w, img.h);
      ctx.restore();
    } catch {}
  }
  drawStrokes(ctx, page.strokes || []);
  ctx.restore();
  return canvas;
}

export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.85) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('No se pudo generar la imagen'))), type, quality);
  });
}

/** Genera y guarda la miniatura de la primera página de un documento. */
export async function updateThumbnail(node, firstPage) {
  if (!node || !firstPage) return;
  const canvas = await renderPageImage(firstPage, 300);
  const blob = await canvasToBlob(canvas, 'image/jpeg', 0.82);
  canvas.width = canvas.height = 0;
  const data = await blob.arrayBuffer();
  await repo.putThumb(node.id, data, 'image/jpeg', node.rev || 0);
}
