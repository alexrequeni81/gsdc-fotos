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
 */
exports.handler = async function (event) {
  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: CORS, body: '' };
  }

  if (event.httpMethod === 'GET') {
    return await healthCheck(CORS);
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: CORS, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // --- Lectura y validación del payload ---
    const payload = JSON.parse(event.body || '{}');
    const destinatario = String(payload.destinatario || '').trim();
    const fotos = Array.isArray(payload.fotos) ? payload.fotos.filter(f => f && f.dataUrl) : [];

    if (!destinatario || fotos.length === 0) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'destinatario y al menos una foto son obligatorios' }) };
    }
    if (fotos.length > 10) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: 'Máximo 10 fotos' }) };
    }

    // --- Autenticación y localización del destino ---
    const token = await getGraphToken();
    const driveId = await getDriveId(token);

    const baseFolder = (process.env.BASE_FOLDER || 'General/Información entre ALZ y BDN/FotosEnvios')
      .split('/').map(s => s.trim()).filter(Boolean);

    // Carpeta día (AAAAMMDD) a partir de la fecha de la primera foto.
    const dia = String(fotos[0].fecha || '').trim().slice(0, 10);
    const yyyymmdd = dia.replace(/-/g, '');
    const segments = [...baseFolder, destinatario, yyyymmdd];
    await ensureFolder(token, driveId, segments);

    // --- Subida de cada foto ---
    const nombreCliente = destinatario.replace(/\s+/g, '_');
    const dirPath = encodeURIComponent(segments.join('/')).replace(/%2F/g, '/');
    const subidos = [];
    const fallidos = [];

    for (let i = 0; i < fotos.length; i++) {
      const foto = fotos[i];

      // Marca temporal AAAAMMDD_HHMMSS a partir de la fecha de captura.
      let fecha = String(foto.fecha || '').trim();
      let marca = 'sinfecha';
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(fecha)) {
        marca = fecha.slice(0, 10).replace(/-/g, '') + '_' + fecha.slice(11).replace(/:/g, '');
      }
      const contador = String(i + 1).padStart(3, '0');
      const mime = (String(foto.dataUrl).match(/^data:([^;]+);/) || [null, 'image/jpeg'])[1];
      const ext = (mime.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
      const base64 = String(foto.dataUrl).split(',')[1] || '';
      if (!base64) { fallidos.push({ nombre: 'foto_' + contador, error: 'DataURL sin contenido base64' }); continue; }

      // Nombre final: AAAAMMDD_HHMMSS_00N_Destinatario.jpg
      const nombre = `${marca}_${contador}_${nombreCliente}.${ext}`;
      const buffer = Buffer.from(base64, 'base64');
      const fileUrl = `https://graph.microsoft.com/v1.0/drives/${driveId}/root:/${dirPath}/${encodeURIComponent(nombre)}:/content?@microsoft.graph.conflictBehavior=replace`;

      try {
        await graph(fileUrl, token, {
          method: 'PUT',
          headers: { 'Content-Type': mime || 'application/octet-stream' },
          body: buffer
        });
        subidos.push({ nombre, tamano: buffer.length });
      } catch (err) {
        // Se recoge el error por foto y se continúa con las demás.
        fallidos.push({ nombre, error: err.message });
      }
    }

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ ok: true, destinatario, dia: yyyymmdd, subidos, fallidos })
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