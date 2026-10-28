// Envoltorio mínimo y estricto sobre IndexedDB.
// Reglas de seguridad de datos:
//  - Nunca se "cae" silenciosamente a memoria: si la base de datos no abre, se informa al usuario.
//  - Todas las escrituras resuelven solo cuando la transacción se ha confirmado (oncomplete).
//  - Las escrituras importantes usan durability 'strict' (vaciado a disco antes de confirmar).

export const DB_NAME = 'TabletStudioV2';
export const DB_VERSION = 2;

export const S = Object.freeze({
  nodes: 'nodes', // carpetas y documentos (metadatos)
  pages: 'pages', // contenido de cada página (trazos, imágenes, fondo)
  blobs: 'blobs', // binarios inmutables: PDFs originales e imágenes
  thumbs: 'thumbs', // miniaturas para la biblioteca
  versions: 'versions', // instantáneas de documentos (historial)
  pageSnaps: 'pageSnaps', // copias de páginas referenciadas por las versiones
  meta: 'meta', // ajustes internos, estado de migración, copias de seguridad
  pdfText: 'pdfText' // texto extraído de cada PDF (para buscar); se regenera si falta
});

let db = null;
let versionChangeHandler = null;

export function onVersionChange(handler) {
  versionChangeHandler = handler;
}

export function getDb() {
  if (!db) throw new Error('La base de datos no está abierta');
  return db;
}

export function isOpen() {
  return !!db;
}

function upgrade(d) {
  if (!d.objectStoreNames.contains(S.nodes)) d.createObjectStore(S.nodes, { keyPath: 'id' });
  if (!d.objectStoreNames.contains(S.pages)) {
    const st = d.createObjectStore(S.pages, { keyPath: 'id' });
    st.createIndex('docId', 'docId', { unique: false });
  }
  if (!d.objectStoreNames.contains(S.blobs)) d.createObjectStore(S.blobs, { keyPath: 'id' });
  if (!d.objectStoreNames.contains(S.thumbs)) d.createObjectStore(S.thumbs, { keyPath: 'id' });
  if (!d.objectStoreNames.contains(S.versions)) {
    const st = d.createObjectStore(S.versions, { keyPath: 'id' });
    st.createIndex('docId', 'docId', { unique: false });
  }
  if (!d.objectStoreNames.contains(S.pageSnaps)) {
    const st = d.createObjectStore(S.pageSnaps, { keyPath: 'key' });
    st.createIndex('docId', 'docId', { unique: false });
  }
  if (!d.objectStoreNames.contains(S.meta)) d.createObjectStore(S.meta, { keyPath: 'key' });
  // Versión 2: índice de texto de los PDF (datos derivados; no hace falta en las copias).
  if (!d.objectStoreNames.contains(S.pdfText)) d.createObjectStore(S.pdfText, { keyPath: 'id' });
}

export function openDatabase({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) {
      reject(Object.assign(new Error('Este navegador no permite guardar datos (IndexedDB no disponible).'), { code: 'NO_IDB' }));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('La base de datos tarda demasiado en abrir. Cierra otras pestañas de la app y vuelve a intentarlo.'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (err) {
      clearTimeout(timer);
      reject(Object.assign(new Error('El navegador bloquea el almacenamiento (¿modo incógnito o archivo local?).'), { code: 'SECURITY', cause: err }));
      return;
    }

    request.onupgradeneeded = () => {
      try {
        upgrade(request.result);
      } catch (err) {
        console.error('Error creando la estructura de la base de datos', err);
        try { request.transaction.abort(); } catch {}
      }
    };
    request.onblocked = () => {
      console.warn('Apertura de IndexedDB bloqueada por otra pestaña');
    };
    request.onerror = () => {
      clearTimeout(timer);
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('No se pudo abrir el almacenamiento local: ' + (request.error && request.error.message)), { code: 'OPEN_FAILED', cause: request.error }));
    };
    request.onsuccess = () => {
      clearTimeout(timer);
      const d = request.result;
      if (settled) {
        d.close();
        return;
      }
      settled = true;
      d.onversionchange = () => {
        d.close();
        db = null;
        if (versionChangeHandler) versionChangeHandler();
      };
      d.onclose = () => {
        // El navegador cerró la conexión (p. ej. almacenamiento borrado). Se reabrirá bajo demanda.
        db = null;
      };
      db = d;
      resolve(d);
    };
  });
}

let opening = null;

async function ensureDb() {
  if (db) return db;
  // Una sola apertura a la vez aunque lleguen varias operaciones juntas.
  if (!opening) opening = openDatabase().finally(() => { opening = null; });
  return opening;
}

