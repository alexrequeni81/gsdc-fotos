# 📷 Fotos Envíos GSDC

Web PWA para capturar y enviar fotografías de envíos directamente a **SharePoint Online**, sin correos intermedios, sin credenciales corporativas compartidas y sin conectores premium.

El operario abre la web desde el móvil, escribe el destinatario (ej.: *Jefferson, Fresno*), toma hasta **10 fotos** y pulsa **Enviar**. Las fotos se guardan automáticamente en SharePoint en:

```
Documentos compartidos / General / Información entre ALZ y BDN / FotosEnvios / {Destinatario} / {AAAAMMDD}
```

cada una con el nombre `AAAAMMDD_HHMMSS_00N_Destinatario.jpg` (fecha de captura + número de foto + destinatario).

---

## Flujo de funcionamiento

```
Móvil (app PWA)
   │ 1. Toma y comprime las fotos; escribe destinatario
   ▼
Netlify Function "envio"
   │ 2. Se identifica ante Microsoft (app GSDC-Fotos, OAuth2 client-credentials)
   │ 3. Crea la carpeta si no existe en SharePoint
   ▼
Microsoft 365 (SharePoint Online)
   │ 4. Sube cada foto con su nombre de archivo
   ▼
Carpeta FotosEnvios en SharePoint ✅  (todo automático, en segundos)
```

No interviene ninguna persona ni herramienta adicional en el proceso.

---

## Stack

| Capa | Tecnología |
|---|---|
| Frontend | HTML + CSS + JavaScript nativo (sin frameworks), PWA |
| Caché offline | Service Worker (`public/service-worker.js`, cache `gsdc-fotos-v2`) |
| Borradores | IndexedDB (recupera fotos si se cierra la pestaña) |
| Hosting | Netlify (plan Free), despliegue por **Netlify CLI** |
| Backend | **Netlify Function**: `netlify/functions/envio/envio.js` (Node 18+, `fetch` nativo) |
| Identidad | Microsoft Entra ID (Azure AD), app **`GSDC-Fotos`**, OAuth2 **client-credentials** |
| Destino | SharePoint Online — sitio `GLOBALSPARESDISTRIBUTIONCENTER`, biblioteca *Documentos compartidos* |

---

## Estructura del proyecto

```
gsdc/
├── netlify.toml                     ← configuración de build de Netlify
├── public/                          ← webapp (estáticos desplegados)
│   ├── index.html                   ← aplicación PWA completa
│   ├── service-worker.js            ← caché offline
│   ├── manifest.json                ← metadatos PWA
│   ├── icon-192.svg                 ← icono
│   └── icon-512.svg                 ← icono
└── netlify/
    └── functions/
        └── envio/
            └── envio.js             ← función backend (autenticación + subida a SharePoint)
```

---

## Aplicación (frontend) — `public/index.html`

- **Captura:** cámara del dispositivo; cada foto se redimensiona a ~1024 px y se codifica **JPEG calidad 0.7** para reducir peso.
- **Salvaguarda:** las fotos se guardan en IndexedDB como borrador mientras la app está abierta.
- **Envío:** `POST /.netlify/functions/envio` con JSON:
  ```json
  {
    "destinatario": "Jefferson",
    "fotos": [
      { "dataUrl": "data:image/jpeg;base64,...", "fecha": "2026-09-05 10:15:30" }
    ]
  }
  ```
- **Health check al cargar:** `GET /.netlify/functions/envio`. Si la conexión con SharePoint no está activa, la app muestra el modal **"Pendiente autorización IT"** (no bloqueante). Si se intenta enviar sin autorización, se muestra el mismo aviso amigable y las fotos permanecen en pantalla para reintentar.
- Los mensajes de estado distinguen dos fallos:
  - **Falta consentimiento de administrador** (respuesta 401/403/consent de Graph) → *"Pendiente autorización IT"*.
  - **Error de configuración** → aviso genérico de que IT debe revisar la conexión.

## Service Worker — `public/service-worker.js`

- Precarga estáticos (`/`, `index.html`, `manifest.json`, iconos).
- Estrategia: **red primero con fallback a caché**.
- Las llamadas a funciones Netlify (`/.netlify/functions/`) **no se cachean**, para que el estado de conexión se consulte siempre fresco.

