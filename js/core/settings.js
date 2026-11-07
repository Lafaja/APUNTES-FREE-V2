// Preferencias del usuario (localStorage, lectura síncrona al arrancar).
// No contienen documentos: perderlas nunca pierde datos, solo preferencias.

import { Emitter } from './events.js';
import { uid } from './util.js';
import { DEFAULT_PAPER } from '../model/paper.js';

const KEY = 'ts2.settings';
const STAMPS_KEY = 'ts2.settings.stamps';
// Ajustes propios de cada dispositivo: no se sincronizan con la cuenta.
const LOCAL_ONLY = ['penDetected', 'openTabs', 'splitRatio', 'fingerMode', 'keepFullscreen'];
const DASH_IDS = ['solid', 'dash', 'dot', 'dashdot']; // tipos de línea (ver DASHES en render/ink.js)

export const INK_COLORS = [
  '#0f172a', '#475569', '#94a3b8', '#ffffff',
  '#dc2626', '#f97316', '#eab308', '#92400e',
  '#16a34a', '#0d9488', '#0ea5e9', '#2563eb',
  '#4f46e5', '#9333ea', '#db2777', '#000000'
];

export const HIGHLIGHT_COLORS = ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c', '#c084fc', '#22d3ee', '#f87171'];

export const DEFAULT_PRESETS = [
  { id: 'pen-black', t: 'pen', c: '#0f172a', w: 2.2 },
  { id: 'pen-blue', t: 'fountain', c: '#1d4ed8', w: 2 },
  { id: 'pen-red', t: 'pen', c: '#dc2626', w: 2.2 },
  { id: 'hl-yellow', t: 'highlighter', c: '#facc15', w: 16 }
];

// Modo «por herramientas»: cada herramienta de escritura con 3 grosores y 5 colores propios, editables.
export const KIT_TYPES = ['pen', 'fountain', 'brush', 'pencil', 'highlighter'];
export const KIT_SIZES = 3;
export const KIT_COLORS = 5;
const DEFAULT_KIT = {
  tool: 'pen',
  pen: { sizes: [1.2, 2.2, 3.5], colors: ['#0f172a', '#2563eb', '#dc2626', '#16a34a', '#9333ea'], si: 1, ci: 0 },
  fountain: { sizes: [1.4, 2, 3], colors: ['#0f172a', '#1d4ed8', '#dc2626', '#0d9488', '#92400e'], si: 1, ci: 1 },
  brush: { sizes: [2, 4, 7], colors: ['#0f172a', '#dc2626', '#2563eb', '#16a34a', '#f97316'], si: 1, ci: 0 },
  pencil: { sizes: [1.2, 2, 3.2], colors: ['#334155', '#0f172a', '#64748b', '#dc2626', '#2563eb'], si: 1, ci: 0 },
  highlighter: { sizes: [10, 16, 24], colors: ['#facc15', '#4ade80', '#60a5fa', '#f472b6', '#fb923c'], si: 1, ci: 0 }
};

// Qué sale, y en qué orden, en la barra y en el menú circular de cada modo (Ajustes → Personalizar).
// 'presets' = los bolis guardados; 'sizes'/'colors' = los 3 grosores y 5 colores del modo por herramientas.
export const LAYOUT_ITEMS = {
  toolbar: {
    presets: ['presets', 'eraser', 'lasso', 'shape', 'image', 'instruments'],
    kit: [...KIT_TYPES, 'sizes', 'colors', 'eraser', 'lasso', 'shape', 'image', 'instruments']
  },
  radial: {
    presets: ['presets', 'eraser', 'lasso', 'shape', 'image', 'colors'],
    // 'active' = la herramienta de escritura que tengas (bolígrafo, lápiz, subrayador…); 'dashes' = tipos de línea
    kit: ['active', 'eraser', 'lasso', 'shape', ...KIT_TYPES, 'image', 'colors', 'sizes', 'dashes']
  }
};
// Ocultos de serie (se pueden activar en Ajustes → Barra y menú → Personalizar).
const LAYOUT_OFF = { 'radial.presets': ['image'], 'radial.kit': [...KIT_TYPES, 'image'] };

export function defaultLayout(place, mode) {
  const off = LAYOUT_OFF[`${place}.${mode}`] || [];
  return LAYOUT_ITEMS[place][mode].map(id => ({ id, on: !off.includes(id) }));
}

