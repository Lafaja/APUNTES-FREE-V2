// Guardar o compartir archivos generados por la app (PDF, imágenes, copias de seguridad).

export function canShareFiles() {
  try {
    return !!(navigator.canShare && navigator.canShare({ files: [new File(['x'], 'x.txt', { type: 'text/plain' })] }));
  } catch {
    return false;
  }
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 60000);
}

export async function shareBlob(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type || 'application/octet-stream' });
  await navigator.share({ files: [file], title: title || filename });
}

/**
 * Guarda con el selector nativo si existe (el usuario elige carpeta), si no, descarga.
 * Devuelve 'saved' | 'downloaded' | 'cancelled'.
 */
export async function saveBlob(blob, filename, { description = 'Archivo', accept = null } = {}) {
  if (typeof window.showSaveFilePicker === 'function' && window.self === window.top) {
    try {
      const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '';
      const types = accept ? [{ description, accept }] : ext ? [{ description, accept: { [blob.type || 'application/octet-stream']: [ext] } }] : undefined;
      const handle = await window.showSaveFilePicker({ suggestedName: filename, types });
      const w = await handle.createWritable();
      await w.write(blob);
      await w.close();
      return 'saved';
    } catch (err) {
      if (err && err.name === 'AbortError') return 'cancelled';
      console.warn('Selector de guardado no disponible, se descarga el archivo', err);
    }
  }
  downloadBlob(blob, filename);
  return 'downloaded';
}
