# ðŸ“· Fotos EnvÃ­os GSDC

Web PWA para capturar y enviar fotografÃ­as de envÃ­os directamente a **SharePoint Online**, sin correos intermedios, sin credenciales corporativas compartidas y sin conectores premium.

El operario abre la web desde el mÃ³vil, escribe el destinatario (ej.: *Jefferson, Fresno*), toma hasta **10 fotos** y pulsa **Enviar**. Las fotos se guardan automÃ¡ticamente en SharePoint en:

```
Documentos compartidos / General / InformaciÃ³n entre ALZ y BDN / FotosEnvios / {Destinatario} / {AAAAMMDD}
```

cada una con el nombre `AAAAMMDD_HHMMSS_00N_Destinatario.jpg` (fecha de captura + nÃºmero de foto + destinatario).

---

## Flujo de funcionamiento

```
MÃ³vil (app PWA)
   â”‚ 1. Toma y comprime las fotos; escribe destinatario
   â–¼
Netlify Function "envio"
   â”‚ 2. Se identifica ante Microsoft (app GSDC-Fotos, OAuth2 client-credentials)
   â”‚ 3. Crea la carpeta si no existe en SharePoint
   â–¼
Microsoft 365 (SharePoint Online)
   â”‚ 4. Sube cada foto con su nombre de archivo
   â–¼
Carpeta FotosEnvios en SharePoint âœ…  (todo automÃ¡tico, en segundos)
```

No interviene ninguna persona ni herramienta adicional en el proceso.

---

## Stack

| Capa | TecnologÃ­a |
|---|---|
| Frontend | HTML + CSS + JavaScript nativo (sin frameworks), PWA |
| CachÃ© offline | Service Worker (`public/service-worker.js`, cache `gsdc-fotos-v5`) |
| Borradores | IndexedDB (recupera fotos si se cierra la pestaÃ±a) |
| Hosting | Netlify (plan Free), despliegue por **Netlify CLI** |
| Backend | **Netlify Function**: `netlify/functions/envio/envio.js` (Node 18+, `fetch` nativo) |
| Identidad | Microsoft Entra ID (Azure AD), app **`GSDC-Fotos`**, OAuth2 **client-credentials** |
| Destino | SharePoint Online â€” sitio `GLOBALSPARESDISTRIBUTIONCENTER`, biblioteca *Documentos compartidos* |

---

## Estructura del proyecto

```
gsdc/
â”œâ”€â”€ netlify.toml                     â† configuraciÃ³n de build de Netlify
â”œâ”€â”€ public/                          â† webapp (estÃ¡ticos desplegados)
â”‚   â”œâ”€â”€ index.html                   â† aplicaciÃ³n PWA completa
â”‚   â”œâ”€â”€ service-worker.js            â† cachÃ© offline
â”‚   â”œâ”€â”€ manifest.json                â† metadatos PWA
â”‚   â”œâ”€â”€ icon-192.svg                 â† icono
â”‚   â””â”€â”€ icon-512.svg                 â† icono
â””â”€â”€ netlify/
    â””â”€â”€ functions/
        â””â”€â”€ envio/
            â””â”€â”€ envio.js             â† funciÃ³n backend (autenticaciÃ³n + subida a SharePoint)
```

---

## AplicaciÃ³n (frontend) â€” `public/index.html`

- **Captura:** cÃ¡mara del dispositivo; cada foto se redimensiona a ~1024 px y se codifica **JPEG calidad 0.7** para reducir peso.
- **Salvaguarda:** las fotos se guardan en IndexedDB como borrador mientras la app estÃ¡ abierta.
- **EnvÃ­o:** `POST /.netlify/functions/envio` con JSON:
  ```json
  {
    "destinatario": "Jefferson",
    "fotos": [
      { "dataUrl": "data:image/jpeg;base64,...", "fecha": "2026-09-05 10:15:30" }
    ]
  }
  ```
