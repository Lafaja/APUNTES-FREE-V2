// Recortar una imagen: marco con tiradores sobre la imagen completa.
// El recorte no destruye nada: se guarda como rectángulo { x, y, w, h } en píxeles de la imagen
// original (campo `crop` de la imagen), así siempre se puede volver a recortar o quitar.

import { h } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';

const MIN = 16; // tamaño mínimo del recorte, en píxeles de pantalla

/**
 * Abre el recorte. `bitmap`: imagen decodificada; `crop`: recorte actual (o null = entera).
 * Devuelve { x, y, w, h } (null si queda la imagen entera), o undefined si se cancela.
 */
export function cropDialog(bitmap, crop = null, { title = 'Recortar imagen', confirmLabel = 'Recortar', fullLabel = 'Quitar recorte' } = {}) {
  const iw = bitmap.width || bitmap.naturalWidth;
  const ih = bitmap.height || bitmap.naturalHeight;
  const canvas = h('canvas.crop-canvas');
  const box = h('div.crop-box',
    ...['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map(d => h(`span.crop-handle.h-${d}`, { 'data-dir': d })));
  const stage = h('div.crop-stage', canvas, box);
  const body = h('div.crop-body', stage, h('p.crop-hint', 'Arrastra las esquinas o los bordes; arrastra dentro del marco para moverlo.'));

  // Recorte en coordenadas de la imagen.
  let r = crop ? { ...crop } : { x: 0, y: 0, w: iw, h: ih };
  let k = 1; // píxeles de pantalla por píxel de imagen

  const layout = () => {
    const maxW = Math.max(120, body.clientWidth || 600);
    const maxH = Math.max(120, Math.min(window.innerHeight * 0.6, 640));
    k = Math.min(maxW / iw, maxH / ih);
    const cw = Math.round(iw * k);
    const ch = Math.round(ih * k);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    canvas.width = Math.round(cw * dpr);
    canvas.height = Math.round(ch * dpr);
    canvas.style.width = `${cw}px`;
    canvas.style.height = `${ch}px`;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    paint();
  };

  const paint = () => {
    box.style.left = `${r.x * k}px`;
    box.style.top = `${r.y * k}px`;
    box.style.width = `${r.w * k}px`;
    box.style.height = `${r.h * k}px`;
  };

  // Arrastre: mover el marco o un borde/esquina.
  let drag = null;
  box.addEventListener('pointerdown', e => {
    e.preventDefault();
    e.stopPropagation();
    box.setPointerCapture(e.pointerId);
    drag = { id: e.pointerId, dir: e.target.dataset.dir || 'move', sx: e.clientX, sy: e.clientY, r0: { ...r } };
  });
  box.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.sx) / k;
    const dy = (e.clientY - drag.sy) / k;
    const r0 = drag.r0;
    const min = MIN / k;
    let { x, y, w, h: hh } = r0;
    if (drag.dir === 'move') {
      x = Math.min(iw - w, Math.max(0, r0.x + dx));
      y = Math.min(ih - hh, Math.max(0, r0.y + dy));
    } else {
      let x1 = r0.x, y1 = r0.y, x2 = r0.x + r0.w, y2 = r0.y + r0.h;
      if (drag.dir.includes('w')) x1 = Math.min(x2 - min, Math.max(0, r0.x + dx));
      if (drag.dir.includes('e')) x2 = Math.max(x1 + min, Math.min(iw, x2 + dx));
      if (drag.dir.includes('n')) y1 = Math.min(y2 - min, Math.max(0, r0.y + dy));
      if (drag.dir.includes('s')) y2 = Math.max(y1 + min, Math.min(ih, y2 + dy));
      x = x1; y = y1; w = x2 - x1; hh = y2 - y1;
    }
    r = { x, y, w, h: hh };
    paint();
  });
  const end = e => {
    if (drag && e.pointerId === drag.id) drag = null;
  };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);

  const result = () => {
    const out = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) };
    out.w = Math.max(1, Math.min(iw - out.x, out.w));
    out.h = Math.max(1, Math.min(ih - out.y, out.h));
    // Prácticamente entera: sin recorte.
    if (out.x <= 1 && out.y <= 1 && out.w >= iw - 2 && out.h >= ih - 2) return null;
    return out;
  };

  const m = openModal({
    title,
    body,
    wide: true,
    cancelValue: undefined,
    enterValue: () => result(),
    buttons: [
      { label: fullLabel, value: null, variant: 'btn-ghost' },
      'spacer',
      { label: 'Cancelar', value: undefined, variant: 'btn-ghost' },
      { label: confirmLabel, value: () => result(), variant: 'btn-primary' }
    ]
  });
  requestAnimationFrame(layout);
  setTimeout(layout, 60); // por si requestAnimationFrame no corre (pestaña en segundo plano)
  const onResize = () => layout();
  window.addEventListener('resize', onResize);
  m.promise.finally(() => window.removeEventListener('resize', onResize));
  return m.promise;
}

/**
 * Nueva imagen tras cambiar el recorte, sin mover lo que se sigue viendo y con la misma escala.
 * `crop`: recorte nuevo (null = imagen entera); `iw`, `ih`: tamaño original en píxeles.
 */
export function applyCrop(img, crop, iw, ih) {
  const old = img.crop || { x: 0, y: 0, w: iw, h: ih };
  const nc = crop || { x: 0, y: 0, w: iw, h: ih };
  const s = img.w / old.w; // unidades de página por píxel de imagen
  const sy = img.h / old.h;
  const dx = (nc.x + nc.w / 2 - old.x) * s - img.w / 2;
  const dy = (nc.y + nc.h / 2 - old.y) * sy - img.h / 2;
  const a = ((img.rot || 0) * Math.PI) / 180;
  const cx = img.x + img.w / 2 + dx * Math.cos(a) - dy * Math.sin(a);
  const cy = img.y + img.h / 2 + dx * Math.sin(a) + dy * Math.cos(a);
  const w = nc.w * s;
  const hh = nc.h * sy;
  const out = { ...img, x: cx - w / 2, y: cy - hh / 2, w, h: hh };
  if (crop) out.crop = { ...crop };
  else delete out.crop;
  return out;
}
