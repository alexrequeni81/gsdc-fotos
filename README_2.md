# GSDC Fotos Envíos — Mejora «catálogo» de fotos de piezas

Documento de **adaptación**, **implantación** y **plan de mejoras** del postprocesado de fotos del módulo *Piezas*.
Sustituye al antiguo chroma key por un pipeline propio (sin dependencias, 100 % en el dispositivo, gratuito) que deja la
foto en formato cuadrado, pieza centrada sobre fondo blanco y sombra suave.

> **Estado:** Fase 0 completada (ver §9). El *modo preciso* con IA está **diseñado y comentado, no activo** (Fase 2).

---

## 1. Qué cambia respecto al proyecto original

| Archivo | Cambio |
|---|---|
| `public/foto-mejora.js` | **Nuevo.** Núcleo del postprocesado. Sin dependencias, sin DOM (probable en Node). |
| `public/index.html` | Captura cuadrada con guía en *Piezas*; botón ✨ → vista previa antes/después; botón ↩ deshacer; marca `CAT`; persistencia del original; comprobación de tamaño de envío; **corrección de un `</div>` que faltaba** (ver §10). Eliminada la función `mejorarFoto` basada en chroma key. |
| `public/service-worker.js` | Precarga `/foto-mejora.js`; `CACHE_NAME` sube a `gsdc-fotos-v6`. |
| `tools/pruebas/` | **Nuevo.** Generador de escenas sintéticas y ejecutor en Node (no se despliega: está fuera de `public/`). |
| `netlify/functions/envio/*` | **Sin cambios.** |
| `public/piezas.json`, `manifest.json`, iconos | **Sin cambios.** |

### Qué ve el usuario (módulo Piezas)

1. **Tomar foto** → visor **cuadrado** con recuadro guía («Llena el recuadro con la pieza»). Lo que se ve es lo que se captura (1280 px, JPEG 0,88).
2. En la miniatura, **✨** abre la vista previa **Antes / Después** con tres modos: *Auto*, *Blanquear*, *Recortar*, y avisos de calidad.
3. **Aplicar** sustituye la foto. La miniatura muestra la marca **CAT** y el botón **↩** para volver al original.
4. **Enviar** manda la versión mejorada. El original **no** se envía (vive solo en el dispositivo y se borra al enviar o vaciar).

El módulo **Envíos** no cambia: sigue siendo 4:3, 1024 px, JPEG 0,70.

---

## 2. Compatibilidad con los datos originales

| Elemento | Impacto | Detalle |
|---|---|---|
| **IndexedDB** (`GSDCFotos`, v2) | **Sin migración** | No se sube `DB_VERSION`. Se añaden dos campos *opcionales* por foto (`original`, `mejora`). Las fotos ya guardadas se cargan igual (sin esos campos). |
| **Payload al servidor** | **Idéntico** | Cada foto sigue siendo `{ dataUrl, fecha }`. Verificado en pruebas: el cuerpo no contiene `original`. |
| **`envio.js` (Netlify Function)** | **Sin cambios** | Acepta JPEG/PNG, máx. 1,5 MB por foto, máx. 10 fotos. En las pruebas, una foto mejorada pesó ~70 KB. |
| **SharePoint (rutas, nombres)** | **Sin cambios** | Mismas carpetas y mismo esquema de nombres. Pendiente de autorización IT, como antes. |
| **`piezas.json`** | **Sin cambios** | Autocompletado y validación de códigos intactos. |
| **Clave de activación (localStorage)** | **Sin cambios** | |
| **Peso en el dispositivo** | ↑ | Una foto mejorada guarda además el original (~300 KB). Máx. 10 fotos ⇒ unos pocos MB. Se libera al enviar/vaciar. |
| **Peso del envío** | ⚠ | Las fotos de *Piezas* sin mejorar pasan de ~100-150 KB (estimación con la captura antigua) a ~300 KB (medido en una escena sintética de 1280 px). Las Netlify Functions rechazan cuerpos > ~6 MB, por eso `index.html` **avisa y bloquea** envíos > 5,5 MB (`CONFIG.maxPayloadBytes`). Las fotos mejoradas pesan mucho menos. |

**Volver al comportamiento de captura anterior** (sin visor cuadrado) en *Piezas*: en `index.html`, `CONFIG.piezas.captura = { maxLado: 1024, calidad: 0.70, cuadrada: false }`.

