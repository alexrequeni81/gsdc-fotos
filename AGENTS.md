# AGENTS.md — Contexto del proyecto GSDC Fotos Envíos

Este archivo da contexto automático a cualquier sesión de opencode que se abra en este proyecto. Léelo al empezar y úsalo como referencia de decisiones y estado.

## Qué es este proyecto

Web PWA (móvil) para que los operarios de transporte capturen fotos de mercancía y las envíen directamente a **SharePoint Online**, sin correos intermedios, sin credenciales de usuario compartidas y sin conectores premium de pago.

- Destino esperado: `Documentos compartidos / General / Información entre ALZ y BDN / FotosEnvios / {Destinatario} / {AAAAMMDD}`
- Nombres de archivo: `AAAAMMDD_HHMMSS_00N_Destinatario.jpg` (fecha de captura local + contador + destinatario).
- Máx. 10 fotos por envío, JPEG ~1024px calidad 0.7, borrador en IndexedDB.

## Arquitectura

```
Móvil (PWA) -> Netlify Function "envio" -> Microsoft Graph -> SharePoint Online
```

- **Frontend:** `public/index.html` (HTML/CSS/JS nativo, sin frameworks), PWA con service worker e IndexedDB.
- **Backend:** `netlify/functions/envio/envio.js` (Netlify Function, Node 18+, `fetch` nativo).
- **Hosting:** Netlify (plan Free), despliegue por Netlify CLI (`netlify deploy --prod --site <ID> --dir public`).
- **Config:** `netlify.toml` → `functions = "netlify/functions"`, `publish = "public"`.
- **Autenticación:** OAuth2 client-credentials contra Microsoft Entra ID (app registration `GSDC-Fotos`). Sin usuario ni contraseña corporativa.

## Estructura de archivos

```
README.md                              ← documentación completa (usuario + técnico)
AGENTS.md                              ← este archivo de contexto
netlify.toml                           ← configuración de Netlify
public/
  index.html                           ← aplicación PWA completa
  service-worker.js                    ← caché offline
  manifest.json                        ← metadatos PWA
  icon-192.svg, icon-512.svg           ← iconos
netlify/
  functions/envio/envio.js             ← función backend
```

## Decisiones importantes ya tomadas (NO revertir sin preguntar)

1. **Sin email en el circuito.** Se eliminó la vía anterior (Netlify Forms/FormSpark → buzón corporativo repuestos@giro.es → Power Automate). El operario no debe depender de correos ni del buzón compartido.
2. **Sin Power Automate.** Se descartó (conector HTTP era premium; conexión SharePoint con token caducado). La subida a SharePoint se hace con Microsoft Graph desde la función.
3. **Sin usar la API de entrada de Netlify Forms.** El plan free de Netlify no expone el endpoint de formularios; además se evitó depender del token de personal de Netlify. La app envía las fotos directo a la función (JSON con dataUrls + fecha local).
4. **Diseño UX aprobado:** tarjeta a pantalla completa sin huecos, botón Enviar anclado abajo, aviso amigable "Pendiente autorización IT" (no bloqueante). El placeholder del destinatario es `Ej: Jefferson, Fresno...`.
5. **Manejo de errores amigable:** si el envío falla por falta de consentimiento (401/403/consent), se muestra el modal "Pendiente autorización IT" en lugar de un alert técnico.

## Módulos de la aplicación

La app tiene dos módulos seleccionables mediante pestañas:

1. **Envíos** (módulo original): destinatario (dropdown, 9 opciones) + fotos. Carpeta: `FotosEnvios / {Destinatario} / {AAAAMMDD}`. Nombre: `AAAAMMDD_HHMMSS_00N_Destinatario.jpg`.
2. **Piezas** (nuevo): código de pieza (texto libre) + fotos. Carpeta: `Fotos piezas /` (sin subcarpeta). Nombre: `{CódigoPieza}.jpg`. Variable de entorno: `PIEZAS_FOLDER` (default: `General/Fotos piezas`).

## Seguridad (crítico)

- Los secretos **NO están en el repositorio**: viven solo como variables de entorno en Netlify.
- Variables de entorno usadas: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SITE_HOST`, `SITE_PATH`, `BASE_FOLDER`, `ALLOWED_ORIGIN`, `ALLOWED_IPS`, `APP_TOKEN`.
- **APP_TOKEN** (`[REDACTED]`): clave de activación que el operario introduce al primer uso del dispositivo; se guarda en `localStorage` y se envía en la cabecera `X-App-Token` en cada petición. La función la compara (en tiempo constante) con `APP_TOKEN`. Si alguien cambia la variable en Netlify, los dispositivos con la clave antigua dejan de funcionar automáticamente.
- El `CLIENT_SECRET` (app `GSDC-Fotos`) se compartió por chat durante el desarrollo: **está comprometido y debe rotarse** tras conseguir el consentimiento de administrador.
- No usar el comando `/share` de opencode para compartir conversaciones de este proyecto: contienen secretos y generan enlaces públicos.
- Nunca escribir secretos ni tokens en código, README ni correos.

## Configuración de SharePoint (dónde está escrita)

**No hay archivo de config:** el destino vive en las variables de entorno de Netlify y la función las lee en `netlify/functions/envio/envio.js`:

| Variable | Dónde se lee (envio.js) | Default si falta |
|---|---|---|
| `SITE_HOST` | `getDriveId()` — línea 156 | `grupogiro.sharepoint.com` |
| `SITE_PATH` | `getDriveId()` — línea 157 | `sites/GLOBALSPARESDISTRIBUTIONCENTER` |
| `BASE_FOLDER` | handler POST — líneas 260-261 | `General/Información entre ALZ y BDN/FotosEnvios` |
| `ALLOWED_ORIGIN` | handler — línea 208 | `https://willowy-cranachan-417c2c.netlify.app` |

