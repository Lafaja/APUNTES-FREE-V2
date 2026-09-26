// Utilidades generales sin dependencias del DOM (usables también en tests con Node).

let idCounter = 0;

/** Identificador único, corto y ordenable por tiempo. */
export function uid(prefix = 'id') {
  idCounter = (idCounter + 1) % 1679616;
  const time = Date.now().toString(36);
  let rand = '';
  if (globalThis.crypto && typeof globalThis.crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(2);
    globalThis.crypto.getRandomValues(buf);
    rand = buf[0].toString(36) + buf[1].toString(36).slice(0, 4);
  } else {
    rand = Math.random().toString(36).slice(2, 12);
  }
  return `${prefix}_${time}${idCounter.toString(36).padStart(4, '0')}${rand}`;
}

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);

export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Debounce con opción maxWait: garantiza ejecutar al menos cada maxWait ms bajo actividad continua. */
export function debounce(fn, wait, { maxWait = 0 } = {}) {
  let timer = null;
  let firstCallAt = 0;
  let lastArgs = null;
  const invoke = () => {
    timer = null;
    firstCallAt = 0;
    const args = lastArgs;
    lastArgs = null;
    fn(...(args || []));
  };
  const debounced = (...args) => {
    lastArgs = args;
    const now = Date.now();
    if (!firstCallAt) firstCallAt = now;
    if (timer) clearTimeout(timer);
    if (maxWait && now - firstCallAt >= maxWait) {
      invoke();
      return;
    }
    const remainingMax = maxWait ? maxWait - (now - firstCallAt) : wait;
    timer = setTimeout(invoke, Math.min(wait, remainingMax));
  };
  debounced.flush = () => {
    if (timer) {
      clearTimeout(timer);
      invoke();
    }
  };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    firstCallAt = 0;
    lastArgs = null;
  };
  debounced.pending = () => timer !== null;
  return debounced;
}

/** Ejecuta fn como máximo una vez por frame de animación. */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  const raf = globalThis.requestAnimationFrame || (cb => setTimeout(cb, 16));
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    raf(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

const dateFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('es-ES', { day: 'numeric', month: 'short', year: 'numeric' }) : null;
const timeFmt = typeof Intl !== 'undefined' ? new Intl.DateTimeFormat('es-ES', { hour: '2-digit', minute: '2-digit' }) : null;

export function formatDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay && timeFmt) return `Hoy, ${timeFmt.format(d)}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString() && timeFmt) return `Ayer, ${timeFmt.format(d)}`;
  return dateFmt ? dateFmt.format(d) : d.toLocaleDateString();
}

export function formatDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${formatDate(ts)}${timeFmt && !formatDate(ts).includes(',') ? `, ${timeFmt.format(d)}` : ''}`;
}

export function timeAgo(ts) {
  if (!ts) return 'nunca';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return 'hace un momento';
  const m = Math.round(s / 60);
  if (m < 60) return `hace ${m} min`;
  const h = Math.round(m / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return 'hace 1 día';
  if (d < 30) return `hace ${d} días`;
  return formatDate(ts);
}

/** SHA-256 en hexadecimal (null si crypto.subtle no está disponible, p. ej. file://). */
export async function sha256Hex(buffer) {
  try {
    if (!globalThis.crypto || !globalThis.crypto.subtle) return null;
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buffer);
    const bytes = new Uint8Array(digest);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
    return hex;
  } catch {
    return null;
  }
}

export function sanitizeFileName(name, fallback = 'documento') {
  const clean = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return clean || fallback;
}

export function cleanName(name, fallback = 'Sin título') {
  const n = String(name ?? '').replace(/\s+/g, ' ').trim();
  return n.slice(0, 200) || fallback;
}

/** Convierte base64 (con o sin prefijo data:) a Uint8Array. Devuelve null si no es válido. */
export function base64ToBytes(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  let s = b64;
  const comma = s.indexOf('base64,');
  if (comma !== -1) s = s.slice(comma + 7);
  s = s.replace(/\s+/g, '');
  try {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < u8.length; i += chunk) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + chunk));
  }
  return btoa(bin);
}

/** Copia independiente de un ArrayBuffer / vista tipada. */
export function toArrayBuffer(data) {
  if (!data) return null;
  if (data instanceof ArrayBuffer) return data.slice(0);
  if (ArrayBuffer.isView(data)) return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  return null;
}

export function isPdfBytes(buf) {
  if (!buf) return false;
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf, 0, Math.min(1024, buf.byteLength || 0));
  const head = String.fromCharCode(...u8.subarray(0, Math.min(1024, u8.length)));
  return head.includes('%PDF-');
}

/** Espera al siguiente frame, o como mucho `timeout` ms (la pestaña puede no estar pintando). */
export function nextFrame(timeout = 100) {
  return new Promise(resolve => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    if (globalThis.requestAnimationFrame) requestAnimationFrame(() => finish());
    setTimeout(finish, timeout);
  });
}

/** Estructura simple de promesa diferida. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Cola que serializa tareas asíncronas (una detrás de otra). */
export function createSerialQueue() {
  let tail = Promise.resolve();
  return function enqueue(task) {
    const run = tail.then(() => task());
    tail = run.catch(() => {});
    return run;
  };
}
