// Preferencias del usuario (localStorage, lectura síncrona al arrancar).
// No contienen documentos: perderlas nunca pierde datos, solo preferencias.

import { Emitter } from './events.js';
import { uid } from './util.js';
import { DEFAULT_PAPER } from '../model/paper.js';

const KEY = 'ts2.settings';

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

const DEFAULTS = {
  theme: 'auto',
  fingerMode: 'auto', // 'auto' (dibuja hasta detectar lápiz) | 'pan' | 'draw'
  penDetected: false,
  presets: DEFAULT_PRESETS,
  activePresetId: 'pen-black',
  favColors: [],
  eraser: { mode: 'stroke', size: 18 },
  shape: { type: 'rect', fill: 'none', w: 2.5, color: '#0f172a' },
  defaultPaper: { ...DEFAULT_PAPER },
  sort: 'updated',
  autoAddPages: true,
  twoFingerUndo: true,
  showZoomControls: true,
  backupReminderDays: 7,
  shapeSnap: true, // formas perfectas al mantener el lápiz quieto al final del trazo
  openTabs: [], // pestañas de documentos (ids)
  splitOrientation: 'auto', // pantalla dual: 'auto' (según el giro) | 'side' | 'stack'
  splitRatio: 0.5
};

class Settings extends Emitter {
  constructor() {
    super();
    this.data = structuredCloneSafe(DEFAULTS);
    this._timer = null;
    this.load();
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
        w: Number.isFinite(p.w) && p.w > 0 ? Math.min(60, p.w) : 2.2
      }));
    if (!d.presets.some(p => p.id === d.activePresetId)) d.activePresetId = d.presets[0].id;
    if (!Array.isArray(d.favColors)) d.favColors = [];
    d.favColors = d.favColors.filter(c => /^#[0-9a-f]{6}$/i.test(c)).slice(0, 24);
    if (!['auto', 'light', 'dark'].includes(d.theme)) d.theme = 'auto';
    if (!['auto', 'pan', 'draw'].includes(d.fingerMode)) d.fingerMode = 'auto';
    if (!['auto', 'side', 'stack'].includes(d.splitOrientation)) d.splitOrientation = 'auto';
    d.openTabs = Array.isArray(d.openTabs) ? d.openTabs.filter(id => typeof id === 'string').slice(-12) : [];
    d.splitRatio = Number.isFinite(d.splitRatio) ? Math.min(0.8, Math.max(0.2, d.splitRatio)) : 0.5;
    d.eraser = { mode: d.eraser?.mode === 'precision' ? 'precision' : 'stroke', size: Number.isFinite(d.eraser?.size) ? d.eraser.size : 18 };
    d.shape = { ...DEFAULTS.shape, ...(d.shape || {}) };
    d.defaultPaper = { ...DEFAULT_PAPER, ...(d.defaultPaper || {}) };
  }

  get(key) {
    return this.data[key];
  }

  set(key, value) {
    this.data[key] = value;
    this.save();
    this.emit('change', { key, value });
  }

  update(key, patch) {
    this.set(key, { ...(this.data[key] || {}), ...patch });
  }

  save() {
    clearTimeout(this._timer);
    this._timer = setTimeout(() => this.saveNow(), 150);
  }

  saveNow() {
    clearTimeout(this._timer);
    try {
      localStorage.setItem(KEY, JSON.stringify(this.data));
    } catch (err) {
      console.warn('No se pudieron guardar las preferencias', err);
    }
  }

  /** Datos exportables en copias de seguridad. */
  exportable() {
    const { penDetected, ...rest } = this.data;
    return structuredCloneSafe(rest);
  }

  importFrom(obj) {
    if (!obj || typeof obj !== 'object') return;
    this.data = { ...this.data, ...obj };
    this.sanitize();
    this.saveNow();
    this.emit('change', { key: '*' });
  }
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

/** ¿El dedo dibuja en este momento? */
export function fingerDraws() {
  const mode = settings.get('fingerMode');
  if (mode === 'draw') return true;
  if (mode === 'pan') return false;
  return !settings.get('penDetected');
}