- **Health check al cargar:** `GET /.netlify/functions/envio`. Si la conexiÃ³n con SharePoint no estÃ¡ activa, la app muestra el modal **"Pendiente autorizaciÃ³n IT"** (no bloqueante). Si se intenta enviar sin autorizaciÃ³n, se muestra el mismo aviso amigable y las fotos permanecen en pantalla para reintentar.
- Los mensajes de estado distinguen dos fallos:
  - **Falta consentimiento de administrador** (respuesta 401/403/consent de Graph) â†’ *"Pendiente autorizaciÃ³n IT"*.
  - **Error de configuraciÃ³n** â†’ aviso genÃ©rico de que IT debe revisar la conexiÃ³n.

## Service Worker â€” `public/service-worker.js`

- Precarga estÃ¡ticos (`/`, `index.html`, `manifest.json`, iconos).
- Estrategia: **red primero con fallback a cachÃ©**.
- Las llamadas a funciones Netlify (`/.netlify/functions/`) **no se cachean**, para que el estado de conexiÃ³n se consulte siempre fresco.

## Backend â€” `netlify/functions/envio/envio.js`

1. Valida campos (destinatario obligatorio, mÃ¡x. 10 fotos).
2. Obtiene token **OAuth2 client-credentials** contra Entra ID
   (`login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`).
3. Resuelve el **drive** del sitio (Graph: `/sites/{host}:/{path}:/drive`).
4. **Crea carpetas** si faltan (`FotosEnvios/{Destinatario}/{AAAAMMDD}`).
5. **Sube cada foto** (`PUT .../drive/root:/.../:{nombre}:/content`, `conflictBehavior=replace`).
6. Devuelve `{ ok, subidos: [], fallidos: [] }` (errores por foto, no bloqueantes).

AdemÃ¡s expone un **health check** en `GET` que devuelve:

```json
{ "listo": false, "consentimiento": true, "motivo": "Pendiente autorizaciÃ³n de IT" }
```

---

## ConfiguraciÃ³n de Netlify

### Variables de entorno requeridas

Definidas en el panel de Netlify (*Site settings â†’ Environment variables*) y **no en el cÃ³digo**:

| Variable | DescripciÃ³n |
|---|---|
| `TENANT_ID` | Id. de directorio (tenant) de Microsoft Entra |
| `CLIENT_ID` | Id. de aplicaciÃ³n (app registration `GSDC-Fotos`) |
| `CLIENT_SECRET` | Secreto de cliente de la app (confidencial) |
| `SITE_HOST` | Host del sitio SharePoint (ej. `grupogiro.sharepoint.com`) |
| `SITE_PATH` | Ruta del sitio (ej. `sites/GLOBALSPARESDISTRIBUTIONCENTER`) |
| `BASE_FOLDER` | Carpeta base en la biblioteca (default: `General/InformaciÃ³n entre ALZ y BDN/FotosEnvios`) |
| `ALLOWED_ORIGIN` | Dominio permitido en CORS (default: `https://willowy-cranachan-417c2c.netlify.app`) |
| `ALLOWED_IPS` | (opcional) Allowlist de IP del backend: lista separada por comas de IPs o rangos CIDR que pueden llamar a la funciÃ³n. VacÃ­o/sin definir = abierto (comportamiento actual) |
| `APP_TOKEN` | Clave de activaciÃ³n del dispositivo (la app la envÃ­a en la cabecera `X-App-Token`). Si se rota, los dispositivos con la clave antigua dejan de funcionar |

### Despliegue con Netlify CLI

```bash
netlify deploy --prod --site <SITE_ID> --dir public
```

`netlify.toml` ya configura `functions = "netlify/functions"` y `publish = "public"`.

---

## ConfiguraciÃ³n de SharePoint y lÃ³gica de archivos

### DÃ³nde vive la configuraciÃ³n de SharePoint