---

## 3. Implantación (Netlify)

Requisitos: los mismos que ya tienes. No hay `npm install`, ni build, ni variables de entorno nuevas.

1. **Copia de seguridad.** Guarda el despliegue actual (en Netlify: *Deploys* → el actual queda disponible para restaurarlo).
2. **Sustituye los archivos** del repositorio/carpeta por los de este zip (`public/`, `tools/`, `README.md`). `netlify/` no cambia.
3. **Comprueba la configuración de Netlify:** *Publish directory* = `public`, *Functions directory* = `netlify/functions` (como ya tengas).
4. **Despliega** (git push o arrastrar la carpeta).
5. **Actualiza el service worker en los móviles.** La app es una PWA con caché *primero-caché, actualiza-en-segundo-plano*: el primer arranque tras desplegar puede mostrar la versión vieja. Abre la app con conexión, ciérrala del todo y vuelve a abrirla. Si sigue la versión antigua: *Ajustes del navegador → datos del sitio → borrar* (las fotos pendientes de enviar se perderían: avisa antes).
6. **Regla de oro:** cada vez que cambies cualquier archivo estático, **sube el número de `CACHE_NAME`** en `service-worker.js` (`v6` → `v7`…).

### Lista de verificación tras desplegar

- [ ] Módulo **Piezas** → *Tomar foto*: visor **cuadrado** con recuadro punteado.
- [ ] Módulo **Envíos** → *Tomar foto*: visor 4:3 como siempre.
- [ ] En una foto de *Piezas*, **✨** abre la vista previa y **Aplicar** muestra la marca `CAT` y el botón **↩**.
- [ ] **↩** devuelve la foto original.
- [ ] Cierra y reabre la app: la foto mejorada y su ↩ siguen ahí.
- [ ] DevTools → Network: `foto-mejora.js` responde 200.
- [ ] *Enviar*: en el cuerpo de la petición cada foto solo tiene `dataUrl` y `fecha`.
- [ ] En un dispositivo **sin** clave guardada aparece el modal «Activar dispositivo» (ver §10, punto 1).

### Vuelta atrás

Netlify → *Deploys* → despliegue anterior → *Publish deploy*. Los datos del dispositivo son compatibles en ambos sentidos; la versión antigua simplemente ignora `original`/`mejora` (y los pierde al volver a guardar: las fotos quedan tal cual estén en ese momento).

---

## 4. Cómo funciona

Todo ocurre en el navegador. Se analiza una copia reducida (≤ 800 px) y el resultado final se renderiza a 1200×1200.

**Análisis del fondo.** Se agrupan (k-means, ≤ 3 grupos) los colores del borde de la imagen en espacio Lab. Eso modela suelos con paredes (gaveta) o degradados de luz. Se calcula si el fondo es **claro** (L ≥ 72, croma ≤ 22) y **uniforme**.

**Segmentación (`recortar`).** *Region-growing* desde el borde: un píxel es fondo si se parece a algún grupo del modelo, o si es un vecino casi idéntico a un píxel ya aceptado (sigue degradados de iluminación, con tope). Después: se eliminan motas, se suaviza, se calcula un alfa suave y se descontamina el halo del color del fondo. La **tolerancia se adapta al ruido** de cada foto. Los agujeros pasantes (tornillos, orificios) se dejan en blanco.

**`blanquear`.** Solo con fondo claro y liso. Se estima el mapa de iluminación del fondo y se divide la imagen por él (corrige exposición y balance de blancos); el casi-blanco pasa a blanco **solo en zonas de fondo**, de modo que se conservan la sombra natural y los detalles claros de la pieza. No hay bordes recortados.

**Encuadre.** Recorte cuadrado centrado en la pieza (margen 9 %), con ampliación limitada (×1,6) para no pixelar.

**Auto.** Fondo claro y uniforme → `blanquear`; en cualquier otro caso → `recortar`. `blanquear` queda deshabilitado en fondos oscuros o de color (daría resultados inservibles).

**Calidad.** Se evalúa: fracción de pieza detectada, si toca los bordes, uniformidad del fondo y contraste. Niveles `ok` / `dudosa` / `mala`, con el aviso en la vista previa. Con `mala` no se recorta el encuadre y el botón pasa a «Aplicar de todos modos». El usuario siempre decide y puede deshacer.

