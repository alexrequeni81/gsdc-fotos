# AGENTS.md â€” Contexto del proyecto GSDC Fotos EnvÃ­os

Este archivo da contexto automÃ¡tico a cualquier sesiÃ³n de opencode que se abra en este proyecto. LÃ©elo al empezar y Ãºsalo como referencia de decisiones y estado.

## QuÃ© es este proyecto

Web PWA (mÃ³vil) para que los operarios de transporte capturen fotos de mercancÃ­a y las envÃ­en directamente a **SharePoint Online**, sin correos intermedios, sin credenciales de usuario compartidas y sin conectores premium de pago.

- Destino esperado: `Documentos compartidos / General / InformaciÃ³n entre ALZ y BDN / FotosEnvios / {Destinatario} / {AAAAMMDD}`
- Nombres de archivo: `AAAAMMDD_HHMMSS_00N_Destinatario.jpg` (fecha de captura local + contador + destinatario).
- MÃ¡x. 10 fotos por envÃ­o, JPEG ~1024px calidad 0.7, borrador en IndexedDB.

## Arquitectura

```
MÃ³vil (PWA) -> Netlify Function "envio" -> Microsoft Graph -> SharePoint Online
```

- **Frontend:** `public/index.html` (HTML/CSS/JS nativo, sin frameworks), PWA con service worker e IndexedDB.
- **Backend:** `netlify/functions/envio/envio.js` (Netlify Function, Node 18+, `fetch` nativo).
- **Hosting:** Netlify (plan Free), despliegue por Netlify CLI (`netlify deploy --prod --site <ID> --dir public`).
- **Config:** `netlify.toml` â†’ `functions = "netlify/functions"`, `publish = "public"`.
- **AutenticaciÃ³n:** OAuth2 client-credentials contra Microsoft Entra ID (app registration `GSDC-Fotos`). Sin usuario ni contraseÃ±a corporativa.

## Estructura de archivos

```
README.md                              â† documentaciÃ³n completa (usuario + tÃ©cnico)
AGENTS.md                              â† este archivo de contexto
netlify.toml                           â† configuraciÃ³n de Netlify
public/
  index.html                           â† aplicaciÃ³n PWA completa
  service-worker.js                    â† cachÃ© offline
  manifest.json                        â† metadatos PWA
  icon-192.svg, icon-512.svg           â† iconos
netlify/
  functions/envio/envio.js             â† funciÃ³n backend
```

## Decisiones importantes ya tomadas (NO revertir sin preguntar)

1. **Sin email en el circuito.** Se eliminÃ³ la vÃ­a anterior (Netlify Forms/FormSpark â†’ buzÃ³n corporativo repuestos@giro.es â†’ Power Automate). El operario no debe depender de correos ni del buzÃ³n compartido.
2. **Sin Power Automate.** Se descartÃ³ (conector HTTP era premium; conexiÃ³n SharePoint con token caducado). La subida a SharePoint se hace con Microsoft Graph desde la funciÃ³n.
3. **Sin usar la API de entrada de Netlify Forms.** El plan free de Netlify no expone el endpoint de formularios; ademÃ¡s se evitÃ³ depender del token de personal de Netlify. La app envÃ­a las fotos directo a la funciÃ³n (JSON con dataUrls + fecha local).
4. **DiseÃ±o UX aprobado:** tarjeta a pantalla completa sin huecos, botÃ³n Enviar anclado abajo, aviso amigable "Pendiente autorizaciÃ³n IT" (no bloqueante). El placeholder del destinatario es `Ej: Jefferson, Fresno...`.
5. **Manejo de errores amigable:** si el envÃ­o falla por falta de consentimiento (401/403/consent), se muestra el modal "Pendiente autorizaciÃ³n IT" en lugar de un alert tÃ©cnico.

## Seguridad (crÃ­tico)

- Los secretos **NO estÃ¡n en el repositorio**: viven solo como variables de entorno en Netlify.
- Variables de entorno usadas: `TENANT_ID`, `CLIENT_ID`, `CLIENT_SECRET`, `SITE_HOST`, `SITE_PATH`, `BASE_FOLDER`, `ALLOWED_ORIGIN`, `ALLOWED_IPS`, `APP_TOKEN`.
- **APP_TOKEN** (`[REDACTED]`): clave de activaciÃ³n que el operario introduce al primer uso del dispositivo; se guarda en `localStorage` y se envÃ­a en la cabecera `X-App-Token` en cada peticiÃ³n. La funciÃ³n la compara (en tiempo constante) con `APP_TOKEN`. Si alguien cambia la variable en Netlify, los dispositivos con la clave antigua dejan de funcionar automÃ¡ticamente.
- El `CLIENT_SECRET` (app `GSDC-Fotos`) se compartiÃ³ por chat durante el desarrollo: **estÃ¡ comprometido y debe rotarse** tras conseguir el consentimiento de administrador.
- No usar el comando `/share` de opencode para compartir conversaciones de este proyecto: contienen secretos y generan enlaces pÃºblicos.
- Nunca escribir secretos ni tokens en cÃ³digo, README ni correos.

## ConfiguraciÃ³n de SharePoint (dÃ³nde estÃ¡ escrita)

**No hay archivo de config:** el destino vive en las variables de entorno de Netlify y la funciÃ³n las lee en `netlify/functions/envio/envio.js`:

