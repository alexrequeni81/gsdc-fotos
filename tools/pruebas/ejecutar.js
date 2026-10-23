/* Ejecuta el pipeline de public/foto-mejora.js sobre las escenas generadas (sin navegador).
 * Uso:  node ejecutar.js A_verde B_claro ...   → escribe escenas/out_<nombre>_<metodo>.raw
 * Después:  python3 montaje.py montaje.png A_verde B_claro ...
 */
const fs = require('fs'), path = require('path');
const FM = require(path.join(__dirname, '..', '..', 'public', 'foto-mejora.js'));
function leer(f) { const b = fs.readFileSync(f); const w = b.readUInt32LE(0), h = b.readUInt32LE(4);
  return { width: w, height: h, data: new Uint8ClampedArray(b.buffer.slice(b.byteOffset + 8, b.byteOffset + 8 + w * h * 4)) }; }
for (const n of process.argv.slice(2)) {
  const full = leer(path.join('escenas', n + '.raw'));
  const t0 = Date.now(); const an = FM.analizar(FM.reducir(full, 800), {});
  console.log(n, '| sugerido:', an.metodoSugerido, '| calidad:', an.calidad.nivel, an.calidad.avisos.join(' '), '| análisis', Date.now() - t0, 'ms');
  for (const m of ['blanquear', 'recortar']) {
    const im = FM.componer(full, an, m).image;
    const out = Buffer.concat([Buffer.alloc(8), Buffer.from(im.data.buffer)]); out.writeUInt32LE(im.width, 0); out.writeUInt32LE(im.height, 4);
    fs.writeFileSync(path.join('escenas', `out_${n}_${m}.raw`), out);
  }
}