---

## 5. Guía de captura por superficie

La calidad del resultado depende más de **cómo se hace la foto** que del algoritmo.

| Superficie | Modo previsto | Esperable | Consejos |
|---|---|---|---|
| **Cartulina blanca / gris claro** (recomendado) | `blanquear` | Muy bueno, aspecto catálogo | Cartulina **curvada** (sin arista entre mesa y pared) y luz difusa lateral. Una cartulina o una caja de luz plegable de bajo coste es la mejora con mejor relación calidad/precio. |
| **Tapete de goma verde oscuro** | `recortar` | Bueno con piezas metálicas, claras o de color | Evitar reflejos de la luz en la goma. **Piezas negras o verde oscuro**: poco contraste, el aviso saltará. Mejor colocar una cartulina clara debajo. |
| **Gaveta azul** | `recortar` | Aceptable si la pieza queda lejos de las paredes | Llenar el recuadro guía pero sin tocar las paredes. Saldrá el aviso de «fondo no uniforme» (es informativo). Piezas azules: fallarán. |
| **Estantería** (piezas voluminosas) | `recortar` | **Poco fiable**: fondo con listones, pieza que toca los bordes | Si es posible, sacar la pieza a la mesa. Si no, usar la foto original (no pulsar ✨) o esperar al modo preciso (Fase 2). |

Reglas generales: pieza centrada, ocupando ~70-85 % del recuadro; que **no toque los bordes**; luz difusa (sin sombras duras); fondo lo más distinto posible de la pieza en color y luminosidad.

---

## 6. Parámetros ajustables

Todo lo ajustable está en `CONFIG` (`index.html`) y en `DEFAULTS` (`foto-mejora.js`). **Cualquier clave de `DEFAULTS` puede ponerse en `CONFIG.piezas.mejora`** y la sustituye.

| Parámetro | Valor | Qué hace |
|---|---|---|
| `piezas.captura.maxLado` | 1280 | Lado del cuadrado capturado (px). |
| `piezas.captura.calidad` | 0,88 | Calidad JPEG de captura. |
| `piezas.captura.cuadrada` | `true` | Visor 1:1 con guía; `false` = comportamiento antiguo. |
| `mejora.salida` | 1200 | Lado de la imagen final (px). |
| `mejora.calidadJpeg` | 0,90 | Calidad JPEG de la imagen final. |
| `mejora.margen` | 0,09 | Aire alrededor de la pieza (fracción). Subir si se recortan sombras. |
| `mejora.sombra` | 0,8 | 0 = sin sombra; 1 = sombra normal. |
| `zoomMax` | 1,6 | Ampliación máxima del recorte sobre los píxeles originales. |
| `pesoL` | 0,4 | Peso de la luminosidad al decidir «es fondo». Más bajo = las sombras cuentan como fondo; más alto = separa mejor piezas oscuras sobre fondo oscuro, pero deja el flequillo de la sombra. |
| `tolMin` / `tolMax` | 10 / 30 | Rango de tolerancia ΔE. Subir `tolMin` si «se come» poco fondo; bajarlo si se come pieza. |
| `tolLocal` | 3,0 | Salto máximo entre vecinos al seguir degradados. Más alto = más riesgo de «colarse» en la pieza. |
| `huecosBlancos` | `true` | Agujeros pasantes en blanco. |
| `encuadrar` | `true` | Recorte cuadrado centrado en la pieza. |
| `maxPayloadBytes` | 5,5 MB | Límite local de envío (la plataforma rechaza ~6 MB). |

---

## 7. Estado de las pruebas (lo que se ha probado y lo que no)

**Probado:**
- Pipeline en Node con **5 escenas sintéticas** (`tools/pruebas/`): tapete verde, banco claro con degradado, gaveta azul con paredes, pieza negra sobre verde, estantería con listones y pieza amarilla.
- Flujo completo en **Chromium headless** con cámara simulada: visor cuadrado, captura 1080×1080, vista previa, aplicar, deshacer, persistencia en IndexedDB, y que el cuerpo del envío solo contiene `dataUrl` y `fecha`.
- Tiempos en escritorio: análisis ~0,3-0,6 s; recomponer al cambiar de modo ~0,2-0,6 s.