| Variable | DÃ³nde se lee (envio.js) | Default si falta |
|---|---|---|
| `SITE_HOST` | `getDriveId()` â€” lÃ­nea 156 | `grupogiro.sharepoint.com` |
| `SITE_PATH` | `getDriveId()` â€” lÃ­nea 157 | `sites/GLOBALSPARESDISTRIBUTIONCENTER` |
| `BASE_FOLDER` | handler POST â€” lÃ­neas 260-261 | `General/InformaciÃ³n entre ALZ y BDN/FotosEnvios` |
| `ALLOWED_ORIGIN` | handler â€” lÃ­nea 208 | `https://willowy-cranachan-417c2c.netlify.app` |

Drive resuelto con Graph `/sites/{SITE_HOST}:/{SITE_PATH}:/drive` (envio.js 155-163). Cambiar de sitio/carpeta = tocar solo las env vars en Netlify, sin tocar cÃ³digo.

## LÃ³gica de clasificaciÃ³n y renombrado (dÃ³nde estÃ¡ escrita)

Todo el destino y nombrado lo decide el **backend** (`netlify/functions/envio/envio.js`); el frontend solo aporta la fecha.

- **Destinatarios permitidos** (9): `jefferson`, `wonderful`, `fresno`, `vidalia`, `giro gmbh`, `giro italia`, `filpack`, `lawtons/xact`, `edp` â€” definidos en `ALLOWED_DESTINATARIOS` (envio.js 27-37, validaciÃ³n en 243). El `<select>` del frontend (`public/index.html` 517-529) usa **los mismos valores**.
- **Carpetas** = `BASE_FOLDER / {Destinatario} / {AAAAMMDD}` (envio.js 260-269). `AAAAMMDD` sale de la **fecha de la 1Âª foto** (lÃ­neas 264-265). Carpetas creadas recursivamente por `ensureFolder()` (170-199).
- **SanitizaciÃ³n**: SharePoint no admite `/ \ : * ? " < > | #` en nombres; `sanitizarNombre()` (envio.js 60-64) los sustituye por `_`. Ej.: `Lawtons/Xact` â†’ carpeta/nombre `Lawtons_Xact`. Se aplica al nombre de carpeta (267) y de ahÃ­ sale el `nombreCliente` del archivo (272).
- **Nombre** = `AAAAMMDD_HHMMSS_00N_Destinatario.ext` (envio.js 306):
  - `AAAAMMDD_HHMMSS` â† `foto.fecha` (captura local), separadores quitados (282-287);
  - `00N` â† Ã­ndice +1 a 3 dÃ­gitos (286);
  - `Destinatario` â† saneado + espacios â†’ `_` (272);
  - `.ext` â† del MIME (289).
- **Fecha de captura**: la genera el frontend `public/index.html` â†’ `formatFechaLocal()` (lÃ­nea 897) como `AAAA-MM-DD HH:MM:SS`; viaja en cada `foto.fecha` del JSON.
- **Subida** con `conflictBehavior=replace` (306-315): reenviar con misma fecha/contador **sobreescribe**.

## Allowlist de IP (opcional, dÃ³nde estÃ¡ escrita)

- Variable de entorno **`ALLOWED_IPS`** (Netlify): lista separada por comas de IPs exactas (IPv4/IPv6) o rangos IPv4 CIDR (ej. `203.0.113.0/24`). **VacÃ­a/sin definir = abierto** (no bloquea nada, comportamiento actual).
- CÃ³digo: `checkIpAllowlist()` (envio.js 136-155), llamada como perÃ­metro en el handler (lÃ­nea 266) â†’ devuelve `403 "IP no permitida"`. Helpers: `normalizarIp()` (158-162), `ipv4AEntero()` (164-166), `ipv4EnCidr()` (168-171).
- La IP real del cliente la inyecta Netlify en la cabecera `x-nf-client-connection-ip` (no suplantable desde el navegador).
- âš ï¸ Con allowlist activa, un operario con datos mÃ³viles/fuera de la red permitida no podrÃ¡ enviar. No sustituye a `APP_TOKEN` (ambas se exigen).

## Estado pendiente

- â³ **Bloqueante:** conceder el consentimiento de administrador en Microsoft Entra para el permiso de aplicaciÃ³n `Sites.ReadWrite.All` de la app `GSDC-Fotos`.
- Mientras no se conceda: la autenticaciÃ³n OAuth2 funciona (el token se emite), pero SharePoint devuelve error 401/403 y las fotos no se suben (`healthCheck` reporta `listo: false, consentimiento: true`).
- ðŸ” Pendiente: rotar el secreto de cliente despuÃ©s de la activaciÃ³n y actualizar la variable en Netlify.
- Con el consentimiento concedido, verificar el envÃ­o end-to-end real desde el mÃ³vil.

## CÃ³mo probar localmente

- La funciÃ³n puede probarse como mÃ³dulo Node con un evento falso:
  - `GET` â†’ `{ httpMethod: 'GET' }` devuelve el estado de la conexiÃ³n.
  - `POST` â†’ `{ httpMethod: 'POST', body: JSON.stringify({ destinatario, fotos: [{ dataUrl, fecha }] }) }`.
- Requiere definir las variables de entorno de Azure antes de requerir la funciÃ³n.
- Despliegue: `netlify deploy --prod --site <SITE_ID> --dir public`. Este proyecto se despliega por Netlify CLI (no por drag&drop).
