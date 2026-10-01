// Selector de color propio (sustituye al selector nativo del navegador, distinto en cada sistema):
// cuadro de saturación/luminosidad, barra de tono, código hexadecimal y cuentagotas si el navegador lo permite.
// Funciona con dedo, lápiz y ratón.

import { h, iconEl } from './dom.js';

export function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgbToHex({ r, g, b }) {
  return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}

function rgbToHsv({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s: max ? d / max : 0, v: max };
}

function hsvToRgb({ h: hh, s, v }) {
  const c = v * s;
  const x = c * (1 - Math.abs(((hh / 60) % 2) - 1));
  const m = v - c;
  let r = 0, g = 0, b = 0;
  if (hh < 60) [r, g, b] = [c, x, 0];
  else if (hh < 120) [r, g, b] = [x, c, 0];
  else if (hh < 180) [r, g, b] = [0, c, x];
  else if (hh < 240) [r, g, b] = [0, x, c];
  else if (hh < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

/** Arrastre con dedo, lápiz o ratón sobre un elemento: fn(fracciónX, fracciónY). */
function dragArea(el, fn, onEnd) {
  let id = null;
  const at = e => {
    const r = el.getBoundingClientRect();
    fn(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)));
  };
  el.addEventListener('pointerdown', e => {
    id = e.pointerId;
    try { el.setPointerCapture(id); } catch {}
    e.preventDefault();
    at(e);
  });
  el.addEventListener('pointermove', e => {
    if (e.pointerId === id) at(e);
  });
  const end = e => {
    if (e.pointerId !== id) return;
    id = null;
    if (onEnd) onEnd();
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
}

/**
 * Crea el selector. onInput(hex) se llama mientras se mueve (vista previa en vivo);
 * onSave(hex) al pulsar «Guardar color»; onCancel() al pulsar «Cancelar».
 */
export function createColorPicker({ value = '#2563eb', onInput, onSave, onCancel, saveLabel = 'Guardar color' } = {}) {
  const original = hexToRgb(value) ? value.toLowerCase() : '#2563eb';
  let hsv = rgbToHsv(hexToRgb(original));
  let hex = original;

  const svBox = h('div.cp-sv', { role: 'slider', 'aria-label': 'Saturación y luminosidad' });
  const svThumb = h('div.cp-thumb');
  svBox.appendChild(svThumb);
  const hueBar = h('div.cp-hue', { role: 'slider', 'aria-label': 'Tono' });
  const hueThumb = h('div.cp-thumb.cp-hue-thumb');
  hueBar.appendChild(hueThumb);
  const oldSw = h('span.cp-old', { title: 'Color anterior', style: { background: original } });
  const newSw = h('span.cp-new', { title: 'Color nuevo' });
  const input = h('input.cp-hex', { type: 'text', value: original, maxlength: '7', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'none', 'aria-label': 'Código de color' });
  const tools = h('div.cp-row', h('span.cp-compare', oldSw, newSw), input);
  if ('EyeDropper' in window) {
    const eye = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Cuentagotas: tomar un color de la pantalla' }, iconEl('palette'));
    eye.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        if (res && res.sRGBHex) setHex(res.sRGBHex, true);
      } catch {}
    });
    tools.appendChild(eye);
  }
  const cancel = h('button.btn.btn-ghost.btn-sm', { type: 'button' }, 'Cancelar');
  const save = h('button.btn.btn-primary.btn-sm', { type: 'button' }, saveLabel);
  const el = h('div.color-picker', svBox, hueBar, tools, h('div.cp-actions', cancel, save));

  function paint(emit) {
    const pure = rgbToHex(hsvToRgb({ h: hsv.h, s: 1, v: 1 }));
    svBox.style.backgroundColor = pure;
    svThumb.style.left = `${hsv.s * 100}%`;
    svThumb.style.top = `${(1 - hsv.v) * 100}%`;
    svThumb.style.background = hex;
    hueThumb.style.left = `${(hsv.h / 360) * 100}%`;
    hueThumb.style.background = pure;
    newSw.style.background = hex;
    if (document.activeElement !== input) input.value = hex;
    if (emit && onInput) onInput(hex);
  }

  function setHex(value, emit) {
    const rgb = hexToRgb(value);
    if (!rgb) return;
    hex = rgbToHex(rgb);
    hsv = rgbToHsv(rgb);
    paint(emit);
  }

  dragArea(svBox, (fx, fy) => {
    hsv = { ...hsv, s: fx, v: 1 - fy };
    hex = rgbToHex(hsvToRgb(hsv));
    paint(true);
  });
  dragArea(hueBar, fx => {
    hsv = { ...hsv, h: Math.min(359.9, fx * 360) };
    hex = rgbToHex(hsvToRgb(hsv));
    paint(true);
  });
  input.addEventListener('input', () => {
    let v = input.value.trim();
    if (!v.startsWith('#')) v = `#${v}`;
    if (/^#[0-9a-f]{6}$/i.test(v)) setHex(v, true);
  });
  input.addEventListener('blur', () => {
    input.value = hex;
  });
  oldSw.addEventListener('click', () => setHex(original, true));
  cancel.addEventListener('click', () => {
    if (onInput) onInput(original);
    if (onCancel) onCancel();
  });
  save.addEventListener('click', () => onSave && onSave(hex));
  paint(false);
  return { el, setHex };
}