**NO probado (pendiente, ver Fase 1):**
- **Fotos reales** de vuestras piezas y superficies. Las escenas sintéticas validan la mecánica, **no** la calidad real: aluminio brillante, goma con reflejos, ruido de sensor con poca luz, etc. se comportan distinto.
- **Móviles reales** (Android Chrome, iOS Safari): rendimiento y memoria. En móviles se espera que sea varias veces más lento que en escritorio (estimación, no medida).
- Despliegue real en Netlify y subida a SharePoint (pendiente de autorización IT).

---

## 8. Limitaciones conocidas

- **Poco contraste** pieza/fondo (negro sobre verde oscuro, gris sobre estantería gris, pieza azul en gaveta azul): puede comerse partes. El aviso salta, pero el criterio es una heurística.
- **Piezas transparentes, muy reflectantes o con huecos grandes** (mallas, rejillas): la máscara será imprecisa.
- **Piezas que tocan el borde del encuadre**: no se pueden separar bien.
- **Fondos heterogéneos** (estantería): el modelo de fondo por color no basta → Fase 2.
- **Sombra sintética**: es un suavizado genérico bajo la pieza; no replica la sombra real.
- `blanquear` con **pieza blanca sobre fondo blanco** pierde contraste (no hay separación posible por color).
- La orientación EXIF no se trata (las fotos salen del `canvas` de vídeo, no de ficheros, así que no aplica hoy; sí lo haría si se añade «subir desde galería»).

---

## 9. Plan de mejoras

Cada fase tiene su criterio de éxito. Las decisiones pendientes están marcadas con **[DECIDIR]**.

### Fase 0 — Base (hecha)
- [x] Captura cuadrada con guía y mayor resolución en *Piezas*.
- [x] Pipeline `blanquear` / `recortar` / `auto`, con aviso de calidad.
- [x] Vista previa antes/después, deshacer, persistencia del original.
- [x] Control de tamaño de envío.
- [x] Escenas de prueba reproducibles (`tools/pruebas/`).
- [x] Corrección del `</div>` que dejaba oculto el modal de activación.

### Fase 1 — Validar con fotos reales (siguiente, 1-2 semanas)
- [ ] Recoger **~30 fotos reales** (10 por superficie: tapete, gaveta, estantería) con piezas variadas (brillantes, oscuras, claras, voluminosas).
- [ ] Probarlas con la app y anotar: ¿aceptable sin tocar? ¿aceptable con otro modo? ¿inservible?
- [ ] Ajustar `tolMin`, `pesoL`, `margen`, `zoomMax` según resultados. Documentar los valores finales aquí.
- [ ] Medir tiempos en **2-3 móviles reales** (gama baja incluida) y en iOS Safari.
- [ ] **[DECIDIR]** Si se compra cartulina / caja de luz para la mesa (probablemente suba mucho el porcentaje de fotos buenas).
- **Éxito:** ≥ 80 % de las fotos en mesa aceptables a la primera; tiempo de vista previa < 4 s en el móvil más lento.

### Fase 2 — Modo preciso por toque (diseñado, comentado, **no activo**)
Para fondos difíciles (estantería, pieza oscura sobre fondo oscuro). El usuario toca la pieza y un modelo de segmentación devuelve la máscara.
- Esqueleto comentado en `index.html` («FASE 2») y chip «🎯 Preciso» comentado en `#mejoraChips`.
- **Punto de enganche ya implementado:** `FotoMejora.construirAnalisisDesdeMascara(small, lab, fondo, mascaraBinaria, opciones)`. Cualquier máscara externa reutiliza limpieza, encuadre, sombra y composición.
- Candidatos (en el dispositivo, sin enviar fotos a terceros): **SlimSAM / MobileSAM** vía Transformers.js (segmentación por toque), o **U²-Net / IS-Net** vía onnxruntime-web (recorte automático).
- Requisitos y riesgos a resolver antes de activarlo:
  - [ ] **[DECIDIR] Licencias.** Verificar la licencia vigente del modelo y de la librería para uso corporativo. Evitar sin revisar: `@imgly/background-removal` (AGPL) y los modelos RMBG de Bria (uso no comercial).
  - [ ] **Descarga del modelo:** decenas de MB; solo al pulsar «Preciso», con indicador de progreso y aviso de uso de datos móviles.
  - [ ] **Service worker:** no precachear el modelo en `STATIC_ASSETS`; permitir su caché en tiempo de ejecución.
  - [ ] **CSP / red de empresa:** permitir `cdn.jsdelivr.net` y `huggingface.co` (o alojar modelo y librería en el propio Netlify; entonces cuidar los límites de tamaño).
  - [ ] **Rendimiento en móvil:** medir; ejecutar en Web Worker (Fase 3).
  - [ ] **Fijar versiones** de librería y modelo (no usar `latest`).
