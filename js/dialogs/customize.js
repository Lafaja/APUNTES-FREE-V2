// Personalizar la barra de dibujo y el menú circular: el modo (bolis guardados o por herramientas),
// qué elementos salen y en qué orden. Cada modo guarda su propia distribución (settings.layouts).

import { settings, defaultLayout } from '../core/settings.js';
import { BRUSHES } from '../render/ink.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

const INFO = {
  presets: { name: 'Bolis guardados', icon: 'pen', sub: 'Todos tus bolis, en el orden de su panel' },
  active: { name: 'Herramienta activa', icon: 'pen', sub: 'La que tengas: bolígrafo, pluma, pincel, lápiz o subrayador' },
  dashes: { name: 'Tipos de línea', icon: 'line', sub: 'Continua, guiones, puntos o guion y punto' },
  pen: { name: BRUSHES.pen.name, icon: 'pen' },
  fountain: { name: BRUSHES.fountain.name, icon: 'fountain' },
  brush: { name: BRUSHES.brush.name, icon: 'brush' },
  pencil: { name: BRUSHES.pencil.name, icon: 'pencil' },
  highlighter: { name: BRUSHES.highlighter.name, icon: 'highlighter' },
  sizes: { name: 'Grosores', icon: 'line', sub: 'Los 3 grosores de la herramienta elegida' },
  colors: { name: 'Colores', icon: 'palette', sub: 'Los colores de la herramienta elegida' },
  eraser: { name: 'Borrador', icon: 'eraser' },
  lasso: { name: 'Lazo', icon: 'lasso' },
  shape: { name: 'Formas', icon: 'shapes' },
  image: { name: 'Imagen', icon: 'image' },
  instruments: { name: 'Regla e instrumentos', icon: 'ruler' }
};

function segmented(options, value, onPick) {
  const seg = h('div.segmented');
  for (const o of options) {
    const b = h('button', { type: 'button' }, o.label);
    if (o.id === value) b.classList.add('active');
    b.addEventListener('click', () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('active', x === b));
      onPick(o.id);
    });
    seg.appendChild(b);
  }
  return seg;
}

export function openCustomizeDialog() {
  let place = 'toolbar';
  const list = h('div.layout-list');
  const hint = h('p.panel-hint');

  const getList = () => settings.get('layouts')[place][settings.get('toolbarMode')];
  const save = items => {
    const all = settings.get('layouts');
    const mode = settings.get('toolbarMode');
    settings.set('layouts', { ...all, [place]: { ...all[place], [mode]: items } });
    render();
  };

  const render = () => {
    clear(list);
    const items = getList();
    const kit = settings.get('toolbarMode') === 'kit';
    hint.textContent = place === 'toolbar'
      ? 'Activa o quita cada elemento y ordénalo con las flechas. Lo que quites aquí sigue disponible en el menú circular.'
      : `Anillo interior: herramientas. Anillo exterior: ${kit ? 'colores, grosores y tipos de línea' : 'colores'}. Se abre al mantener pulsado (pestaña «Barra y menú»).`;
    items.forEach((it, i) => {
      const info = INFO[it.id] || { name: it.id, icon: 'more' };
      const sw = h('input', { type: 'checkbox', checked: it.on, 'aria-label': `Mostrar ${info.name}` });
      sw.addEventListener('change', () => {
        const next = items.map(x => (x.id === it.id ? { ...x, on: sw.checked } : x));
        if (!next.some(x => x.on)) {
          sw.checked = true;
          toast('Tiene que quedar al menos un elemento', { type: 'warn' });
          return;
        }
        save(next);
      });
      const move = dir => {
        const b = h('button.btn.btn-icon.btn-sm', { type: 'button', title: dir < 0 ? 'Subir' : 'Bajar', 'aria-label': dir < 0 ? 'Subir' : 'Bajar' }, iconEl(dir < 0 ? 'chevronUp' : 'chevronDown'));
        b.disabled = dir < 0 ? i === 0 : i === items.length - 1;
        b.addEventListener('click', () => {
          const next = items.slice();
          [next[i], next[i + dir]] = [next[i + dir], next[i]];
          save(next);
        });
        return b;
      };
      const row = h('div.layout-row', { dataset: { id: it.id } },
        h('span.layout-icon', iconEl(info.icon)),
        h('div.row-text', h('div.row-title', info.name), info.sub ? h('div.row-sub', info.sub) : null),
        move(-1), move(1),
        h('label.switch', sw, h('span')));
      if (!it.on) row.classList.add('off');
      list.appendChild(row);
    });
  };

  const modeSeg = segmented([
    { id: 'presets', label: 'Bolis guardados' }, { id: 'kit', label: 'Por herramientas' }
  ], settings.get('toolbarMode'), v => {
    settings.set('toolbarMode', v);
    render();
  });
  const placeSeg = segmented([
    { id: 'toolbar', label: 'Barra' }, { id: 'radial', label: 'Menú circular' }
  ], place, v => {
    place = v;
    render();
  });

  const body = h('div.customize-body',
    h('div.field', h('span', 'Método'), modeSeg),
    h('p.panel-hint', '«Bolis guardados»: cada botón es un boli con su color y grosor. «Por herramientas»: bolígrafo, pluma, pincel, lápiz y subrayador, cada uno con 3 grosores y 5 colores propios.'),
    h('div.field', { style: { marginTop: '14px' } }, h('span', 'Personalizar'), placeSeg),
    hint,
    list);
  render();

  return openModal({
    title: 'Barra y menú circular',
    body,
    wide: true,
    buttons: [
      {
        label: 'Restablecer',
        value: null,
        variant: 'btn-ghost',
        onClick: () => {
          save(defaultLayout(place, settings.get('toolbarMode')));
          return false;
        }
      },
      'spacer',
      { label: 'Listo', value: true, variant: 'btn-primary' }
    ]
  }).promise;
}