El destino SharePoint **no se fija en ningÃºn archivo del repositorio**: vive en las **variables de entorno de Netlify** y la funciÃ³n la lee en tiempo de ejecuciÃ³n.

Puntos de lectura en `netlify/functions/envio/envio.js`:

| Variable | DÃ³nde se lee | Default si falta |
|---|---|---|
| `SITE_HOST` | `getDriveId()` â€” lÃ­nea 156 | `grupogiro.sharepoint.com` |
| `SITE_PATH` | `getDriveId()` â€” lÃ­nea 157 | `sites/GLOBALSPARESDISTRIBUTIONCENTER` |
| `BASE_FOLDER` | handler `POST` â€” lÃ­neas 260-261 | `General/InformaciÃ³n entre ALZ y BDN/FotosEnvios` |
| `ALLOWED_ORIGIN` | handler â€” lÃ­nea 208 | `https://willowy-cranachan-417c2c.netlify.app` |

La biblioteca *Documentos compartidos* del sitio se resuelve con el endpoint de Graph `/sites/{SITE_HOST}:/{SITE_PATH}:/drive` en `getDriveId()` (lÃ­neas 155-163).

> Si IT quisiera apuntar a otro sitio o a otra carpeta raÃ­z, **no hace falta tocar cÃ³digo**:
> basta cambiar estas variables en el panel de Netlify (y *redeploy*).

### LÃ³gica de clasificaciÃ³n (carpetas)

La ruta final se construye en el handler `POST` (`envio.js`, lÃ­neas 260-269):

```
General/InformaciÃ³n entre ALZ y BDN/FotosEnvios / {Destinatario} / {AAAAMMDD}
```

- `{Destinatario}`: el valor enviado por la app, validado contra la lista cerrada `ALLOWED_DESTINATARIOS` (definida en lÃ­neas 27-37, validaciÃ³n en lÃ­nea 243). SharePoint **no admite `/` ni otros caracteres** en nombres de carpeta/archivo, por eso antes de usarlo como segmento se sanitiza (`sanitizarNombre()`, lÃ­neas 60-64): `Lawtons/Xact` â†’ `Lawtons_Xact`.
- `{AAAAMMDD}`: se deriva de la **fecha de la primera foto** (`fotos[0].fecha`, lÃ­neas 264-265): se toma el bloque `AAAAMMDD` y se le eliminan los guiones.
- Las carpetas intermedias que falten se crean recursivamente con `ensureFolder()` (lÃ­neas 170-199).

### LÃ³gica de renombrado de archivos

El nombre `AAAAMMDD_HHMMSS_00N_Destinatario.jpg` se construye en el bucle de subida del handler `POST` (`envio.js`, lÃ­neas 277-315):

| Trozo | Origen | CÃ³digo |
|---|---|---|
| `AAAAMMDD_HHMMSS` | fecha de captura local de cada foto (formato `AAAA-MM-DD HH:MM:SS`), sin separadores | lÃ­neas 282-287 |
| `00N` | Ã­ndice de la foto + 1, rellenado a 3 dÃ­gitos (01, 02, â€¦, 10) | lÃ­nea 286 |
| `Destinatario` | destinatario saneado con espacios convertidos en `_` (ej. `Giro GMBH` â†’ `Giro_GMBH`, `Lawtons/Xact` â†’ `Lawtons_Xact`) | lÃ­nea 272 |
| `.ext` | extensiÃ³n derivada del MIME de la foto (`jpg`, `jpeg` o `png`) | lÃ­nea 289 |

ConcatenaciÃ³n final en la lÃ­nea 306: `` `${marca}_${contador}_${nombreCliente}.${ext}` ``.

La **fecha de captura** se genera en el frontend: `public/index.html`, funciÃ³n `formatFechaLocal()` (lÃ­nea 897), que convierte el timestamp local en el string `AAAA-MM-DD HH:MM:SS` (ej. `2026-09-05 10:15:30`); ese valor viaja en cada `foto.fecha` del JSON del `POST`.