Drive resuelto con Graph `/sites/{SITE_HOST}:/{SITE_PATH}:/drive` (envio.js 155-163). Cambiar de sitio/carpeta = tocar solo las env vars en Netlify, sin tocar código.

## Lógica de clasificación y renombrado (dónde está escrita)

Todo el destino y nombrado lo decide el **backend** (`netlify/functions/envio/envio.js`); el frontend solo aporta la fecha.

- **Destinatarios permitidos** (9): `jefferson`, `wonderful`, `fresno`, `vidalia`, `giro gmbh`, `giro italia`, `filpack`, `lawtons/xact`, `edp` — definidos en `ALLOWED_DESTINATARIOS` (envio.js 27-37, validación en 243). El `<select>` del frontend (`public/index.html` 517-529) usa **los mismos valores**.
- **Carpetas** = `BASE_FOLDER / {Destinatario} / {AAAAMMDD}` (envio.js 260-269). `AAAAMMDD` sale de la **fecha de la 1ª foto** (líneas 264-265). Carpetas creadas recursivamente por `ensureFolder()` (170-199).
- **Sanitización**: SharePoint no admite `/ \ : * ? " < > | #` en nombres; `sanitizarNombre()` (envio.js 60-64) los sustituye por `_`. Ej.: `Lawtons/Xact` → carpeta/nombre `Lawtons_Xact`. Se aplica al nombre de carpeta (267) y de ahí sale el `nombreCliente` del archivo (272).
- **Nombre** = `AAAAMMDD_HHMMSS_00N_Destinatario.ext` (envio.js 306):
  - `AAAAMMDD_HHMMSS` ← `foto.fecha` (captura local), separadores quitados (282-287);
  - `00N` ← índice +1 a 3 dígitos (286);
  - `Destinatario` ← saneado + espacios → `_` (272);
  - `.ext` ← del MIME (289).
- **Fecha de captura**: la genera el frontend `public/index.html` → `formatFechaLocal()` (línea 897) como `AAAA-MM-DD HH:MM:SS`; viaja en cada `foto.fecha` del JSON.
- **Subida** con `conflictBehavior=replace` (306-315): reenviar con misma fecha/contador **sobreescribe**.

## Allowlist de IP (opcional, dónde está escrita)

- Variable de entorno **`ALLOWED_IPS`** (Netlify): lista separada por comas de IPs exactas (IPv4/IPv6) o rangos IPv4 CIDR (ej. `203.0.113.0/24`). **Vacía/sin definir = abierto** (no bloquea nada, comportamiento actual).
- Código: `checkIpAllowlist()` (envio.js 136-155), llamada como perímetro en el handler (línea 266) → devuelve `403 "IP no permitida"`. Helpers: `normalizarIp()` (158-162), `ipv4AEntero()` (164-166), `ipv4EnCidr()` (168-171).
- La IP real del cliente la inyecta Netlify en la cabecera `x-nf-client-connection-ip` (no suplantable desde el navegador).
- ⚠️ Con allowlist activa, un operario con datos móviles/fuera de la red permitida no podrá enviar. No sustituye a `APP_TOKEN` (ambas se exigen).

## Estado pendiente

- ⏳ **Bloqueante:** conceder el consentimiento de administrador en Microsoft Entra para el permiso de aplicación `Sites.ReadWrite.All` de la app `GSDC-Fotos`.
- Mientras no se conceda: la autenticación OAuth2 funciona (el token se emite), pero SharePoint devuelve error 401/403 y las fotos no se suben (`healthCheck` reporta `listo: false, consentimiento: true`).
- 🔐 Pendiente: rotar el secreto de cliente después de la activación y actualizar la variable en Netlify.
- Con el consentimiento concedido, verificar el envío end-to-end real desde el móvil.

## Cómo probar localmente

- La función puede probarse como módulo Node con un evento falso:
  - `GET` → `{ httpMethod: 'GET' }` devuelve el estado de la conexión.
  - `POST` → `{ httpMethod: 'POST', body: JSON.stringify({ destinatario, fotos: [{ dataUrl, fecha }] }) }`.
- Requiere definir las variables de entorno de Azure antes de requerir la función.
- Despliegue: `netlify deploy --prod --site <SITE_ID> --dir public`. Este proyecto se despliega por Netlify CLI (no por drag&drop).