function sanitizeLayouts(l) {
  const out = {};
  for (const place of Object.keys(LAYOUT_ITEMS)) {
    out[place] = {};
    for (const mode of Object.keys(LAYOUT_ITEMS[place])) {
      const known = LAYOUT_ITEMS[place][mode];
      let saved = l && l[place] && Array.isArray(l[place][mode]) ? l[place][mode] : [];
      // Menú circular del modo por herramientas de antes de 2.19 (sin «herramienta activa»): al nuevo de serie.
      if (place === 'radial' && mode === 'kit' && !saved.some(x => x && x.id === 'active')) saved = [];
      const list = [];
      for (const it of saved) {
        if (it && known.includes(it.id) && !list.some(x => x.id === it.id)) list.push({ id: it.id, on: it.on !== false });
      }
      for (const d of defaultLayout(place, mode)) if (!list.some(x => x.id === d.id)) list.push(d);
      out[place][mode] = list;
    }
  }
  return out;
}

/** Elementos visibles, en orden, de la barra ('toolbar') o del menú circular ('radial') del modo actual. */
export function layoutItems(place, mode = settings.get('toolbarMode')) {
  return (settings.get('layouts')[place][mode] || []).filter(x => x.on).map(x => x.id);
}

// Tiempos y tolerancias que el usuario puede ajustar (Ajustes → Tiempos). min/max/step para el deslizador.
export const TIMINGS = {
  shapeSnapDelay: { def: 550, min: 150, max: 2000, step: 50, unit: 'ms' }, // lápiz quieto al final del trazo → forma perfecta
  shapeSnapTolerance: { def: 4, min: 1, max: 16, step: 1, unit: 'px' }, // movimiento que aún cuenta como "quieto"
  radialMenuDelay: { def: 500, min: 200, max: 1500, step: 50, unit: 'ms' }, // mantener pulsado → menú circular
  doubleTapMs: { def: 350, min: 150, max: 800, step: 25, unit: 'ms' }, // separación máxima entre los dos toques
  gestureTapMs: { def: 280, min: 120, max: 700, step: 20, unit: 'ms' }, // duración máxima de un toque (2 dedos = deshacer)
  palmGuardMs: { def: 500, min: 0, max: 2000, step: 50, unit: 'ms' }, // dedos ignorados tras usar el lápiz
  dragHoldMs: { def: 420, min: 150, max: 1500, step: 30, unit: 'ms' } // biblioteca: mantener para arrastrar una tarjeta
};

/** Valor de un tiempo ajustable, siempre dentro de sus límites. */
export function timing(key) {
  const t = TIMINGS[key];
  const v = Number(settings.get(key));
  return Number.isFinite(v) ? Math.min(t.max, Math.max(t.min, v)) : t.def;
}

const DEFAULTS = {
  theme: 'auto',
  fingerMode: 'auto', // 'auto' (dibuja hasta detectar lápiz) | 'pan' | 'draw'
  penDetected: false,
  presets: DEFAULT_PRESETS,
  activePresetId: 'pen-black',
  toolbarMode: 'presets', // barra de dibujo: 'presets' (bolis guardados) | 'kit' (por herramientas)
  kit: DEFAULT_KIT,
  layouts: null, // se rellena con los valores de serie en sanitize()
  favColors: [],
  eraser: { mode: 'stroke', size: 18 },
  shape: { type: 'rect', fill: 'none', w: 2.5, color: '#0f172a', ds: 'solid' },
  defaultPaper: { ...DEFAULT_PAPER },
  sort: 'updated',
  autoAddPages: true,
  twoFingerUndo: true,
  showZoomControls: true,
  backupReminderDays: 7,
  pressure: 'normal', // sensibilidad a la presión del lápiz: 'off' | 'soft' | 'normal' | 'strong'
  shapeSnap: true, // formas perfectas al mantener el lápiz quieto al final del trazo
  radialMenu: true, // menú circular de herramientas y colores al mantener pulsado sin moverse
  radialDoubleTap: true, // … con doble toque del dedo (cuando el dedo desplaza)
  radialPenButton: false, // … con el botón lateral del lápiz (en vez de borrar)
  radialFab: false, // … con un botón flotante en la esquina del documento
  radialMenuInput: 'both', // 'both' | 'pen' | 'finger'
  radialMenuDelay: 500, // ms
  shapeSnapDelay: 550,
  shapeSnapTolerance: 4,
  doubleTapMs: 350,
  gestureTapMs: 280,
  palmGuardMs: 500,
  dragHoldMs: 420,
  keepFullscreen: false, // volver a pantalla completa al primer toque si el sistema la quitó (cambiar de app…)
  tabsBar: 'always', // barra de pestañas: 'always' | 'auto' (con 2 o más) | 'off'
  openTabs: [], // pestañas de documentos (ids)
  units: 'mm', // unidades para mostrar grosores y medidas: 'mm' | 'cm' | 'pt' | 'px'
  splitOrientation: 'auto', // pantalla dual: 'auto' (según el giro) | 'side' | 'stack'
  splitRatio: 0.5
};

