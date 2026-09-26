// Diálogo de migración desde la versión anterior.

import * as repo from '../core/repo.js';
import { h, iconEl } from '../ui/dom.js';
import { openModal } from '../ui/modal.js';

export function reportText(r) {
  const parts = [];
  if (r.folders) parts.push(`${r.folders} carpeta${r.folders === 1 ? '' : 's'}`);
  if (r.notes) parts.push(`${r.notes} apunte${r.notes === 1 ? '' : 's'}`);
  if (r.pdfs) parts.push(`${r.pdfs} PDF`);
  return parts.length ? parts.join(', ') : 'nada nuevo';
}

export async function runMigrationDialog(found, migrateFn, { fromSettings = false } = {}) {
  const list = h('ul', { style: { margin: '6px 0 12px', paddingLeft: '20px', color: 'var(--text-2)' } });
  if (found.folders) list.appendChild(h('li', `${found.folders} carpeta${found.folders === 1 ? '' : 's'}`));
  if (found.notes) list.appendChild(h('li', `${found.notes} apunte${found.notes === 1 ? '' : 's'} manuscrito${found.notes === 1 ? '' : 's'}`));
  if (found.pdfs) list.appendChild(h('li', `${found.pdfs} PDF${found.pdfs === 1 ? '' : 's'} con sus anotaciones`));
  const choice = await openModal({
    title: 'Tus apuntes de la versión anterior',
    body: h('div',
      h('p', 'Se han encontrado datos de la versión anterior de Tablet Studio en este navegador:'),
      list,
      h('div.banner.info', { style: { margin: '0' } }, iconEl('shield'), h('div.banner-text', 'La importación solo lee los datos antiguos: la versión anterior no se modifica ni se borra nada.'))),
    dismissible: false,
    buttons: [
      { label: fromSettings ? 'Cancelar' : 'Ahora no', value: false, variant: 'btn-ghost' },
      { label: 'Importar ahora', value: true, variant: 'btn-primary', icon: 'download' }
    ]
  }).promise;
  if (!choice) {
    if (!fromSettings) await repo.setMeta('migration', { skippedAt: Date.now() });
    return null;
  }
  const bar = h('i');
  const status = h('p', 'Importando…');
  const m = openModal({ title: 'Importando…', body: h('div', status, h('div.progress', bar)), dismissible: false, buttons: [] });
  let report;
  try {
    report = await migrateFn((i, n) => {
      bar.style.width = `${Math.round((i / Math.max(1, n)) * 100)}%`;
      status.textContent = `Importando documento ${i} de ${n}…`;
    });
  } finally {
    m.close();
  }
  const details = h('div');
  details.appendChild(h('p', `Importado: ${reportText(report)} (${report.pages} páginas, ${report.strokes} trazos, ${report.images} imágenes).`));
  if (report.skipped) details.appendChild(h('p.hint', `${report.skipped} elemento${report.skipped === 1 ? '' : 's'} ya estaba${report.skipped === 1 ? '' : 'n'} importado${report.skipped === 1 ? '' : 's'} y se ha${report.skipped === 1 ? '' : 'n'} omitido.`));
  if (report.splits) details.appendChild(h('p.hint', `${report.splits === 1 ? '1 sesión' : `${report.splits} sesiones`} de pantalla dividida no se importa${report.splits === 1 ? '' : 'n'} (no contienen apuntes; ahora la pantalla dividida se abre desde el menú ⋯ del documento).`));
  const issues = [...report.warnings, ...report.errors];
  if (issues.length) {
    const ul = h('ul', { style: { paddingLeft: '20px', color: 'var(--danger)' } });
    for (const w of issues.slice(0, 12)) ul.appendChild(h('li', w));
    details.append(h('p', 'Avisos:'), ul);
  }
  await openModal({ title: issues.length ? 'Importación terminada con avisos' : 'Importación completada', body: details, buttons: [{ label: 'Entendido', value: true, variant: 'btn-primary' }] }).promise;
  return report;
}
