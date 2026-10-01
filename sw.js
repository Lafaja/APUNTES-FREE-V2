// Service worker de Tablet Studio 2: funcionamiento sin conexión y actualizaciones seguras.
//
// AL PUBLICAR CAMBIOS: sube VERSION (y APP_VERSION en js/core/version.js). Así la app detecta la
// nueva versión y ofrece «Actualizar» (guardando antes todo lo pendiente).

const VERSION = '2.3.0';
const PREFIX = 'tablet-studio-v2-';
const CACHE = `${PREFIX}${VERSION}`;
const RUNTIME = `${PREFIX}runtime`;

const PRECACHE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/app.css',
  './js/main.js',
  './js/core/backup.js',
  './js/core/db.js',
  './js/core/events.js',
  './js/core/gdrive.js',
  './js/core/migrate.js',
  './js/core/repo.js',
  './js/core/settings.js',
  './js/core/textindex.js',
  './js/core/util.js',
  './js/core/version.js',
  './js/core/zip.js',
  './js/dialogs/basic.js',
  './js/dialogs/drive.js',
  './js/dialogs/export.js',
  './js/dialogs/import-pdf.js',
  './js/dialogs/migration.js',
  './js/dialogs/pages.js',
  './js/dialogs/settings.js',
  './js/dialogs/versions.js',
  './js/editor/editor.js',
  './js/editor/input.js',
  './js/editor/recognize.js',
  './js/editor/search.js',
  './js/editor/selection.js',
  './js/editor/tabs.js',
  './js/editor/toolbar.js',
  './js/editor/tools.js',
  './js/editor/viewer.js',
  './js/export/pdf-export.js',
  './js/export/save.js',
  './js/library/library.js',
  './js/model/paper.js',
  './js/model/session.js',
  './js/model/stroke.js',
  './js/render/images.js',
  './js/render/ink.js',
  './js/render/pdf.js',
  './js/render/pdfnav.js',
  './js/render/thumbs.js',
  './js/ui/colorpicker.js',
  './js/ui/dom.js',
  './js/ui/icons.js',
  './js/ui/modal.js',
  './js/ui/popover.js',
  './js/ui/toast.js',
  './libs/pdfjs/pdf.min.mjs',
  './libs/pdfjs/pdf.worker.min.mjs',
  './libs/pdf-lib/pdf-lib.esm.min.js',
  './libs/perfect-freehand/index.mjs',
  './icons/logo.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-64.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // addAll es atómico: si algo falla, esta versión no se instala y sigue la anterior (nunca queda a medias).
    await cache.addAll(PRECACHE.map(url => new Request(url, { cache: 'reload' })));
    const keys = await caches.keys();
    const hasPreviousV2 = keys.some(k => k.startsWith(PREFIX) && k !== CACHE && k !== RUNTIME);
    // Primera instalación (o viniendo de la versión 1): activar ya. Actualizaciones de la v2: esperar a
    // que el usuario pulse «Actualizar» para no cambiar el código en mitad de una sesión.
    if (!hasPreviousV2) await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    // Solo se borran cachés PROPIAS antiguas (en el mismo dominio puede haber otras apps).
    await Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE && k !== RUNTIME).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', event => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function isRuntimeAsset(url) {
  return /\/libs\/pdfjs\/(cmaps|standard_fonts|wasm|iccs)\//.test(url.pathname);
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;

  // Navegación: siempre la app (index.html) desde la caché, para que abra sin conexión.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      const cached = await caches.match('./index.html', { cacheName: CACHE });
      if (cached) return cached;
      try {
        return await fetch(req);
      } catch {
        return new Response('<h1>Sin conexión</h1><p>Abre la app una vez con conexión para instalarla.</p>', { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    })());
    return;
  }

  if (isRuntimeAsset(url)) {
    event.respondWith((async () => {
      const cache = await caches.open(RUNTIME);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  event.respondWith((async () => {
    const hit = await caches.match(req, { cacheName: CACHE, ignoreSearch: true });
    if (hit) return hit;
    try {
      return await fetch(req);
    } catch (err) {
      const any = await caches.match(req, { ignoreSearch: true });
      if (any) return any;
      throw err;
    }
  })());
});
