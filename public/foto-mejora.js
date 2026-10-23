/* =============================================================================
 * foto-mejora.js — GSDC Fotos Envíos
 * Postprocesado de fotos de piezas para aspecto "catálogo" (fondo blanco,
 * pieza centrada, formato cuadrado). Sin dependencias y 100 % en el dispositivo.
 *
 * Dos métodos:
 *   'blanquear'  Divide la imagen por la iluminación estimada del fondo (flat-field)
 *                y empuja lo casi-blanco a blanco. No recorta bordes, conserva la
 *                sombra natural. Solo válido con fondos CLAROS y lisos.
 *   'recortar'   Segmenta el fondo con region-growing desde el borde en espacio Lab,
 *                suaviza el borde, descontamina el halo y compone sobre blanco con
 *                una sombra suave sintética. Válido con fondos oscuros/de color.
 *
 * Ambos encuadran: recorte cuadrado centrado en la pieza con margen.
 *
 * El núcleo trabaja con objetos {data:Uint8ClampedArray RGBA, width, height}
 * (igual que ImageData), así que se puede probar en Node sin navegador.
 * La parte de navegador (canvas, JPEG) está al final: FotoMejora.crearSesion().
 *
 * FASE 2 (modo preciso): el punto de extensión es construirAnalisisDesdeMascara().
 * Una máscara binaria generada por un modelo (SAM, U²-Net...) entra por ahí y
 * reutiliza todo el resto del pipeline (suavizado, encuadre, sombra, composición).
 * ========================================================================== */
