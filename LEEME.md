# Tablet Studio 2 (APUNTES-FREE-V2)

Versión reescrita de la app de apuntes. Son archivos estáticos: no hay que compilar nada.

## Publicar en GitHub Pages
1. Crea un repositorio nuevo en la cuenta `Lafaja` (recomendado: `APUNTES-FREE-V2`).
   Quedará en `https://lafaja.github.io/APUNTES-FREE-V2/`, el **mismo dominio** que la versión
   anterior, así la app nueva puede **importar tus apuntes antiguos** (solo los lee, no los toca).
2. Sube **todo el contenido de esta carpeta** (incluida `libs/`) a la raíz del repositorio y activa
   Pages (Settings → Pages → rama `main`, carpeta `/`).
3. Abre la URL en la tablet: aparecerá «Tus apuntes de la versión anterior» → **Importar ahora**.
   Si pulsas «Ahora no», puedes hacerlo luego en Ajustes → «Datos de la versión anterior».
4. Instálala (menú del navegador → «Instalar aplicación» / «Añadir a pantalla de inicio»): así el
   navegador protege el almacenamiento y funciona sin conexión.

La versión anterior sigue funcionando en su URL; puedes usar las dos a la vez mientras pruebas.

## Al publicar cambios
Sube el número de versión en `sw.js` (`VERSION`) y en `js/core/version.js`. La app mostrará
«Hay una nueva versión» y se actualizará guardando antes todo lo pendiente.

## Buscar y pantalla dual
- **Buscar en el PDF** (lupa de la barra o Ctrl+F): resalta todas las coincidencias y salta entre
  ellas con ▲ ▼ o Intro / Mayús+Intro. No distingue mayúsculas ni acentos.
- **Buscar desde la biblioteca**: además de por nombre, encuentra los PDF que contienen el texto,
  con un fragmento de cada uno; al tocarlo se abre en esa coincidencia. La primera vez cada PDF se
  prepara en segundo plano (se pausa mientras escribes en el editor). Los PDF escaneados (solo
  imagen) no tienen texto que buscar.
- **Pantalla dual** (botón de las dos columnas, o «+ Nuevo → Pantalla dual…»): dos documentos, o
  dos partes del mismo, a la vez. Lado a lado o uno encima del otro (automático según el giro),
  con divisor ajustable (doble toque = 50 %), intercambio de paneles y cambio de documento de cada
  panel. Al recargar se conservan los dos.

## Organizar y navegar
- **Favoritos**: menú ⋮ de un documento o carpeta → «Añadir a favoritos» (o varios a la vez con
  «Seleccionar»). Aparecen en la pestaña «Favoritos» de la biblioteca.
- **Arrastrar a carpetas**: con ratón, arrastra; con el dedo o el lápiz, mantén pulsado hasta que
  la tarjeta «se levante» y arrástrala a una carpeta o a la ruta de arriba. Se puede deshacer.
- **Pestañas**: cada documento que abres queda como pestaña encima de la barra (aparecen cuando
  hay dos o más). «+» abre otro; la «x» cierra la pestaña (no borra nada).
- **Marcadores de página**: el marcador de la barra marca la página que ves (cinta roja).
  Botón de páginas → pestaña «Marcadores».
- **Índice del PDF**: botón de páginas → «Índice del PDF» (si el PDF lo trae). Los enlaces internos
  del PDF se siguen tocando con el dedo (cuando el dedo desplaza) o con Ctrl+clic; aparece «Volver».
- **Formas perfectas**: al acabar un trazo, deja el lápiz quieto medio segundo y la línea, círculo,
  elipse, rectángulo, triángulo o polígono regular se vuelve perfecto. Se desactiva en Ajustes.

## Copia en Google Drive (opcional)
Ajustes → «Copia en Google Drive» → «Configurar…». Google exige un «ID de cliente» propio (gratis):
1. En https://console.cloud.google.com/ crea un proyecto.
2. «APIs y servicios → Biblioteca» → «Google Drive API» → Habilitar.
3. «Pantalla de consentimiento de OAuth»: tipo Externo; en «Usuarios de prueba» añade tu Gmail.
4. «Credenciales → Crear credenciales → ID de cliente de OAuth» → «Aplicación web». En «Orígenes de
   JavaScript autorizados» añade `https://lafaja.github.io` (y `http://localhost:5511` para pruebas).
5. Pega el ID (termina en `.apps.googleusercontent.com`) en la app y pulsa «Guardar y conectar».

La app solo ve las copias que ella misma crea (permiso `drive.file`). Guarda las 10 más recientes en
la carpeta «Tablet Studio - copias»; las antiguas van a la papelera de Drive. Sin servidor, la sesión
de Google dura ~1 hora: si caducó, la biblioteca muestra un aviso y basta un toque. «Restaurar desde
Google Drive» recupera una copia en otro dispositivo sin sobrescribir nada.

## Qué protege tus datos
- Guardado automático por página (unos cientos de ms después de cada trazo); si algo falla se
  reintenta y lo verás en el icono de la nube.
- Papelera: nada se borra definitivamente sin pasar por ella.
- Historial de versiones por documento (menú ⋯ → Historial): cada 10 min de trabajo, al cerrar y
  antes de borrar páginas. Restaurar también se puede deshacer.
- Copias de seguridad .zip (Ajustes → Copias de seguridad). En Windows con Chrome/Edge, copia
  automática en una carpeta (por ejemplo, una de OneDrive). Se restauran sin sobrescribir nada.
- Almacenamiento persistente solicitado al navegador.

## Estructura
- `index.html`, `css/app.css`, `sw.js`, `manifest.webmanifest`
- `js/core` (base de datos, copias, migración), `js/model` (documento, trazos, papel),
  `js/render` (tinta, PDF, imágenes), `js/editor` (visor, herramientas, gestos),
  `js/library`, `js/dialogs`, `js/export`, `js/ui`
- `libs/`: pdf.js 6.3 (Mozilla, Apache-2.0), pdf-lib 1.17 (MIT), perfect-freehand 1.2 (MIT)