- **Éxito:** ≥ 90 % de aceptables en estantería con un toque; < 10 s en móvil medio.

### Fase 3 — Robustez y rendimiento
- [ ] Mover el análisis y la composición a un **Web Worker** (la interfaz no se congela en móviles lentos).
- [ ] Barra de progreso real en la vista previa.
- [ ] Opción «sin sombra» y «sin recorte» visibles en la vista previa.
- [ ] Si se añade «subir desde galería»: tratar orientación EXIF y fotos > 12 MP.
- [ ] Pruebas automáticas en CI con las fotos reales de Fase 1 (anonimizadas) y umbrales de regresión.

### Fase 4 — Integración con SharePoint (cuando IT autorice)
- [ ] **[DECIDIR]** Subir también el **original** (p. ej. subcarpeta `originales/`) junto a la versión catálogo. Requiere cambios en `envio.js` (el payload hoy no incluye el original).
- [ ] **[DECIDIR]** Convención de nombre para distinguir catálogo y original (`_cat`).
- [ ] Guardar en metadatos o nombre el método y la calidad (`mejora.metodo`, `mejora.calidad`), que la app ya conoce.

### Fase 5 — Mantenimiento
- [ ] Consolidar `piezas.json` en una única fuente (hoy hay dos copias idénticas; ver §10).
- [ ] Automatizar la subida de `CACHE_NAME` (p. ej. con el hash del commit).
- [ ] Documentar el procedimiento de actualización de `piezas.json`.

---

## 10. Observaciones sobre el código original

Detectadas durante la revisión. La n.º 1 está **corregida**; el resto se **dejan como estaban** (no eran parte del encargo) y se recomienda valorarlas.

1. **`</div>` sin cerrar en `#validacionModal`** *(corregido)*. Dejaba `#authModal` («Activar dispositivo») anidado dentro de un contenedor con `display: none`, de modo que en un dispositivo sin clave guardada ese modal **no era visible**. También habría ocultado el modal nuevo de mejora. *Si en producción sí lo ves aparecer, tu despliegue difiere del zip: compáralo.*
2. **Tocar una miniatura la elimina sin confirmación** (`item.addEventListener('click', … eliminarFoto)`). Con los botones ✨ y ↩ pegados a la miniatura aumenta el riesgo de un toque accidental. Valorar una confirmación o quitar ese comportamiento.
3. **Service worker.** (a) En cada carga se *des-registran* todos los service workers y se vuelve a registrar el mismo. (b) El comentario dice «red primero», pero el código devuelve la caché si existe y actualiza en segundo plano: los cambios aparecen en la **segunda** carga. Por eso importa subir `CACHE_NAME`.
4. **Límite de ~6 MB por petición** a las Netlify Functions. Con 10 fotos grandes se supera; ya hay una comprobación local, pero conviene recordarlo si se sube la resolución.
5. **`piezas.json` duplicado** en `netlify/functions/envio/` y `public/` (hoy idénticos, 31 360 bytes). Riesgo de que se desincronicen al actualizar uno solo.

---

## 11. Estructura del proyecto

```
netlify/functions/envio/   envio.js, piezas.json          (sin cambios)
public/
  index.html               app (modificado)
  foto-mejora.js           núcleo del postprocesado        (nuevo)
  service-worker.js        caché PWA                       (modificado: v6)
  manifest.json, icon-*.svg, piezas.json                   (sin cambios)
tools/pruebas/             generar_escenas.py, ejecutar.js, montaje.py   (no se despliega)
README.md                  este documento
```

### Ejecutar las pruebas sintéticas

```bash
cd tools/pruebas
python3 generar_escenas.py                                   # numpy + pillow
node ejecutar.js A_verde B_claro C_azul D_negra_verde E_estanteria
python3 montaje.py montaje.png A_verde B_claro C_azul D_negra_verde E_estanteria
```

Genera `escenas/` con las imágenes originales y los resultados de cada método, y un montaje `original | blanquear | recortar`.