La subida usa `PUT â€¦/drive/root:/{ruta}/{nombre}:/content` con `conflictBehavior=replace` (lÃ­neas 306-315), de modo que **reenviar con la misma fecha/contador sobreescribe** el archivo existente.

### CÃ³mo aÃ±adir o quitar un destinatario (allowlist)

La lista de destinatarios vÃ¡lidos vive en **dos ficheros que deben mantenerse sincronizados**:

1. **Frontend** â€” `public/index.html`, `<select id="destinatario">` (lÃ­neas 517-528): una `<option>` por destinatario. Es lo que ve el operario en el mÃ³vil.
2. **Backend** â€” `netlify/functions/envio/envio.js`, constante `ALLOWED_DESTINATARIOS` (lÃ­neas 27-37): validaciÃ³n real en servidor (comparada en minÃºsculas, lÃ­nea 243).

Reglas prÃ¡cticas:

- Si un destinatario estÃ¡ en el `<select>` pero **no** en `ALLOWED_DESTINATARIOS` â†’ el envÃ­o se rechaza con `400 Â«Destinatario no permitidoÂ»`.
- Si estÃ¡ en el backend pero **no** en el `<select>` â†’ el operario no podrÃ¡ elegirlo.
- âš ï¸ SharePoint **no admite** los caracteres `/\:*?"<>|#` en nombres de carpeta/archivo: `sanitizarNombre()` (envio.js 60-64) los convierte a `_`. Ej.: `Lawtons/Xact` â†’ carpeta y archivo `Lawtons_Xact`. Si un nombre no deseado de estos caracteres, aparecerÃ¡ en SharePoint sustituido por `_`.

### CÃ³mo configurar el allowlist de IP (opcional)

Restringe **quÃ© direcciones IP pueden llamar al backend** (`netlify/functions/envio/envio.js`). Pensado como perÃ­metro (red de oficina/VPN); **no** sustituye a la clave `APP_TOKEN`, que sigue siendo obligatoria.

- **DÃ³nde se configura:** variable de entorno `ALLOWED_IPS` en Netlify (*Site settings â†’ Environment variables*). Se cambia sin tocar cÃ³digo; basta redesplegar o, en Netlify, los cambios de variables se aplican en el siguiente deploy.
- **Formato:** lista separada por comas de IPs exactas (IPv4 o IPv6) y/o rangos IPv4 en notaciÃ³n CIDR:
  - `203.0.113.17`
  - `203.0.113.0/24` â†’ autoriza todo el rango `203.0.113.x`
  - `2001:db8::1`
  - Las IPv4 mapeadas a IPv6 (`::ffff:203.0.113.10`) se tratan como IPv4 normal.
- **DÃ³nde estÃ¡ escrito:** `envio.js` â†’ `checkIpAllowlist()` (lÃ­neas 136-155), invocada como perÃ­metro al inicio del handler (lÃ­nea 266), antes de la validaciÃ³n de la clave. La IP real del cliente se lee de la cabecera `x-nf-client-connection-ip`, que **inyecta Netlify** (no se puede suplantar desde el navegador). Helpers: `normalizarIp()` (158-162), `ipv4AEntero()` (164-166), `ipv4EnCidr()` (168-171).
- **Comportamiento:**
  - `ALLOWED_IPS` sin definir o vacÃ­a â†’ **abierto** (como hasta ahora, no bloquea nada).
  - Activa e IP no contemplada â†’ `403 { "error": "IP no permitida" }`.
  - Activa y sin IP detectable en la cabecera â†’ se deniega (403).