class Settings extends Emitter {
  constructor() {
    super();
    this.data = structuredCloneSafe(DEFAULTS);
    this._timer = null;
    this._dirty = new Set(); // claves cambiadas en esta ventana y aún sin guardar
    this.load();
    // Otra ventana o pestaña de la app (p. ej. la versión anterior aún abierta al actualizar) guardó
    // ajustes: se adoptan aquí para no volver a escribir encima con valores viejos.
    globalThis.addEventListener?.('storage', e => {
      if (e.key === KEY) this.adoptExternal(e.newValue);
    });
    // Al salir, recargar o actualizar la app: guardar ya lo pendiente (no esperar al temporizador).
    const flush = () => {
      if (this._dirty.size) this.saveNow();
    };
    globalThis.addEventListener?.('pagehide', flush);
    globalThis.document?.addEventListener?.('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush();
    });
  }

  load() {
    try {
      const raw = globalThis.localStorage ? localStorage.getItem(KEY) : null;
      if (raw) {
        const parsed = JSON.parse(raw);
        this.data = { ...structuredCloneSafe(DEFAULTS), ...parsed };
      }
    } catch (err) {
      console.warn('Preferencias ilegibles, se usan las predeterminadas', err);
    }
    this.sanitize();
  }

  sanitize() {
    const d = this.data;
    if (!Array.isArray(d.presets) || !d.presets.length) d.presets = structuredCloneSafe(DEFAULT_PRESETS);
    d.presets = d.presets
      .filter(p => p && typeof p === 'object')
      .map(p => ({
        id: p.id || uid('pr'),
        t: ['pen', 'fountain', 'brush', 'pencil', 'highlighter'].includes(p.t) ? p.t : 'pen',
        c: /^#[0-9a-f]{6}$/i.test(p.c || '') ? p.c : '#0f172a',
        w: Number.isFinite(p.w) && p.w > 0 ? Math.min(60, p.w) : 2.2,
        ...(DASH_IDS.includes(p.ds) && p.ds !== 'solid' ? { ds: p.ds } : {})
      }));
    if (!d.presets.some(p => p.id === d.activePresetId)) d.activePresetId = d.presets[0].id;
    if (!['presets', 'kit'].includes(d.toolbarMode)) d.toolbarMode = 'presets';
    d.kit = sanitizeKit(d.kit);
    d.layouts = sanitizeLayouts(d.layouts);
    if (!Array.isArray(d.favColors)) d.favColors = [];
    d.favColors = d.favColors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 24);
    if (!['auto', 'light', 'dark'].includes(d.theme)) d.theme = 'auto';
    if (!['auto', 'pan', 'draw'].includes(d.fingerMode)) d.fingerMode = 'auto';
    if (!['auto', 'side', 'stack'].includes(d.splitOrientation)) d.splitOrientation = 'auto';
    if (!['mm', 'cm', 'pt', 'px'].includes(d.units)) d.units = 'mm';
    if (!['off', 'soft', 'normal', 'strong'].includes(d.pressure)) d.pressure = 'normal';
    if (!['both', 'pen', 'finger'].includes(d.radialMenuInput)) d.radialMenuInput = 'both';
    for (const [k, t] of Object.entries(TIMINGS)) {
      const v = Number(d[k]);
      d[k] = Number.isFinite(v) ? Math.min(t.max, Math.max(t.min, Math.round(v))) : t.def;
    }
    if (!['always', 'auto', 'off'].includes(d.tabsBar)) d.tabsBar = 'always';
    d.openTabs = Array.isArray(d.openTabs) ? d.openTabs.filter(id => typeof id === 'string').slice(-12) : [];
    d.splitRatio = Number.isFinite(d.splitRatio) ? Math.min(0.8, Math.max(0.2, d.splitRatio)) : 0.5;
    d.eraser = { mode: d.eraser?.mode === 'precision' ? 'precision' : 'stroke', size: Number.isFinite(d.eraser?.size) ? d.eraser.size : 18 };
    d.shape = { ...DEFAULTS.shape, ...(d.shape || {}) };
    if (!DASH_IDS.includes(d.shape.ds)) d.shape.ds = 'solid';
    d.defaultPaper = { ...DEFAULT_PAPER, ...(d.defaultPaper || {}) };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this._dirty.add(key);
    this.stamp([key], Date.now());
    this.save();
    this.emit('change', { key, value });
  }

  /** Momento del último cambio de cada ajuste (compartido entre pestañas); decide qué gana al sincronizar. */
  stamps() {
    try {
      const s = JSON.parse(localStorage.getItem(STAMPS_KEY) || '{}');
      return s && typeof s === 'object' && !Array.isArray(s) ? s : {};
    } catch {
      return {};
    }
  }

  stamp(keys, t) {
    try {
      const s = this.stamps();
      for (const k of keys) s[k] = t;
      localStorage.setItem(STAMPS_KEY, JSON.stringify(s));
    } catch {}
  }

  /** Ajustes que viajan con la cuenta (sin los propios de cada dispositivo) y cuándo cambió cada uno. */
  syncSnapshot() {
    const all = this.stamps();
    const values = {};
    const stamps = {};
    for (const k of Object.keys(DEFAULTS)) {
      if (LOCAL_ONLY.includes(k)) continue;
      values[k] = structuredCloneSafe(this.data[k]);
      stamps[k] = Number(all[k]) || 0;
    }
    return { values, stamps };
  }

  /** Aplica ajustes llegados de la cuenta conservando su marca de tiempo (no cuentan como cambio local). */
  adoptSynced(values, stamps) {
    const keys = Object.keys(values).filter(k => k in DEFAULTS && !LOCAL_ONLY.includes(k));
    if (!keys.length) return;
    for (const k of keys) {
      this.data[k] = structuredCloneSafe(values[k]);
      this._dirty.add(k);
    }
    this.sanitize();
    const s = this.stamps();
    for (const k of keys) s[k] = Number(stamps[k]) || 0;
    try { localStorage.setItem(STAMPS_KEY, JSON.stringify(s)); } catch {}
    this.saveNow();
    for (const k of keys) this.emit('change', { key: k, value: this.data[k], synced: true });
  }

  update(key, patch) {
    this.set(key, { ...(this.data[key] || {}), ...patch });
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 150);
  }

  /**
   * Escribe SOLO las claves cambiadas en esta ventana sobre lo que haya guardado. Así una ventana con
   * ajustes viejos en memoria nunca deshace los colores o ajustes cambiados en otra.
   */
  saveNow() {
    clearTimeout(this._timer);
    try {
      let stored = null;
      try {
        stored = JSON.parse(localStorage.getItem(KEY) || 'null');
      } catch {}
      let out;
      if (stored && typeof stored === 'object' && !Array.isArray(stored)) {
        out = stored;
        for (const k of this._dirty) out[k] = this.data[k];
      } else {
        out = this.data;
      }
      localStorage.setItem(KEY, JSON.stringify(out));
      this._dirty.clear();
    } catch (err) {
      console.warn('No se pudieron guardar las preferencias', err);
    }
  }

  /** Incorpora los ajustes guardados por otra ventana (salvo los que esta tiene pendientes de guardar). */
  adoptExternal(raw) {
    let parsed;
    try {
      parsed = JSON.parse(raw || 'null');
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const changed = [];
    for (const k of Object.keys(parsed)) {
      if (this._dirty.has(k)) continue;
      if (JSON.stringify(parsed[k]) === JSON.stringify(this.data[k])) continue;
      this.data[k] = parsed[k];
      changed.push(k);
    }
    if (!changed.length) return;
    this.sanitize();
    for (const k of changed) this.emit('change', { key: k, value: this.data[k] });
  }

  /** Datos exportables en copias de seguridad. */
  exportable() {
    const { penDetected, ...rest } = this.data;
    return structuredCloneSafe(rest);
  }

  /** Aplica solo estas claves (p. ej. recuperar la configuración de herramientas) y las da por cambiadas ahora. */
  applyPartial(obj) {
    if (!obj || typeof obj !== 'object') return;
    const keys = Object.keys(obj).filter(k => k in DEFAULTS);
    for (const k of keys) this.data[k] = structuredCloneSafe(obj[k]);
    this.sanitize();
    for (const k of keys) this._dirty.add(k);
    this.stamp(keys, Date.now());
    this.saveNow();
    this.emit('change', { key: '*' });
  }

  importFrom(obj) {
    if (!obj || typeof obj !== 'object') return;
    this.data = { ...this.data, ...obj };
    this.sanitize();
    for (const k of Object.keys(this.data)) this._dirty.add(k);
    this.stamp(Object.keys(this.data), Date.now());
    this.saveNow();
    this.emit('change', { key: '*' });
  }
}