(function (root) {
  'use strict';

  const DEFAULTS = {
    trabajoLado: 800,       // lado mayor de la copia reducida usada para analizar
    salida: 1200,           // lado del cuadrado final (px)
    calidadJpeg: 0.9,
    margen: 0.09,           // margen alrededor de la pieza (fracción del lado)
    zoomMax: 1.6,           // ampliación máxima sobre los píxeles originales
    pesoL: 0.4,             // peso de la luminosidad al decidir "es fondo" (bajo = las sombras cuentan como fondo)
    tolMin: 10, tolMax: 30, // tolerancia ΔE (Lab) para considerar píxel = fondo
    tolLocal: 3.0,          // salto máximo ΔE entre vecinos para seguir un degradado
    huecosBlancos: true,    // agujeros pasantes (rodamientos, tornillos) en blanco
    sombra: 0.8,            // 0 = sin sombra, 1 = sombra normal
    encuadrar: true         // recortar cuadrado centrado en la pieza
  };

  // ------------------------------------------------------------------ utilidades
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const smoothstep = (a, b, x) => {
    const t = clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  const SRGB2LIN = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    SRGB2LIN[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  }
  function rgb2lab(r, g, b, out, o) {
    const R = SRGB2LIN[r], G = SRGB2LIN[g], B = SRGB2LIN[b];
    const x = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047;
    const y = 0.2126729 * R + 0.7151522 * G + 0.0721750 * B;
    const z = (0.0193339 * R + 0.1191920 * G + 0.9503041 * B) / 1.08883;
    const fx = x > 0.008856 ? Math.cbrt(x) : 7.787 * x + 16 / 116;
    const fy = y > 0.008856 ? Math.cbrt(y) : 7.787 * y + 16 / 116;
    const fz = z > 0.008856 ? Math.cbrt(z) : 7.787 * z + 16 / 116;
    out[o] = 116 * fy - 16;
    out[o + 1] = 500 * (fx - fy);
    out[o + 2] = 200 * (fy - fz);
  }
  function imagenALab(img) {
    const n = img.width * img.height;
    const lab = new Float32Array(n * 3);
    const d = img.data;
    for (let i = 0, p = 0; i < n; i++, p += 4) rgb2lab(d[p], d[p + 1], d[p + 2], lab, i * 3);
    return lab;
  }

  /** Reducción bilinear en JS puro (en navegador se usa canvas, esto es para Node/tests). */
  function reducir(img, maxLado) {
    const k = Math.max(img.width, img.height) / maxLado;
    if (k <= 1) return img;
    const w = Math.round(img.width / k), h = Math.round(img.height / k);
    const out = new Uint8ClampedArray(w * h * 4);
    const sx = img.width / w, sy = img.height / h;
    for (let y = 0; y < h; y++) {
      const y0 = Math.floor(y * sy), y1 = Math.min(img.height, Math.max(y0 + 1, Math.ceil((y + 1) * sy)));
      for (let x = 0; x < w; x++) {
        const x0 = Math.floor(x * sx), x1 = Math.min(img.width, Math.max(x0 + 1, Math.ceil((x + 1) * sx)));
        let r = 0, g = 0, b = 0, c = 0;
        for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
          const p = (yy * img.width + xx) * 4;
          r += img.data[p]; g += img.data[p + 1]; b += img.data[p + 2]; c++;
        }
        const o = (y * w + x) * 4;
        out[o] = r / c; out[o + 1] = g / c; out[o + 2] = b / c; out[o + 3] = 255;
      }
    }
    return { data: out, width: w, height: h };
  }

  /** Desenfoque de caja separable (radio r, n pasadas ≈ gaussiano). Modifica `a`. */
  function boxBlur(a, w, h, r, pasadas) {
    if (r < 1) return a;
    const tmp = new Float32Array(a.length);
    for (let p = 0; p < (pasadas || 1); p++) {
      for (let y = 0; y < h; y++) {           // horizontal
        const row = y * w;
        let acc = 0;
        for (let x = -r; x <= r; x++) acc += a[row + clamp(x, 0, w - 1)];
        for (let x = 0; x < w; x++) {
          tmp[row + x] = acc / (2 * r + 1);
          acc += a[row + clamp(x + r + 1, 0, w - 1)] - a[row + clamp(x - r, 0, w - 1)];
        }
      }
      for (let x = 0; x < w; x++) {           // vertical
        let acc = 0;
        for (let y = -r; y <= r; y++) acc += tmp[clamp(y, 0, h - 1) * w + x];
        for (let y = 0; y < h; y++) {
          a[y * w + x] = acc / (2 * r + 1);
          acc += tmp[clamp(y + r + 1, 0, h - 1) * w + x] - tmp[clamp(y - r, 0, h - 1) * w + x];
        }
      }
    }
    return a;
  }

  function muestrearF(a, w, h, x, y) {   // bilinear sobre mapa float; fuera = 0
    x -= 0.5; y -= 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const g = (xx, yy) => (xx < 0 || yy < 0 || xx >= w || yy >= h) ? 0 : a[yy * w + xx];
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) +
           (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  }

  // ----------------------------------------------------------- modelo de fondo
  /** Agrupa (k-means, k≤3) los colores del borde de la imagen: suelo + paredes, etc. */
  function analizarFondo(img, lab) {
    const w = img.width, h = img.height;
    const bw = Math.max(4, Math.round(Math.min(w, h) * 0.03));
    const pts = [], rgbs = [];
    const push = (x, y) => {
      const i = y * w + x;
      pts.push(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]);
      rgbs.push(img.data[i * 4], img.data[i * 4 + 1], img.data[i * 4 + 2]);
    };
    for (let y = 0; y < h; y += 2) {
      const lado = (y < bw || y >= h - bw);
      for (let x = 0; x < w; x += 2) {
        if (lado || x < bw || x >= w - bw) push(x, y);
      }
    }
    const n = pts.length / 3;
    const d2 = (i, c) => {
      const a = pts[i * 3] - c[0], b = pts[i * 3 + 1] - c[1], e = pts[i * 3 + 2] - c[2];
      return a * a + b * b + e * e;
    };
    // Inicialización por punto más lejano
    let mean = [0, 0, 0];
    for (let i = 0; i < n; i++) { mean[0] += pts[i * 3]; mean[1] += pts[i * 3 + 1]; mean[2] += pts[i * 3 + 2]; }
    mean = mean.map(v => v / n);
    const centros = [mean];
    for (let k = 1; k < 3; k++) {
      let best = -1, bd = -1;
      for (let i = 0; i < n; i++) {
        let m = Infinity;
        for (const c of centros) m = Math.min(m, d2(i, c));
        if (m > bd) { bd = m; best = i; }
      }
      centros.push([pts[best * 3], pts[best * 3 + 1], pts[best * 3 + 2]]);
    }
    const asign = new Uint8Array(n);
    for (let it = 0; it < 10; it++) {
      const suma = centros.map(() => [0, 0, 0, 0]);
      for (let i = 0; i < n; i++) {
        let bi = 0, bd = Infinity;
        for (let k = 0; k < centros.length; k++) { const d = d2(i, centros[k]); if (d < bd) { bd = d; bi = k; } }
        asign[i] = bi;
        const s = suma[bi]; s[0] += pts[i * 3]; s[1] += pts[i * 3 + 1]; s[2] += pts[i * 3 + 2]; s[3]++;
      }
      suma.forEach((s, k) => { if (s[3] > 0) centros[k] = [s[0] / s[3], s[1] / s[3], s[2] / s[3]]; });
    }
    // Estadísticas por cluster
    let cl = centros.map((c, k) => {
      let cnt = 0, sp = 0, r = 0, g = 0, b = 0;
      for (let i = 0; i < n; i++) if (asign[i] === k) {
        cnt++; sp += Math.sqrt(d2(i, c));
        r += rgbs[i * 3]; g += rgbs[i * 3 + 1]; b += rgbs[i * 3 + 2];
      }
      return { L: c[0], a: c[1], b: c[2], peso: cnt / n, spread: cnt ? sp / cnt : 0, rgb: cnt ? [r / cnt, g / cnt, b / cnt] : [0, 0, 0] };
    }).filter(c => c.peso > 0);
    // Fusionar los muy parecidos
    const dist = (p, q) => Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
    let fusionado = true;
    while (fusionado && cl.length > 1) {
      fusionado = false;
      outer: for (let i = 0; i < cl.length; i++) for (let j = i + 1; j < cl.length; j++) {
        if (dist(cl[i], cl[j]) < 8) {
          const p = cl[i], q = cl[j], t = p.peso + q.peso;
          const m = (u, v) => (u * p.peso + v * q.peso) / t;
          cl[i] = { L: m(p.L, q.L), a: m(p.a, q.a), b: m(p.b, q.b), peso: t,
                    spread: Math.max(p.spread, q.spread),
                    rgb: [m(p.rgb[0], q.rgb[0]), m(p.rgb[1], q.rgb[1]), m(p.rgb[2], q.rgb[2])] };
          cl.splice(j, 1); fusionado = true; break outer;
        }
      }
    }
    cl.sort((p, q) => q.peso - p.peso);
    const utiles = cl.filter((c, i) => i === 0 || c.peso >= 0.08);
    const dom = utiles[0];
    const spreadMax = Math.max(...utiles.map(c => c.spread));
    const croma = Math.hypot(dom.a, dom.b);
    const separados = utiles.length > 1 && utiles.some(c => dist(c, dom) > 14);
    return {
      centros: utiles, dominante: dom, rgb: dom.rgb.map(Math.round), spreadMax,
      claro: dom.L >= 72 && croma <= 22,
      uniforme: spreadMax <= 7 && !separados
    };
  }

  // -------------------------------------------------------------- segmentación
  function distanciasFondo(lab, n, fondo, wL) {
    const out = new Float32Array(n);
    const cs = fondo.centros;
    for (let i = 0; i < n; i++) {
      let m = Infinity;
      const L = lab[i * 3], a = lab[i * 3 + 1], b = lab[i * 3 + 2];
      for (let k = 0; k < cs.length; k++) {
        const dL = (L - cs[k].L) * wL, da = a - cs[k].a, db = b - cs[k].b;
        const d = dL * dL + da * da + db * db;
        if (d < m) m = d;
      }
      out[i] = Math.sqrt(m);
    }
    return out;
  }

  /** Region-growing desde el borde: devuelve Uint8Array con 1 = fondo. */
  function segmentarFondo(lab, w, h, fondo, tol, tolLocal, wL) {
    const n = w * h;
    const dist = distanciasFondo(lab, n, fondo, wL);
    const bg = new Uint8Array(n);
    const cola = new Int32Array(n);
    let ini = 0, fin = 0;
    const sembrar = (x, y) => {
      const i = y * w + x;
      if (!bg[i] && dist[i] < tol) { bg[i] = 1; cola[fin++] = i; }
    };
    for (let x = 0; x < w; x++) { sembrar(x, 0); sembrar(x, h - 1); }
    for (let y = 0; y < h; y++) { sembrar(0, y); sembrar(w - 1, y); }
    const tolDur = tol * 1.4;
    const dLocal = (i, j) => {
      const dL = (lab[i * 3] - lab[j * 3]) * wL, da = lab[i * 3 + 1] - lab[j * 3 + 1], db = lab[i * 3 + 2] - lab[j * 3 + 2];
      return Math.sqrt(dL * dL + da * da + db * db);
    };
    while (ini < fin) {
      const q = cola[ini++];
      const x = q % w, y = (q - x) / w;
      for (let k = 0; k < 4; k++) {
        let nx = x, ny = y;
        if (k === 0) nx--; else if (k === 1) nx++; else if (k === 2) ny--; else ny++;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const p = ny * w + nx;
        if (bg[p]) continue;
        const d = dist[p];
        if (d < tol || (d < tolDur && dLocal(p, q) < tolLocal)) { bg[p] = 1; cola[fin++] = p; }
      }
    }
    return { bg, dist };
  }

  /** Conserva el componente fg más grande y los ≥20 % de él; el resto pasa a fondo. */
  function limpiarComponentes(fg, w, h) {
    const n = w * h;
    const etiqueta = new Int32Array(n);
    const cola = new Int32Array(n);
    const areas = [0];
    let id = 0;
    for (let s = 0; s < n; s++) {
      if (!fg[s] || etiqueta[s]) continue;
      id++; let ini = 0, fin = 0; cola[fin++] = s; etiqueta[s] = id; let area = 0;
      while (ini < fin) {
        const q = cola[ini++]; area++;
        const x = q % w, y = (q - x) / w;
        if (x > 0 && fg[q - 1] && !etiqueta[q - 1]) { etiqueta[q - 1] = id; cola[fin++] = q - 1; }
        if (x < w - 1 && fg[q + 1] && !etiqueta[q + 1]) { etiqueta[q + 1] = id; cola[fin++] = q + 1; }
        if (y > 0 && fg[q - w] && !etiqueta[q - w]) { etiqueta[q - w] = id; cola[fin++] = q - w; }
        if (y < h - 1 && fg[q + w] && !etiqueta[q + w]) { etiqueta[q + w] = id; cola[fin++] = q + w; }
      }
      areas.push(area);
    }
    const maxA = Math.max(0, ...areas);
    const minA = Math.max(0.2 * maxA, 0.0015 * n);
    for (let i = 0; i < n; i++) if (fg[i] && areas[etiqueta[i]] < minA) fg[i] = 0;
    return fg;
  }

  function mayoria3x3(bin, w, h, iter) {
    let a = bin, b = new Uint8Array(bin.length);
    for (let it = 0; it < iter; it++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let c = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = clamp(y + dy, 0, h - 1);
          for (let dx = -1; dx <= 1; dx++) c += a[yy * w + clamp(x + dx, 0, w - 1)];
        }
        b[y * w + x] = c >= 5 ? 1 : 0;
      }
      const t = a; a = b; b = t;
    }
    return a;
  }

  // --------------------------------------------------- análisis (punto de entrada)
  /**
   * Analiza una imagen reducida. Devuelve un objeto `analisis` reutilizable para
   * componer con distintos métodos sin repetir el trabajo pesado.
   */
  function analizar(small, opciones) {
    const o = Object.assign({}, DEFAULTS, opciones);
    const w = small.width, h = small.height, n = w * h;
    const lab = imagenALab(small);
    const fondo = analizarFondo(small, lab);

    const claroUnif = fondo.claro && fondo.uniforme;
    // Fondo claro y liso: la luminosidad SÍ distingue pieza de fondo; las sombras se tratan aparte
    const wL = claroUnif ? 1.0 : o.pesoL;
    const tol = claroUnif ? clamp(5 + 2.2 * fondo.spreadMax, 9, 20) : clamp(6 + 2.2 * fondo.spreadMax, o.tolMin, o.tolMax);
    const { bg, dist } = segmentarFondo(lab, w, h, fondo, tol, o.tolLocal, wL);
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1;
    const analisis = construirAnalisisDesdeMascara(small, lab, fondo, fg, Object.assign({}, o, { _wL: wL, _tol: tol }));
    analisis.tol = tol;
    analisis.dist = dist;
    analisis._rgb = small.data;
    analisis.metodoSugerido = claroUnif ? 'blanquear' : 'recortar';
    analisis.blanquearPermitido = claroUnif;
    analisis._small = { width: w, height: h };
    return analisis;
  }

  /**
   * FASE 2 — punto de extensión: acepta cualquier máscara binaria (1 = pieza) del
   * tamaño de `small`, venga de region-growing o de un modelo de IA, y prepara
   * alfa suave, bbox y evaluación de calidad.
   */
  function construirAnalisisDesdeMascara(small, lab, fondo, fg, o) {
    o = Object.assign({}, DEFAULTS, o);
    const w = small.width, h = small.height, n = w * h;
    fg = limpiarComponentes(fg, w, h);
    fg = mayoria3x3(fg, w, h, 2);
    const wL = o._wL || o.pesoL, tolH = o._tol || 16;
    const dist = distanciasFondo(lab, n, fondo, wL);
    let sumD0 = 0, area0 = 0;
    for (let i = 0; i < n; i++) if (fg[i]) { sumD0 += dist[i]; area0++; }
    const contraste = area0 ? sumD0 / area0 : 0;
    // Agujeros pasantes: regiones internas del color del fondo -> transparentes (blanco en catálogo)
    if (o.huecosBlancos && contraste >= 25) {
      const H = new Uint8Array(n);
      for (let i = 0; i < n; i++) H[i] = (fg[i] && dist[i] < tolH * 0.7) ? 1 : 0;
      const etq = new Int32Array(n), cola = new Int32Array(n);
      for (let s0 = 0; s0 < n; s0++) {
        if (!H[s0] || etq[s0]) continue;
        let ini = 0, fin = 0; cola[fin++] = s0; etq[s0] = 1;
        while (ini < fin) {
          const q = cola[ini++]; const x = q % w, y = (q - x) / w;
          if (x > 0 && H[q - 1] && !etq[q - 1]) { etq[q - 1] = 1; cola[fin++] = q - 1; }
          if (x < w - 1 && H[q + 1] && !etq[q + 1]) { etq[q + 1] = 1; cola[fin++] = q + 1; }
          if (y > 0 && H[q - w] && !etq[q - w]) { etq[q - w] = 1; cola[fin++] = q - w; }
          if (y < h - 1 && H[q + w] && !etq[q + w]) { etq[q + w] = 1; cola[fin++] = q + w; }
        }
        if (fin >= 0.0008 * n) for (let k = 0; k < fin; k++) fg[cola[k]] = 0;
      }
    }

    // Alfa suave: blur ligero + curva que desplaza el borde ligeramente hacia dentro (menos halo)
    const alfa = new Float32Array(n);
    for (let i = 0; i < n; i++) alfa[i] = fg[i];
    boxBlur(alfa, w, h, 1, 2);
    for (let i = 0; i < n; i++) alfa[i] = smoothstep(0.30, 0.80, alfa[i]);

    // bbox y estadísticas
    let x0 = w, y0 = h, x1 = -1, y1 = -1, area = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (fg[y * w + x]) { area++; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    const bbox = area ? { x0, y0, x1: x1 + 1, y1: y1 + 1 } : null;
    const bw = 3; let anillo = 0, anilloFg = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x < bw || y < bw || x >= w - bw || y >= h - bw) { anillo++; anilloFg += fg[y * w + x]; }
    }
    const fgFrac = area / n, bordeFg = anilloFg / anillo;
    const avisos = []; let nivel = 'ok';
    const sube = (nv) => { if (nv === 'mala' || (nv === 'dudosa' && nivel === 'ok')) nivel = nv; };
    if (fgFrac < 0.015) { avisos.push('No se detecta la pieza (¿fondo demasiado parecido?).'); sube('mala'); }
    if (fgFrac > 0.80) { avisos.push('No se ha podido separar el fondo.'); sube('mala'); }
    if (bordeFg > 0.25) { avisos.push('La pieza toca los bordes o el fondo no es uniforme: aléjate un poco.'); sube('dudosa'); }
    if (!fondo.uniforme && fondo.centros.length >= 3) { avisos.push('El fondo no es uniforme (estantería o gaveta): revisa los bordes.'); sube('dudosa'); }
    if (area && contraste < 20) { avisos.push('Poco contraste con el fondo: puede comerse partes de la pieza.'); sube('dudosa'); }

    return {
      small: { width: w, height: h }, lab, fondo, fg, alfa, bbox,
      calidad: { nivel, avisos, fgFrac, bordeFg, contraste },
      opciones: o, _iluminacion: null
    };
  }

  /** En fondo claro la máscara base es estricta (conserva sombras). Para 'recortar' se usa otra. */
  function analisisParaRecortar(an) {
    if (!an.blanquearPermitido) return an;
    if (an._rec) return an._rec;
    const o = an.opciones, w = an._small.width, h = an._small.height, n = w * h;
    const tol = clamp(6 + 2.2 * an.fondo.spreadMax, o.tolMin, o.tolMax);
    const wL = Math.max(o.pesoL, 0.6);
    const { bg } = segmentarFondo(an.lab, w, h, an.fondo, tol, o.tolLocal, wL);
    const fg = new Uint8Array(n);
    for (let i = 0; i < n; i++) fg[i] = bg[i] ? 0 : 1;
    const rec = construirAnalisisDesdeMascara(an._small, an.lab, an.fondo, fg, Object.assign({}, o, { _wL: wL, _tol: tol }));
    rec.tol = tol; rec._rgb = an._rgb; rec.blanquearPermitido = false; rec.metodoSugerido = 'recortar';
    an._rec = rec;
    return rec;
  }

  // ------------------------------------------------------------------ encuadre
  function calcularEncuadre(an, srcW, srcH, o) {
    const w = an.small.width, h = an.small.height;
    const ratio = srcW / w;
    const S = o.salida;
    if (!o.encuadrar || !an.bbox || an.calidad.nivel === 'mala') {
      const side = Math.max(w, h);
      return { cx: w / 2, cy: h / 2, side, ratio, S };
    }
    const b = an.bbox;
    const bw = b.x1 - b.x0, bh = b.y1 - b.y0;
    let side = Math.max(bw, bh) * (1 + 2 * o.margen);
    side = Math.max(side, S / (o.zoomMax * ratio));          // limita la ampliación
    // Un poco de sitio extra para la sombra: desplazar el centro ligeramente hacia arriba
    return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + b.y1) / 2 + side * 0.01, side, ratio, S };
  }

  // ----------------------------------------------------------------- iluminación
  function estimarIluminacion(an) {
    if (an._iluminacion) return an._iluminacion;
    const { width: w, height: h } = an.small;
    const o = an.opciones;
    // Fondo "estricto" (sin sombras) para no contaminar la estimación
    const { bg } = segmentarFondo(an.lab, w, h, an.fondo, Math.max(8, (an.tol || 16) * 0.7), 2.5, 1.0);
    const celda = Math.max(w, h) / 24;
    const gw = Math.ceil(w / celda), gh = Math.ceil(h / celda);
    const suma = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh);
    const rgbSrc = an._rgb;                                  // RGBA de la copia reducida (lo fija analizar)
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!bg[i]) continue;
      const g = Math.floor(y / celda) * gw + Math.floor(x / celda);
      suma[g * 3] += rgbSrc[i * 4]; suma[g * 3 + 1] += rgbSrc[i * 4 + 1]; suma[g * 3 + 2] += rgbSrc[i * 4 + 2]; cnt[g]++;
    }
    const grid = new Float32Array(gw * gh * 3).fill(NaN);
    const minPix = 0.2 * celda * celda;
    let validas = 0;
    for (let g = 0; g < gw * gh; g++) if (cnt[g] >= minPix) {
      for (let c = 0; c < 3; c++) grid[g * 3 + c] = suma[g * 3 + c] / cnt[g];
      validas++;
    }
    if (!validas) {
      for (let g = 0; g < gw * gh; g++) for (let c = 0; c < 3; c++) grid[g * 3 + c] = an.fondo.rgb[c];
    } else {
      for (let pasada = 0; pasada < 60; pasada++) {            // difusión hacia celdas vacías
        let vacias = 0; const copia = grid.slice();
        for (let gy = 0; gy < gh; gy++) for (let gx = 0; gx < gw; gx++) {
          const g = gy * gw + gx;
          if (!isNaN(copia[g * 3])) continue;
          let s0 = 0, s1 = 0, s2 = 0, c = 0;
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            const yy = gy + dy, xx = gx + dx;
            if (yy < 0 || xx < 0 || yy >= gh || xx >= gw) continue;
            const q = yy * gw + xx;
            if (!isNaN(copia[q * 3])) { s0 += copia[q * 3]; s1 += copia[q * 3 + 1]; s2 += copia[q * 3 + 2]; c++; }
          }
          if (c) { grid[g * 3] = s0 / c; grid[g * 3 + 1] = s1 / c; grid[g * 3 + 2] = s2 / c; } else vacias++;
        }
        if (!vacias) break;
      }
    }
    const suave = new Float32Array(w * h);
    for (let i = 0; i < suave.length; i++) suave[i] = bg[i];
    an._bgSuave = boxBlur(suave, w, h, 2, 2);
    an._iluminacion = { grid, gw, gh, celda };
    return an._iluminacion;
  }

  function muestrearIlum(il, x, y, c) {      // x,y en coordenadas de la copia reducida
    const gx = x / il.celda - 0.5, gy = y / il.celda - 0.5;
    const x0 = Math.floor(gx), y0 = Math.floor(gy), fx = gx - x0, fy = gy - y0;
    const g = (xx, yy) => il.grid[(clamp(yy, 0, il.gh - 1) * il.gw + clamp(xx, 0, il.gw - 1)) * 3 + c];
    return (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
  }

  // ------------------------------------------------------------------ composición
  function muestrearRGB(src, x, y, out) {  // bilinear; fuera → blanco
    x -= 0.5; y -= 0.5;
    const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0;
    const W = src.width, H = src.height, d = src.data;
    for (let c = 0; c < 3; c++) {
      const g = (xx, yy) => (xx < 0 || yy < 0 || xx >= W || yy >= H) ? 255 : d[(yy * W + xx) * 4 + c];
      out[c] = (g(x0, y0) * (1 - fx) + g(x0 + 1, y0) * fx) * (1 - fy) + (g(x0, y0 + 1) * (1 - fx) + g(x0 + 1, y0 + 1) * fx) * fy;
    }
  }

  /** Mapa de sombra (M×M) alineado con el encuadre de salida. */
  function mapaSombra(an, enc, M, intensidad) {
    const { width: w, height: h } = an.small;
    const A = new Float32Array(M * M);
    for (let my = 0; my < M; my++) for (let mx = 0; mx < M; mx++) {
      const lx = enc.cx + ((mx + 0.5) / M - 0.5) * enc.side;
      const ly = enc.cy + ((my + 0.5) / M - 0.5) * enc.side;
      A[my * M + mx] = muestrearF(an.alfa, w, h, lx, ly);
    }
    const desplazar = (src, dy) => {
      const o = new Float32Array(M * M);
      for (let y = 0; y < M; y++) { const sy = y - dy; if (sy < 0 || sy >= M) continue; o.set(src.subarray(sy * M, sy * M + M), y * M); }
      return o;
    };
    const suave = boxBlur(desplazar(A, Math.round(0.016 * M)), M, M, Math.max(2, Math.round(0.022 * M)), 3);
    const contacto = boxBlur(desplazar(A, Math.max(1, Math.round(0.004 * M))), M, M, Math.max(1, Math.round(0.007 * M)), 2);
    const S = new Float32Array(M * M);
    for (let i = 0; i < S.length; i++) {
      const s1 = clamp(suave[i] * 0.30, 0, 1), s2 = clamp(contacto[i] * 0.32, 0, 1);
      S[i] = clamp((1 - (1 - s1) * (1 - s2)) * intensidad, 0, 0.6);
    }
    return S;
  }

  /**
   * Genera la imagen final cuadrada.
   * @param full  imagen a resolución completa {data,width,height}
   * @param an    resultado de analizar()
   * @param metodo 'blanquear' | 'recortar' | 'auto'
   */
  function componer(full, an, metodo, opciones) {
    const o = Object.assign({}, an.opciones, opciones);
    if (!metodo || metodo === 'auto') metodo = an.metodoSugerido;
    if (metodo === 'blanquear' && !an.blanquearPermitido) metodo = 'recortar';   // solo válido con fondo claro y liso
    if (metodo === 'recortar') an = analisisParaRecortar(an);
    const { width: w, height: h } = an.small;
    const enc = calcularEncuadre(an, full.width, full.height, o);
    const S = o.salida;
    const out = new Uint8ClampedArray(S * S * 4);
    const px = [0, 0, 0];
    const kx = full.width / w, ky = full.height / h;

    if (metodo === 'blanquear') {
      const il = estimarIluminacion(an);
      const suave = an._bgSuave;
      for (let oy = 0; oy < S; oy++) for (let ox = 0; ox < S; ox++) {
        const lx = enc.cx + ((ox + 0.5) / S - 0.5) * enc.side;
        const ly = enc.cy + ((oy + 0.5) / S - 0.5) * enc.side;
        const p = (oy * S + ox) * 4;
        if (lx < 0 || ly < 0 || lx >= w || ly >= h) { out[p] = out[p + 1] = out[p + 2] = 255; out[p + 3] = 255; continue; }
        muestrearRGB(full, lx * kx, ly * ky, px);
        let r = px[0] / Math.max(40, muestrearIlum(il, lx, ly, 0)) * 255;
        let g = px[1] / Math.max(40, muestrearIlum(il, lx, ly, 1)) * 255;
        let b = px[2] / Math.max(40, muestrearIlum(il, lx, ly, 2)) * 255;
        r = clamp(r, 0, 255); g = clamp(g, 0, 255); b = clamp(b, 0, 255);
        const Y = 0.299 * r + 0.587 * g + 0.114 * b;
        // casi-blanco → blanco, SOLO donde es fondo (no borra detalles claros de la pieza ni la sombra)
        const t = smoothstep(222, 248, Y) * smoothstep(0.35, 0.9, muestrearF(suave, w, h, lx, ly));
        out[p] = r + (255 - r) * t; out[p + 1] = g + (255 - g) * t; out[p + 2] = b + (255 - b) * t; out[p + 3] = 255;
      }
    } else {
      const M = 256;
      const sombra = o.sombra > 0 ? mapaSombra(an, enc, M, o.sombra) : null;
      const bgc = an.fondo.rgb;
      for (let oy = 0; oy < S; oy++) for (let ox = 0; ox < S; ox++) {
        const lx = enc.cx + ((ox + 0.5) / S - 0.5) * enc.side;
        const ly = enc.cy + ((oy + 0.5) / S - 0.5) * enc.side;
        const p = (oy * S + ox) * 4;
        const a = muestrearF(an.alfa, w, h, lx, ly);
        const sh = sombra ? muestrearF(sombra, M, M, (ox + 0.5) / S * M, (oy + 0.5) / S * M) : 0;
        const base = 255 * (1 - sh);
        if (a <= 0.004) { out[p] = out[p + 1] = out[p + 2] = base; out[p + 3] = 255; continue; }
        muestrearRGB(full, lx * kx, ly * ky, px);
        let r = px[0], g = px[1], b = px[2];
        if (a < 0.98) {                                      // descontaminar halo del fondo original
          const ia = Math.max(a, 0.35);
          r = clamp((r - (1 - ia) * bgc[0]) / ia, 0, 255);
          g = clamp((g - (1 - ia) * bgc[1]) / ia, 0, 255);
          b = clamp((b - (1 - ia) * bgc[2]) / ia, 0, 255);
        }
        out[p] = r * a + base * (1 - a); out[p + 1] = g * a + base * (1 - a); out[p + 2] = b * a + base * (1 - a); out[p + 3] = 255;
      }
    }
    return { image: { data: out, width: S, height: S }, metodo, calidad: an.calidad };
  }

  // =================================================================== NAVEGADOR
  /** Sesión de trabajo sobre una foto: analiza una vez y permite recomponer. */
  async function crearSesion(dataUrl, opciones) {
    const o = Object.assign({}, DEFAULTS, opciones);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
    const aCanvas = (ancho, alto) => { const c = document.createElement('canvas'); c.width = ancho; c.height = alto; return c; };

    const cF = aCanvas(img.naturalWidth, img.naturalHeight);
    const xF = cF.getContext('2d', { willReadFrequently: true });
    xF.drawImage(img, 0, 0);
    const full = xF.getImageData(0, 0, cF.width, cF.height);

    const k = Math.min(1, o.trabajoLado / Math.max(cF.width, cF.height));
    const cS = aCanvas(Math.round(cF.width * k), Math.round(cF.height * k));
    const xS = cS.getContext('2d', { willReadFrequently: true });
    xS.drawImage(cF, 0, 0, cS.width, cS.height);
    const small = xS.getImageData(0, 0, cS.width, cS.height);

    const an = analizar(small, o);

    return {
      calidad: an.calidad,
      metodoSugerido: an.metodoSugerido,
      blanquearPermitido: an.blanquearPermitido,
      componer(metodo, extra) {
        const r = componer(full, an, metodo, extra);
        const c = aCanvas(r.image.width, r.image.height);
        c.getContext('2d').putImageData(new ImageData(r.image.data, r.image.width, r.image.height), 0, 0);
        return { dataUrl: c.toDataURL('image/jpeg', o.calidadJpeg), metodo: r.metodo, calidad: r.calidad };
      }
    };
  }

  const API = {
    DEFAULTS, crearSesion,
    // núcleo (también para pruebas en Node)
    analizar, componer, reducir, construirAnalisisDesdeMascara, analizarFondo, imagenALab
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  else root.FotoMejora = API;

})(typeof window !== 'undefined' ? window : globalThis);
