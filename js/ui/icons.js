// Iconos SVG de trazo (24×24). Diseño basado en el estilo de Lucide/Feather (licencias ISC/MIT), salvo las
// herramientas de escritura, que son propias: todas en la misma diagonal (45°). Dos clases de relleno:
// `ic-ink` toma el color de `--ink` (la tinta de la pluma; sin él, el del texto), `ic-ink-soft` es ese color
// atenuado (cuerpo de la pluma) e `ic-soft` es un relleno tenue del color del texto.

const P = {
  arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  checkSquare: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="m8 12 3 3 5-6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M12 10.5v6M9 13.5h6"/>',
  folderInput: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><path d="M8.5 13h7m-2.5-2.5 2.5 2.5-2.5 2.5"/>',
  fileText: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>',
  filePlus: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 11v6M9 14h6"/>',
  fileUp: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M12 18v-6M9.5 14.5 12 12l2.5 2.5"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/>',
  restore: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  more: '<circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  moreV: '<circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
  hand: '<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
  pages: '<rect x="7" y="3" width="13" height="16" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h9"/>',
  download: '<path d="M12 3v12M7 10l5 5 5-5M5 21h14"/>',
  share: '<path d="M12 3v13M7 8l5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  scissors: '<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>',
  clipboard: '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  palette: '<path d="M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.4 3.4A2 2 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12" cy="7" r="1.2" fill="currentColor" stroke="none"/><circle cx="16.5" cy="10.5" r="1.2" fill="currentColor" stroke="none"/>',
  history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M12 4v16"/>',
  splitRows: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 12h18"/>',
  swap: '<path d="M7 7h13M16 3l4 4-4 4"/><path d="M17 17H4M8 13l-4 4 4 4"/>',
  fileSwap: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 14h6M13 12l2 2-2 2"/>',
  zoomIn: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M11 8v6M8 11h6"/>',
  zoomOut: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5M8 11h6"/>',
  fit: '<path d="M4 9V5a1 1 0 0 1 1-1h4M15 4h4a1 1 0 0 1 1 1v4M20 15v4a1 1 0 0 1-1 1h-4M9 20H5a1 1 0 0 1-1-1v-4"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  cloudCheck: '<path d="M17.5 19H7a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 11 4 4 0 0 1 17.5 19z"/><path d="m9.5 14 2 2 3.5-3.5"/>',
  cloudUp: '<path d="M17.5 19H7a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 11 4 4 0 0 1 17.5 19z"/><path d="M12 16v-5M9.8 13.2 12 11l2.2 2.2"/>',
  cloudOff: '<path d="M17.5 19H7a5 5 0 1 1 .9-9.9A6 6 0 0 1 19.5 11 4 4 0 0 1 17.5 19z"/><path d="M12 11v3M12 16.5h.01"/>',
  alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-5M12 8h.01"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  chevronUp: '<path d="m18 15-6-6-6 6"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  sort: '<path d="M3 6h12M3 12h8M3 18h5M18 8v13M15 18l3 3 3-3"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.8" class="ic-ink"/><path d="m3.5 18.5 5.6-5.6a1.5 1.5 0 0 1 2.1 0L20.5 20.2" class="ic-soft"/>',
  lasso: '<ellipse cx="13" cy="10" rx="8" ry="5.5" stroke-dasharray="3.2 2.6"/><path d="M7.2 14.2c-1.6 1.4-2.3 3.6-1.4 6.3"/><circle cx="7.2" cy="14.2" r="1.6" class="ic-ink"/>',
  shapes: '<rect x="3" y="10" width="10" height="10" rx="1.8"/><circle cx="15.5" cy="8.5" r="5.5" class="ic-soft"/>',
  eraser: '<g transform="rotate(45 12 12)"><rect x="7.5" y="4" width="9" height="15" rx="2.2"/><path d="M7.5 12.5h9V17a2 2 0 0 1-2 2h-5a2 2 0 0 1-2-2z" class="ic-soft"/></g><path d="M14 21h7"/>',
  pen: '<g transform="rotate(45 12 12)"><path d="M9.5 15V5.5a2.5 2.5 0 0 1 5 0V15"/><path d="M9.5 10.5h5V15h-5z" class="ic-ink-soft"/><path d="M9.5 15h5L12 20.5z" class="ic-ink"/></g>',
  fountain: '<g transform="rotate(45 12 12)"><path d="M10 9.5V4.5a2 2 0 0 1 4 0v5"/><path d="M8.6 10.5h6.8C15.4 14.5 13 18 12 21.5 11 18 8.6 14.5 8.6 10.5z" class="ic-ink"/><path d="M12 14.6v3.4"/></g>',
  brush: '<g transform="rotate(45 12 12)"><path d="M10.8 11V3.5a1.2 1.2 0 0 1 2.4 0V11"/><path d="M9.5 11h5v3h-5z"/><path d="M9.5 14c-.6 3.6.9 5.7 2.5 8 1.6-2.3 3.1-4.4 2.5-8z" class="ic-ink"/></g>',
  pencil: '<g transform="rotate(45 12 12)"><path d="M9.5 15V4.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V15"/><path d="M9.5 6.5h5V15h-5z" class="ic-ink-soft"/><path d="M9.5 15h5L12 21z"/><path d="M11 18.6h2L12 21z" class="ic-ink"/></g>',
  highlighter: '<g transform="rotate(45 12 12)"><path d="M8.5 13V4.5a2 2 0 0 1 2-2h3a2 2 0 0 1 2 2V13z" class="ic-ink-soft"/><path d="M9.5 13h5v2.5h-5z"/><path d="M10 15.5h4v3l-4 2z" class="ic-ink"/></g>',
  text: '<path d="M4 7V5h16v2M9 20h6M12 5v15"/>',
  line: '<path d="M5 19 19 5"/>',
  arrow: '<path d="M5 19 19 5M10 5h9v9"/>',
  rect: '<rect x="3.5" y="5.5" width="17" height="13" rx="1"/>',
  ellipse: '<ellipse cx="12" cy="12" rx="9" ry="7"/>',
  triangle: '<path d="M12 4 21 19H3z"/>',
  star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z"/>',
  minimize: '<path d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"/>',
  bookmark: '<path d="M18 21 12 17 6 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z"/>',
  toc: '<path d="M4 6h16M8 12h12M8 18h12"/><path d="M4 12h.01M4 18h.01"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
  cornerUpLeft: '<path d="M9 14 4 9l5-5"/><path d="M20 20v-7a4 4 0 0 0-4-4H4"/>',
  drive: '<path d="M8.5 3h7l6 10.5-3.5 6h-12L2.5 13.5z"/><path d="M8.5 3 15 14.5h6.5M15.5 3 9 14.5l-3 5M2.5 13.5H15"/>',
  hexagon: '<path d="M21 16V8l-9-5-9 5v8l9 5z"/>',
  rotate: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5M2 12l10 5 10-5"/>',
  install: '<rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 7v7M9 11l3 3 3-3M10 18h4"/>',
  hardDrive: '<path d="M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1z"/><path d="M6 16h.01M10 16h.01"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/>',
  crop: '<path d="M6 2v14a2 2 0 0 0 2 2h14"/><path d="M18 22V8a2 2 0 0 0-2-2H2"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  ruler: '<path d="M3.5 15.5 15.5 3.5l5 5-12 12z"/><path d="m7 12 1.5 1.5M9.5 9.5 12 12M12 7l1.5 1.5M14.5 4.5 17 7"/>',
  setSquare: '<path d="M4 4v16h16z"/><path d="M8 11.5V16h4.5z"/>',
  cartabon: '<path d="M4 20V5l17 15z"/><path d="M7.5 13v4h4.6z"/>',
  protractor: '<path d="M2.5 18a9.5 9.5 0 0 1 19 0z"/><path d="M12 18v-3M5.6 11.6l1.6 1.6M18.4 11.6l-1.6 1.6M12 8.5v1.5"/>',
  compass: '<circle cx="12" cy="4.5" r="1.8"/><path d="M11 6.2 6 20M13 6.2 18 20M8.2 14h7.6"/>',
  grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  maximize: '<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>',
  bringFront: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1"/>'
};

export function icon(name, cls = '') {
  const body = P[name] || P.info;
  return `<svg class="svg-icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
}

/** Sustituye los <span data-icon="nombre"> por su SVG. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(el => {
    if (el.dataset.iconDone) return;
    el.innerHTML = icon(el.dataset.icon);
    el.dataset.iconDone = '1';
  });
}

export const ICON_NAMES = Object.keys(P);
