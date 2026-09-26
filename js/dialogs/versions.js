// Historial de versiones de un documento: ver instantáneas y restaurar cualquiera.

import * as repo from '../core/repo.js';
import { h, iconEl, clear } from '../ui/dom.js';
import { openModal, confirmDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';
import { formatDateTime, timeAgo } from '../core/util.js';
import { normalizePageRecord } from '../model/session.js';
import { renderPageImage } from '../render/thumbs.js';

export async function openVersionsDialog(app, docId, session) {
  const node = session ? session.node : await repo.getNode(docId);
  if (!node) return;
  const list = h('div.version-list');
  const intro = h('p', 'La app guarda automáticamente instantáneas de este documento (cada 10 minutos de trabajo, al cerrarlo y antes de borrar páginas). Restaurar una versión nunca borra la actual: antes se guarda otra instantánea.');
  const saveNow = h('button.btn.btn-outline.btn-sm', { type: 'button' }, iconEl('shield'), 'Guardar versión ahora');
  const body = h('div', intro, h('div', { style: { marginBottom: '12px' } }, saveNow), list);
  const m = openModal({ title: `Historial · ${node.name}`, body, wide: true, buttons: [{ label: 'Cerrar', value: null, variant: 'btn-ghost' }] });

  saveNow.addEventListener('click', async () => {
    saveNow.disabled = true;
    try {
      if (session) await session.snapshotNow('Manual');
      else await repo.createVersion(docId, 'Manual');
      toast('Versión guardada', { type: 'success' });
      await render();
    } finally {
      saveNow.disabled = false;
    }
  });

  async function render() {
    clear(list);
    const versions = await repo.listVersions(docId);
    if (!versions.length) {
      list.appendChild(h('p.muted', 'Todavía no hay versiones guardadas de este documento.'));
      return;
    }
    for (const v of versions) {
      const thumb = h('div', { style: { width: '54px', height: '70px', flex: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' } });
      const restore = h('button.btn.btn-outline.btn-sm', { type: 'button' }, iconEl('restore'), 'Restaurar');
      const del = h('button.btn.btn-icon.btn-sm', { type: 'button', title: 'Eliminar esta versión' }, iconEl('trash'));
      const row = h('div.version-row', thumb,
        h('div.v-text', h('div.v-title', `${formatDateTime(v.createdAt)} · ${v.reason}`), h('div.v-sub', `${timeAgo(v.createdAt)} · ${v.pageCount} página${v.pageCount === 1 ? '' : 's'} · ${v.strokeCount} trazos`)),
        restore, del);
      list.appendChild(row);
      restore.addEventListener('click', async () => {
        const ok = await confirmDialog(`El documento volverá a como estaba el ${formatDateTime(v.createdAt)}. El estado actual se guarda antes como otra versión, así que puedes volver atrás.`, { title: '¿Restaurar esta versión?', confirmLabel: 'Restaurar' });
        if (!ok) return;
        await doRestore(v);
      });
      del.addEventListener('click', async () => {
        const ok = await confirmDialog('Se eliminará esta instantánea del historial. El documento actual no cambia.', { title: '¿Eliminar versión?', confirmLabel: 'Eliminar', danger: true });
        if (!ok) return;
        await repo.deleteVersion(v.id);
        render();
      });
      // Miniatura de la primera página de la versión (en segundo plano).
      repo.loadVersionPages({ pageKeys: v.pageKeys.slice(0, 1) }).then(async pages => {
        if (!pages[0] || !thumb.isConnected) return;
        const page = normalizePageRecord(pages[0], null, docId);
        const c = await renderPageImage(page, 108);
        c.style.maxWidth = '54px';
        c.style.maxHeight = '70px';
        c.style.boxShadow = 'var(--page-shadow)';
        c.style.borderRadius = '3px';
        thumb.appendChild(c);
      }).catch(() => {});
    }
  }

  async function doRestore(v) {
    const stop = toast('Restaurando versión…', { duration: 0 });
    try {
      m.close(true);
      await app.restoreVersion(docId, v.id);
      toast('Versión restaurada', { type: 'success' });
    } catch (err) {
      console.error(err);
      toast(`No se pudo restaurar: ${err.message}`, { type: 'error' });
    } finally {
      stop();
    }
  }

  await render();
  return m.promise;
}