function sanitizeKit(k) {
  const src = k && typeof k === 'object' ? k : {};
  const out = { tool: KIT_TYPES.includes(src.tool) ? src.tool : 'pen' };
  const hex = c => /^#[0-9a-f]{6}$/i.test(c || '');
  for (const t of KIT_TYPES) {
    const def = DEFAULT_KIT[t];
    const cur = src[t] && typeof src[t] === 'object' ? src[t] : {};
    const sizes = def.sizes.map((w, i) => {
      const v = Array.isArray(cur.sizes) ? Number(cur.sizes[i]) : NaN;
      return Number.isFinite(v) && v > 0 ? Math.min(60, v) : w;
    });
    const colors = def.colors.map((c, i) => (Array.isArray(cur.colors) && hex(cur.colors[i]) ? cur.colors[i] : c));
    const idx = (v, n, d) => (Number.isInteger(v) && v >= 0 && v < n ? v : d);
    out[t] = { sizes, colors, si: idx(cur.si, KIT_SIZES, def.si), ci: idx(cur.ci, KIT_COLORS, def.ci) };
    if (t !== 'highlighter' && DASH_IDS.includes(cur.ds) && cur.ds !== 'solid') out[t].ds = cur.ds;
  }
  return out;
}

/** Pluma equivalente a la herramienta elegida en el modo «por herramientas» (mismo formato que un boli guardado). */
export function kitPreset(kit = settings.get('kit')) {
  const t = kit.tool;
  const k = kit[t];
  return { id: `kit-${t}`, t, c: k.colors[k.ci], w: k.sizes[k.si], ...(k.ds ? { ds: k.ds } : {}) };
}

