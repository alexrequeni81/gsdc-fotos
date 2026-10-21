/**
 * envio.js — Netlify Function "envio" (GSDC Fotos Envíos)
 *
 * Recibe desde la app PWA un JSON con el destinatario y sus fotos en base64,
 * se autentica contra Microsoft 365 mediante credenciales de aplicación
 * (OAuth2 client-credentials, sin usuario ni contraseña corporativa) y sube
 * cada foto a SharePoint Online vía Microsoft Graph.
 *
 * Endpoints:
 *   GET  /.netlify/functions/envio  -> estado de la conexión (health check)
 *   POST /.netlify/functions/envio  -> sube las fotos a SharePoint
 *
 * Variables de entorno requeridas (definidas en Netlify):
 *   TENANT_ID     Id. de directorio (tenant) de Microsoft Entra
 *   CLIENT_ID     Id. de aplicación (app registration GSDC-Fotos)
 *   CLIENT_SECRET Secreto de cliente de la app (confidencial)
 *   SITE_HOST     Host del sitio SharePoint (ej. grupogiro.sharepoint.com)
 *   SITE_PATH     Ruta del sitio SharePoint (ej. sites/GLOBALSPARESDISTRIBUTIONCENTER)
 *   BASE_FOLDER   Carpeta base dentro de la biblioteca (opcional, hay default)
 */

// Cache en memoria del token OAuth2 para evitar pedir uno en cada llamada.
let cachedToken = null;
let tokenExpiry = 0;

// --- Lista cerrada de destinatarios válidos (se compara en minúsculas) ---
const ALLOWED_DESTINATARIOS = new Set([
  'jefferson',
  'wonderful',
  'fresno',
  'vidalia',
  'giro gmbh',
  'giro italia',
  'filpack',
  'lawtons/xact',
  'edp'
]);

// --- Lista de códigos de piezas válidos (cargada desde piezas.json) ---
let codigosPiezasValidos = null;
function getCodigosPiezas() {
  if (codigosPiezasValidos) return codigosPiezasValidos;
  try {
    const fs = require('fs');
    const path = require('path');
    const raw = fs.readFileSync(path.join(__dirname, 'piezas.json'), 'utf8');
    const arr = JSON.parse(raw);
    codigosPiezasValidos = new Set(Array.isArray(arr) ? arr.map(c => String(c).trim().toLowerCase()) : []);
  } catch (e) {
    codigosPiezasValidos = new Set(); // si no se puede cargar, se permite todo (modo dev)
  }
  return codigosPiezasValidos;
}
// Tamaño máximo por foto decodificada (~1.5 MB).
const MAX_PHOTO_BYTES = 1.5 * 1024 * 1024;

/**
 * Comprueba que los bytes decodificados empiezan por una cabecera JPEG o PNG.
 *   JPEG: FF D8 FF                     -> base64 "/9j"
 *   PNG:  89 50 4E 47 0D 0A 1A 0A      -> base64 "iVBORw"
 */
function looksLikeImage(base64, mime) {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return base64.startsWith('/9j');
  if (mime === 'image/png') return base64.startsWith('iVBORw');
  return false;
}

/**
 * Sanitiza el nombre de carpeta/archivo para SharePoint: sustituye por '_'
 * los caracteres que SharePoint no admite (/, \, :, *, ?, ", <, >, |, #).
 * Ej.: "Lawtons/Xact" -> "Lawtons_Xact".
 */
