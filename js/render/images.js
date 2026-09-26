// Caché de imágenes decodificadas (ImageBitmap) y preparación de imágenes nuevas.

import * as repo from '../core/repo.js';
import { Emitter } from '../core/events.js';

export const imageEvents = new Emitter();

const cache = new Map(); // blobId -> { bitmap, pixels, lastUsed } | { loading: Promise }
let totalPixels = 0;
const MAX_PIXELS = 60e6; // ~240 MB decodificados como máximo

function evict() {
  if (totalPixels <= MAX_PIXELS) return;
  const entries = [...cache.entries()].filter(([, e]) => e.bitmap).sort((a, b) => a[1].lastUsed - b[1].lastUsed);
  for (const [id, e] of entries) {
    if (totalPixels <= MAX_PIXELS * 0.8) break;
    try { e.bitmap.close && e.bitmap.close(); } catch {}
    totalPixels -= e.pixels;
    cache.delete(id);
  }
}

async function decode(blob) {
  if (globalThis.createImageBitmap) {
    try {
      return await createImageBitmap(blob);
    } catch (err) {
      // Algunos navegadores fallan con ciertos formatos; se intenta con <img>.
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/** Devuelve la imagen si ya está decodificada; si no, la carga y emite 'loaded'. */
export function getImage(blobId) {
  const e = cache.get(blobId);
  if (e && e.bitmap) {
    e.lastUsed = performance.now();
    return e.bitmap;
  }
  if (!e) loadImage(blobId);
  return null;
}

export function loadImage(blobId) {
  const e = cache.get(blobId);
  if (e && e.bitmap) return Promise.resolve(e.bitmap);
  if (e && e.loading) return e.loading;
  const loading = (async () => {
    const rec = await repo.getBlob(blobId);
    if (!rec) throw new Error('Imagen no encontrada');
    const bitmap = await decode(new Blob([rec.data], { type: rec.type || 'image/png' }));
    const w = bitmap.width || bitmap.naturalWidth || 1;
    const h = bitmap.height || bitmap.naturalHeight || 1;
    cache.set(blobId, { bitmap, pixels: w * h, lastUsed: performance.now() });
    totalPixels += w * h;
    evict();
    imageEvents.emit('loaded', { blobId });
    return bitmap;
  })();
  cache.set(blobId, { loading });
  loading.catch(err => {
    console.warn('No se pudo cargar la imagen', blobId, err);
    cache.delete(blobId);
    imageEvents.emit('failed', { blobId });
  });
  return loading;
}

/**
 * Prepara un archivo de imagen para insertarlo: reduce a un máximo razonable y lo guarda.
 * Devuelve { blobId, width, height }.
 */
export async function importImageFile(file, { maxSide = 2400 } = {}) {
  const bitmap = await decode(file);
  const w0 = bitmap.width || bitmap.naturalWidth;
  const h0 = bitmap.height || bitmap.naturalHeight;
  if (!w0 || !h0) throw new Error('La imagen no es válida');
  const scale = Math.min(1, maxSide / Math.max(w0, h0));
  const isPng = /png|gif|webp/i.test(file.type || '');
  let data;
  let type;
  if (scale >= 1 && /jpe?g|png|webp/i.test(file.type || '') && file.size < 6 * 1024 * 1024) {
    data = await file.arrayBuffer();
    type = file.type;
  } else {
    const w = Math.max(1, Math.round(w0 * scale));
    const h = Math.max(1, Math.round(h0 * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, w, h);
    type = isPng ? 'image/png' : 'image/jpeg';
    const blob = await new Promise(res => canvas.toBlob(res, type, 0.9));
    if (!blob) throw new Error('No se pudo procesar la imagen');
    data = await blob.arrayBuffer();
    canvas.width = canvas.height = 0;
  }
  try { bitmap.close && bitmap.close(); } catch {}
  const blobId = await repo.putBlob(data, type);
  return { blobId, width: Math.round(w0 * scale), height: Math.round(h0 * scale) };
}