## Backend — `netlify/functions/envio/envio.js`

1. Valida campos (destinatario obligatorio, máx. 10 fotos).
2. Obtiene token **OAuth2 client-credentials** contra Entra ID
   (`login.microsoftonline.com/{tenant}/oauth2/v2.0/token`, scope `https://graph.microsoft.com/.default`).
3. Resuelve el **drive** del sitio (Graph: `/sites/{host}:/{path}:/drive`).
4. **Crea carpetas** si faltan (`FotosEnvios/{Destinatario}/{AAAAMMDD}`).
5. **Sube cada foto** (`PUT .../drive/root:/.../:{nombre}:/content`, `conflictBehavior=replace`).
6. Devuelve `{ ok, subidos: [], fallidos: [] }` (errores por foto, no bloqueantes).

Además expone un **health check** en `GET` que devuelve:

```json
{ "listo": false, "consentimiento": true, "motivo": "Pendiente autorización de IT" }
```

---

## Configuración de Netlify

### Variables de entorno requeridas

Definidas en el panel de Netlify (*Site settings → Environment variables*) y **no en el código**:

| Variable | Descripción |
|---|---|
| `TENANT_ID` | Id. de directorio (tenant) de Microsoft Entra |
| `CLIENT_ID` | Id. de aplicación (app registration `GSDC-Fotos`) |
| `CLIENT_SECRET` | Secreto de cliente de la app (confidencial) |
| `SITE_HOST` | Host del sitio SharePoint (ej. `grupogiro.sharepoint.com`) |
| `SITE_PATH` | Ruta del sitio (ej. `sites/GLOBALSPARESDISTRIBUTIONCENTER`) |
| `BASE_FOLDER` | Carpeta base en la biblioteca (default: `General/Información entre ALZ y BDN/FotosEnvios`) |

### Despliegue con Netlify CLI

```bash
netlify deploy --prod --site <SITE_ID> --dir public
```

`netlify.toml` ya configura `functions = "netlify/functions"` y `publish = "public"`.

---

## Integración con Microsoft 365 (lo que IT debe habilitar)

- **Aplicación registrada en Microsoft Entra:** `GSDC-Fotos`
  - Id. de aplicación (cliente): `e0e899e0-b563-46c6-b12f-aac165456772`
  - Id. de objeto: `2a46a8d3-8266-44b7-80d2-6a96f59d3c1b`
  - Id. de directorio (tenant): `f89b22d4-2e77-4bdb-b3a4-19fa8159c272`
- **Método de autenticación:** secreto de cliente (credenciales de aplicación). **No** se usan cuentas de usuario compartidas ni contraseñas corporativas.
- **Permiso requerido (Microsoft Graph, permiso de aplicación):** `Sites.ReadWrite.All` → requiere **consentimiento de administrador** (Entra → *Permisos de API* → *Conceder consentimiento de administrador* para `GSDC-Fotos`).
- **Alcance:** la app solo lee/escribe archivos en SharePoint; **no** accede a correos, usuarios ni otros servicios.

### Endpoints de la función

| Método | URL | Propósito |
|---|---|---|
| `GET` | `/.netlify/functions/envio` | Health check: estado de la conexión con SharePoint |
| `POST` | `/.netlify/functions/envio` | Subida de fotos a SharePoint |

---

## Seguridad

- El **secreto de cliente** y el **token de Netlify** no están en este repositorio; viven solo como variables de entorno en Netlify.
- El secreto de cliente se compartió por chat durante el desarrollo: tras la activación del consentimiento se recomienda **rotarlo** (generar un secreto nuevo en Entra y actualizarlo en Netlify).
- No se debe copiar ningún secreto en correos o documentos que salgan de la organización.

---

## Estado

- ✅ Aplicación y función desarrolladas, comentadas y desplegadas en producción.
- ✅ Autenticación OAuth2 verificada y health check operativo.
- ⏳ **Bloqueante:** consentimiento de administrador para `Sites.ReadWrite.All` (pendiente de IT).