function structuredCloneSafe(o) {
  return JSON.parse(JSON.stringify(o));
}

export const settings = new Settings();

/** Resuelve el tema efectivo y lo aplica al documento. */
export function applyTheme() {
  let t = settings.get('theme');
  if (t === 'auto') t = globalThis.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.querySelectorAll('meta[name="theme-color"]');
  meta.forEach(m => m.setAttribute('content', t === 'dark' ? '#121b2f' : '#ffffff'));
  return t;
}

// Las medidas internas están en píxeles CSS de la página (96 por pulgada: un A4 mide 794 × 1123).
export const UNITS = {
  mm: { label: 'mm', per: 25.4 / 96, decimals: 2 },
  cm: { label: 'cm', per: 2.54 / 96, decimals: 2 },
  pt: { label: 'pt', per: 72 / 96, decimals: 1 },
  px: { label: 'px', per: 1, decimals: 1 }
};

/** Muestra una medida (en píxeles de página) en las unidades elegidas, p. ej. «0,58 mm». */
export function formatLength(px, unit = settings.get('units')) {
  const u = UNITS[unit] || UNITS.mm;
  const v = px * u.per;
  // Menos decimales cuando el número es grande (7,4 mm en vez de 7,41 mm).
  const dec = Math.abs(v) >= 10 ? Math.max(0, u.decimals - 1) : u.decimals;
  let txt = v.toFixed(dec);
  if (txt.includes('.')) txt = txt.replace(/0+$/, '').replace(/\.$/, ''); // 0,50 → 0,5 (pero 10 sigue siendo 10)
  return `${txt.replace('.', ',')} ${u.label}`;
}

/** ¿El dedo dibuja en este momento? */
export function fingerDraws() {
  const mode = settings.get('fingerMode');
  if (mode === 'draw') return true;
  if (mode === 'pan') return false;
  return !settings.get('penDetected');
}
