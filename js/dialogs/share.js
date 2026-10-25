// Diálogo «Compartir apunte (.tstudio)»: prepara el archivo y luego deja compartirlo o guardarlo
// (compartir necesita un toque nuevo del usuario, por eso va en un segundo paso).

import { buildShareFile, SHARE_MIME } from '../core/share.js';
import { formatBytes } from '../core/util.js';
import { saveBlob } from '../export/save.js';
import { h, iconEl } from '../ui/dom.js';
import { openModal, alertDialog } from '../ui/modal.js';
import { toast } from '../ui/toast.js';

function canShareFile(file) {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [file] }));
  } catch {
    return false;
  }
}

export async function openShareDialog(docIds) {
  const stop = toast('Preparando el archivo…', { duration: 0 });
  let res;
  try {
    res = await buildShareFile(docIds);
  } catch (err) {
    console.error(err);
    await alertDialog(`No se pudo preparar el archivo: ${err.message || err}`, 'Error');
    return null;
  } finally {
    stop();
  }
  const file = new File([res.blob], res.name, { type: SHARE_MIME });
  const shareable = canShareFile(file);
  const what = res.docs === 1 ? 'el apunte' : `los ${res.docs} apuntes`;

  const body = h('div',
    h('div.banner.info', { style: { margin: '0 0 12px' } }, iconEl('check'), h('div.banner-text', h('strong', res.name), formatBytes(res.blob.size))),
    h('p', `Quien lo reciba con Tablet Studio podrá abrir ${what} y seguir escribiendo como si fuera suyo: lleva los trazos, las imágenes y el PDF original. Su copia es independiente de la tuya.`),
    h('p.hint', shareable
      ? 'Para abrirlo: en la app, botón «+» → «Importar apunte compartido». En Android también puede pulsar Compartir → Tablet Studio desde WhatsApp o el correo.'
      : 'Guárdalo y envíalo como documento adjunto (WhatsApp, correo, Drive…). Para abrirlo: en la app, botón «+» → «Importar apunte compartido».'));

  const buttons = [{ label: 'Cerrar', value: null, variant: 'btn-ghost' }];
  buttons.push({
    label: 'Guardar',
    icon: 'download',
    variant: shareable ? 'btn-outline' : 'btn-primary',
    value: true,
    onClick: async () => {
      const r = await saveBlob(res.blob, res.name, { description: 'Apunte de Tablet Studio', accept: { [SHARE_MIME]: ['.tstudio'] } });
      if (r === 'cancelled') return false;
      toast(r === 'saved' ? 'Archivo guardado' : 'Descarga iniciada', { type: 'success' });
      return true;
    }
  });
  if (shareable) {
    buttons.push({
      label: 'Compartir…',
      icon: 'share',
      variant: 'btn-primary',
      value: true,
      onClick: async () => {
        try {
          await navigator.share({ files: [file], title: res.name });
          return true;
        } catch (err) {
          if (err && err.name !== 'AbortError') toast(`No se pudo compartir: ${err.message}`, { type: 'error' });
          return false;
        }
      }
    });
  }
  return openModal({ title: res.docs === 1 ? 'Compartir apunte' : 'Compartir apuntes', body, buttons }).promise;
}