function sanitizarNombre(s) {
  return String(s).replace(/[/\\:*?"<>|#]/g, '_').replace(/\s+/g, ' ');
}

/**
 * Obtiene (y cachea) un token de acceso de Microsoft Graph.
 * Flujo client-credentials: la aplicación se identifica ante Entra ID.
 */
async function getGraphToken() {
  const tenant = process.env.TENANT_ID;
  const clientId = process.env.CLIENT_ID;
  const secret = process.env.CLIENT_SECRET;
  if (!tenant || !clientId || !secret) {
    throw new Error('Faltan credenciales de Microsoft Entra (TENANT_ID, CLIENT_ID, CLIENT_SECRET)');
  }

  // Reutiliza el token si aún no ha expirado (margen de 60 s).
  if (cachedToken && Date.now() < tokenExpiry) {
    return cachedToken;
  }

  const res = await fetch(
    `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: secret,
        scope: 'https://graph.microsoft.com/.default'
      })
    }
  );

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error('Error obteniendo token OAuth2: ' + JSON.stringify(data).slice(0, 400));
  }

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return cachedToken;
}

/**
 * Valida la cabecera X-App-Token contra la variable de entorno APP_TOKEN.
 * Devuelve true si la clave coincide (o si APP_TOKEN no está configurada en el server,
 * en cuyo caso se permite para no bloquear durante el desarrollo).
 */
function checkAuth(event, CORS) {
  const expected = process.env.APP_TOKEN;
  if (!expected) return true; // sin clave configurada -> abierto (modo dev)

  const headers = event.headers || {};
  const provided = headers['x-app-token'] || headers['X-App-Token'] || headers['X-APP-TOKEN'];
  if (!provided) return false;

  // Comparación en tiempo constante para evitar timing attacks.
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Allowlist de IP (opcional): restringe qué direcciones IP pueden llamar a la
 * función. Se configura solo con la variable de entorno ALLOWED_IPS (Netlify),
 * lista separada por comas de IPs exactas o rangos IPv4 en notación CIDR.
 *   - Vacía / sin definir -> abierto (comportamiento actual, no bloquea nada).
 *   - La IP real del cliente la inyecta Netlify en la cabecera
 *     "x-nf-client-connection-ip" (no se puede suplantar).
 *   - Si la allowlist está activa y la IP no está contemplada -> 403.
 */
function checkIpAllowlist(event) {
  const lista = (process.env.ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (lista.length === 0) return true; // abierto: ALLOWED_IPS sin definir

  const headers = event.headers || {};
  const ip = normalizarIp(headers['x-nf-client-connection-ip'] || '');
  if (!ip) return false; // allowlist activada sin IP detectable -> se deniega

  return lista.some((entry) => {
    const e = normalizarIp(entry);
    const partes = e.split('/');
    if (partes.length === 2 && partes[0].includes('.')) {
      const bits = parseInt(partes[1], 10);
      if (!isNaN(bits) && bits >= 0 && bits <= 32) {
        return ipv4EnCidr(ip, partes[0], bits);
      }
    }
    return ip === e;
  });
}

// "::ffff:1.2.3.4" (IPv4 mapeada a IPv6) se normaliza a "1.2.3.4".
function normalizarIp(ip) {
  const s = String(ip || '').trim();
  const m = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  return m ? m[1] : s;
}

function ipv4AEntero(ip) {
  return ip.split('.').reduce((acc, oct) => (acc << 8) + parseInt(oct, 10), 0) >>> 0;
}

function ipv4EnCidr(ip, red, bits) {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4AEntero(ip) & mask) === (ipv4AEntero(red) & mask);
}

/**
 * Helper para llamadas a la API de Microsoft Graph con el token.
 * Lanza un error con el estado y el cuerpo si la API rechaza la petición.
 */
async function graph(url, token, options) {
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = text; }

  if (!res.ok) {
    throw new Error(`Graph ${res.status}: ${JSON.stringify(data).slice(0, 500)}`);
  }
  return data;
}

/**
 * Resuelve el "drive" (biblioteca Documentos compartidos) del sitio SharePoint
 * indicado en las variables de entorno.
 */
async function getDriveId(token) {
  const host = process.env.SITE_HOST || 'grupogiro.sharepoint.com';
  const path = process.env.SITE_PATH || 'sites/GLOBALSPARESDISTRIBUTIONCENTER';
  const drive = await graph(
    `https://graph.microsoft.com/v1.0/sites/${host}:/${path}:/drive`,
    token,
    { method: 'GET' }
  );
  return drive.id;
}

/**
 * Crea recursivamente las carpetas que falten bajo la raíz del drive.
 * Ej.: General/Información entre ALZ y BDN/FotosEnvios/Jefferson/20260905
 */
async function ensureFolder(token, driveId, segments) {
  let current = '';
  for (const segment of segments) {
    const seg = String(segment).trim().replace(/\s+/g, ' ');
    if (!seg) continue;
    current = current ? `${current}/${seg}` : seg;
    const safe = encodeURIComponent(current).replace(/%2F/g, '/');

    try {
      // Si la carpeta existe, se da por válida y se pasa a la siguiente.
      await graph(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${safe}:`,
        token,
        { method: 'GET' }
      );
      continue;
    } catch (e) {
      // Si no existe, se crea (el error de "ya existe" se ignora).
      const created = await graph(
        `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${safe}:/children`,
        token,
        {
          method: 'POST',
          body: JSON.stringify({ name: seg, folder: { childCount: 0 } })
        }
      ).catch(() => null);
      if (created && created.id) continue;
    }
  }
}

/**
 * Punto de entrada de la Netlify Function.
 * Rutas: GET = health check, POST = subida de fotos.
 * Todas las rutas requieren cabecera X-App-Token (validada contra APP_TOKEN).
 */
exports.handler = async function (event) {
  // CORS restringido al dominio de la app (no se acepta '*').
  const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || 'https://willowy-cranachan-417c2c.netlify.app';
  const CORS = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  // --- Allowlist de IP (opcional): perímetro antes de hablar de claves ---
  if (!checkIpAllowlist(event)) {
    return { statusCode: 403, headers: CORS, body: JSON.stringify({ error: 'IP no permitida' }) };
  }

  // --- Autenticación por clave de dispositivo (X-App-Token vs APP_TOKEN) ---
  if (!checkAuth(event, CORS)) {
    return { statusCode: 401, headers: CORS, body: JSON.stringify({ error: 'Clave no válida' }) };
  }

  if (event.httpMethod === 'GET') {
    return await healthCheck(CORS);
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // --- Tamaño total del payload (defensa contra envíos masivos) ---
    const bodyBytes = Buffer.byteLength(event.body || '', 'utf8');
    if (bodyBytes > MAX_BODY_BYTES) {
      return { statusCode: 413, headers: CORS, body: JSON.stringify({ error: 'Payload demasiado grande' }) };
    }

    // --- Lectura y validación del payload ---
    const payload = JSON.parse(event.body || '{}');
    const tipo = String(payload.tipo || 'envio').trim().toLowerCase();

    const fotos = Array.isArray(payload.fotos) ? payload.fotos.filter(f => f && f.dataUrl) : [];

    if (fotos.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Es obligatorio al menos una foto' }) };
    }
    if (fotos.length > 10) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Máximo 10 fotos' }) };
    }

    // --- Autenticación y localización del destino ---
    const token = await getGraphToken();
    const driveId = await getDriveId(token);

    let baseFolder, segments, nombreArchivoFn;

    if (tipo === 'pieza') {
      // --- Módulo Piezas: código de pieza, sin fecha, sin subcarpeta ---
      const codigoPieza = String(payload.codigoPieza || '').trim().replace(/\s+/g, ' ');
      if (!codigoPieza) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Código de pieza obligatorio' }) };
      }
      const codigoSaneado = sanitizarNombre(codigoPieza);

      // Validación contra la lista de códigos (si está disponible)
      // Nota: se permite enviar códigos no listados (validación solo en frontend como aviso)
      // La lista se usa para autocompletado, no para bloqueo estricto

      baseFolder = (process.env.PIEZAS_FOLDER || 'General/Fotos piezas')
        .split('/').map(s => s.trim()).filter(Boolean);
      segments = [...baseFolder]; // sin subcarpeta por código
      await ensureFolder(token, driveId, segments);

      nombreArchivoFn = (mime, ext) => `${codigoSaneado}.${ext}`;
    } else {
      // --- Módulo Envíos: flujo actual ---
      const destinatario = String(payload.destinatario || '').trim().replace(/\s+/g, ' ');

      if (!ALLOWED_DESTINATARIOS.has(destinatario.toLowerCase())) {
        return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Destinatario no permitido' }) };
      }

      baseFolder = (process.env.BASE_FOLDER || 'General/Información entre ALZ y BDN/FotosEnvios')
        .split('/').map(s => s.trim()).filter(Boolean);

      const dia = String(fotos[0].fecha || '').trim().slice(0, 10);
      const yyyymmdd = dia.replace(/-/g, '');
      const nombreCarpeta = sanitizarNombre(destinatario);
      segments = [...baseFolder, nombreCarpeta, yyyymmdd];
      await ensureFolder(token, driveId, segments);

      const nombreCliente = nombreCarpeta.replace(/\s+/g, '_');
      nombreArchivoFn = (mime, ext, marca, contador) => `${marca}_${contador}_${nombreCliente}.${ext}`;
    }

    // --- Subida de cada foto ---
    const dirPath = encodeURIComponent(segments.join('/')).replace(/%2F/g, '/');
    const subidos = [];
    const fallidos = [];

    // Notas (solo para piezas)
    const notas = tipo === 'pieza' ? String(payload.notas || '').trim() : '';

    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];

      let marca = 'sinfecha';
      let fecha = String(foto.fecha || '').trim();
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fecha)) {
        marca = fecha.slice(0, 10).replace(/-/g, '') + '_' + fecha.slice(11).replace(/:/g, '');
      }
      const contador = String(i + 1).padStart(3, '0');
      const mimeRaw = (String(foto.dataUrl).match(/^data:([^;]+);/) || [null, ''])[1];
      const mime = String(mimeRaw).toLowerCase();
      const ext = (mime.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const base64 = String(foto.dataUrl).split(',')[1] || '';

      // Validaciones de seguridad por foto: tipo permitido y magic bytes.
      if (!base64) { fallidos.push({ nombre: 'foto_' + contador, error: 'DataURL sin contenido base64' }); continue; }
      if (mime !== 'image/jpeg' && mime !== 'image/jpg' && mime !== 'image/png') {
        fallidos.push({ nombre: 'foto_' + contador, error: 'Tipo de archivo no permitido (' + mime + ')' }); continue;
      }
      if (!looksLikeImage(base64, mime)) {
        fallidos.push({ nombre: 'foto_' + contador, error: 'El contenido no parece una imagen válida' }); continue;
      }
      const buffer = Buffer.from(base64, 'base64');
      if (buffer.length > MAX_PHOTO_BYTES) {
        fallidos.push({ nombre: 'foto_' + contador, error: 'Foto demasiado grande (' + buffer.length + ' bytes)' }); continue;
      }

      // Nombre final
      let nombre;
      if (tipo === 'pieza') {
        nombre = nombreArchivoFn(mime, ext);
      } else {
        nombre = nombreArchivoFn(mime, ext, marca, contador);
      }

      const fileUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${dirPath}/${encodeURIComponent(nombre)}:/content?@microsoft.graph.conflictBehavior=replace`;

      try {
        await graph(fileUrl, token, {
          method: 'PUT',
          headers: { 'Content-Type': mime || 'application/octet-stream' },
          body: buffer
        });
        subidos.push({ nombre, tamano: buffer.length });
      } catch (err) {
        fallidos.push({ nombre, error: err.message });
      }
    }

    // --- Subida de notas (.txt) para piezas ---
    if (tipo === 'pieza' && notas) {
      const codigoSaneado = sanitizarNombre(String(payload.codigoPieza || '').trim().replace(/\s+/g, ' '));
      const txtNombre = `${codigoSaneado}.txt`;
      const txtUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${dirPath}/${encodeURIComponent(txtNombre)}:/content?@microsoft.graph.conflictBehavior=replace`;
      try {
        await graph(txtUrl, token, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          body: Buffer.from(notas, 'utf-8')
        });
        subidos.push({ nombre: txtNombre, tamano: Buffer.byteLength(notas, 'utf-8') });
      } catch (err) {
        fallidos.push({ nombre: txtNombre, error: err.message });
      }
    }

    const dia = tipo === 'pieza' ? null : String(fotos[0].fecha || '').trim().slice(0, 10).replace(/-/g, '');

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, tipo, dia, subidos, fallidos })
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: err.message })
    };
  }
};

/**
 * Health check: verifica que la autenticación funciona y que SharePoint
 * responde (es decir, que IT concedió el consentimiento de administrador).
 * La webapp lo consulta al cargar para mostrar el aviso "Pendiente autorización IT".
 */
async function healthCheck(CORS) {
  try {
    const token = await getGraphToken();
    await getDriveId(token);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        listo: true,
        consentimiento: true,
        motivo: 'Conexión con SharePoint activa'
      })
    };
  } catch (err) {
    const msg = String(err.message);
    // 401/403/consent => el admin aún no aprobó el permiso de aplicación.
    const sinConsentimiento = /401|403|consent|requester|denied|generalException/i.test(msg);
    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        listo: false,
        consentimiento: sinConsentimiento,
        motivo: sinConsentimiento ? 'Pendiente autorización de IT' : ('Error de configuración: ' + msg.slice(0, 200))
      })
    };
  }
}