- âš ï¸ **Impacto operativo:** con la allowlist activa, un operario con **datos mÃ³viles o fuera de la red permitida no podrÃ¡ enviar fotos**. Ãšsala solo si el acceso serÃ¡ siempre desde la red de oficina o VPN.
- Para conocer la IP pÃºblica de la oficina: abrir `https://api.ipify.org` desde esa red y usar el valor en `ALLOWED_IPS`.

---

## IntegraciÃ³n con Microsoft 365 (lo que IT debe habilitar)

- **AplicaciÃ³n registrada en Microsoft Entra:** `GSDC-Fotos`
  - Id. de aplicaciÃ³n (cliente): `e0e899e0-b563-46c6-b12f-aac165456772`
  - Id. de objeto: `2a46a8d3-8266-44b7-80d2-6a96f59d3c1b`
  - Id. de directorio (tenant): `f89b22d4-2e77-4bdb-b3a4-19fa8159c272`
- **MÃ©todo de autenticaciÃ³n:** secreto de cliente (credenciales de aplicaciÃ³n). **No** se usan cuentas de usuario compartidas ni contraseÃ±as corporativas.
- **Permiso requerido (Microsoft Graph, permiso de aplicaciÃ³n):** `Sites.ReadWrite.All` â†’ requiere **consentimiento de administrador** (Entra â†’ *Permisos de API* â†’ *Conceder consentimiento de administrador* para `GSDC-Fotos`).
- **Alcance:** la app solo lee/escribe archivos en SharePoint; **no** accede a correos, usuarios ni otros servicios.

### Endpoints de la funciÃ³n

| MÃ©todo | URL | PropÃ³sito |
|---|---|---|
| `GET` | `/.netlify/functions/envio` | Health check: estado de la conexiÃ³n con SharePoint |
| `POST` | `/.netlify/functions/envio` | Subida de fotos a SharePoint |

---

## Seguridad

- **Clave de activaciÃ³n (`APP_TOKEN`):** la app muestra un modal al primer uso pidiendo una clave compartida (`[REDACTED]`). Se guarda en `localStorage` del dispositivo y se envÃ­a en la cabecera `X-App-Token` en cada peticiÃ³n. La funciÃ³n la compara (en tiempo constante) con la variable de entorno `APP_TOKEN`. Sin la clave correcta, la peticiÃ³n devuelve 401 y la app vuelve a pedirla.
- **CORS restringido** al dominio de la app (`Access-Control-Allow-Origin` no es `*`).
- **Lista cerrada de destinatarios** (9 valores: `Jefferson`, `Wonderful`, `Fresno`, `Vidalia`, `Giro GMBH`, `Giro Italia`, `Filpack`, `Lawtons/Xact`, `EDP`) validada en servidor.
- **ValidaciÃ³n de tipo y contenido** por foto: solo `image/jpeg`, `image/jpg` o `image/png` y, ademÃ¡s, comprobaciÃ³n de los "magic bytes" del archivo (no se puede colar otro contenido declarando un MIME falso).
- **TamaÃ±os limitados:** 1.5 MB por foto decodificada y 6 MB de payload total.
- El **secreto de cliente** de Entra y el **token de Netlify** no estÃ¡n en este repositorio; viven solo como variables de entorno en Netlify.
- El secreto de cliente se compartiÃ³ por chat durante el desarrollo: tras la activaciÃ³n del consentimiento se recomienda **rotarlo** (generar un secreto nuevo en Entra y actualizarlo en Netlify).
- Si el dispositivo se pierde, basta con **rotar `APP_TOKEN`** en Netlify para invalidarlo de inmediato.
- No se debe copiar ningÃºn secreto en correos o documentos que salgan de la organizaciÃ³n.

---

## Estado

- âœ… AplicaciÃ³n y funciÃ³n desarrolladas, comentadas y desplegadas en producciÃ³n.
- âœ… AutenticaciÃ³n OAuth2 verificada y health check operativo.
- â³ **Bloqueante:** consentimiento de administrador para `Sites.ReadWrite.All` (pendiente de IT).