/**
 * Descarta la conexión actual (p. ej. se quedó colgada tras tener la app en segundo plano).
 * La siguiente operación abre una nueva; las transacciones en curso de la vieja terminan solas.
 */
export function resetConnection() {
  const d = db;
  db = null;
  if (d) {
    d.onclose = null;
    d.onversionchange = null;
    try { d.close(); } catch {}
  }
}

// Una transacción normal tarda milisegundos. Si no termina en este tiempo, la conexión está colgada.
const STALL_MS = 20000;
// Las que mueven binarios (PDF, imágenes) pueden tardar mucho en una tablet: sin vigilante.
const HEAVY_STORES = [S.blobs];

function isStall(err) {
  return !!err && err.code === 'STALLED';
}

/**
 * Ejecuta una transacción. `body(stores, tx, fail)` debe emitir las peticiones de forma síncrona
 * (sin await dentro) y puede devolver un valor o una función que se evalúa al confirmar.
 * `fail(err)` cancela la transacción completa y hace que la promesa se rechace con `err`.
 */
export async function run(storeNames, mode, body, opts = {}) {
  try {
    return await runOnce(storeNames, mode, body, opts, await ensureDb());
  } catch (err) {
    // Conexión colgada o cerrada por el navegador: se abre una nueva y se reintenta una vez.
    // (Reintentar es seguro: las escrituras son put/delete por clave, repetirlas da el mismo resultado.)
    if (!isStall(err) && !(err && err.name === 'InvalidStateError')) throw err;
    console.warn('Base de datos sin respuesta; se reabre la conexión', err);
    resetConnection();
    try {
      return await runOnce(storeNames, mode, body, opts, await ensureDb());
    } catch (err2) {
      if (isStall(err2)) {
        resetConnection();
        throw Object.assign(new Error('El almacenamiento no responde. Cierra la app del todo (también de recientes) y vuelve a abrirla; tus apuntes siguen guardados.'), { code: 'STALLED', cause: err2 });
      }
      throw err2;
    }
  }
}

function runOnce(storeNames, mode, body, { durability, timeoutMs } = {}, d) {
  return new Promise((resolve, reject) => {
    let t;
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    try {
      t = durability ? d.transaction(names, mode, { durability }) : d.transaction(names, mode);
    } catch (err) {
      reject(err);
      return;
    }
    let result;
    let failure = null;
    let settled = false;
    const limit = timeoutMs ?? (names.some(n => HEAVY_STORES.includes(n)) ? 0 : STALL_MS);
    const watchdog = limit > 0 ? setTimeout(() => {
      if (settled) return;
      try { t.abort(); } catch {}
      finish(false, Object.assign(new Error('La base de datos no responde'), { code: 'STALLED' }));
    }, limit) : null;
    const finish = (ok, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdog);
      if (ok) resolve(value);
      else reject(value);
    };
    const fail = err => {
      if (!failure) failure = err || new Error('Operación cancelada');
      try { t.abort(); } catch {}
    };
    t.oncomplete = () => {
      if (failure) {
        finish(false, failure);
        return;
      }
      try {
        finish(true, typeof result === 'function' ? result() : result);
      } catch (err) {
        finish(false, err);
      }
    };
    t.onerror = event => {
      // Evita que el error se propague como excepción no controlada; lo gestiona onabort.
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
    };
    t.onabort = () => {
      finish(false, failure || t.error || new DOMException('Transacción cancelada', 'AbortError'));
    };
    const stores = {};
    for (const n of names) stores[n] = t.objectStore(n);
    try {
      result = body(stores, t, fail);
    } catch (err) {
      fail(err);
    }
  });
}

/** Lee todas las filas de un almacén. */
export function getAll(store, query) {
  return run(store, 'readonly', stores => {
    const req = query !== undefined ? stores[store].getAll(query) : stores[store].getAll();
    return () => req.result || [];
  });
}

export function getOne(store, key) {
  return run(store, 'readonly', stores => {
    const req = stores[store].get(key);
    return () => req.result;
  });
}

export function getAllByIndex(store, indexName, value) {
  return run(store, 'readonly', stores => {
    const req = stores[store].index(indexName).getAll(value);
    return () => req.result || [];
  });
}

export function putOne(store, value, opts) {
  return run(store, 'readwrite', stores => {
    stores[store].put(value);
    return value;
  }, opts);
}

export function deleteOne(store, key, opts) {
  return run(store, 'readwrite', stores => {
    stores[store].delete(key);
  }, opts);
}

export function getAllKeys(store) {
  return run(store, 'readonly', stores => {
    const req = stores[store].getAllKeys();
    return () => req.result || [];
  });
}

export function closeDatabase() {
  if (db) {
    db.close();
    db = null;
  }
}
