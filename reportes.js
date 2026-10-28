/* Búsqueda por sección y dirección (CDMX), modos de filtro y reportes con vista previa.
   Se carga después del script principal de index.html. */

// ---- Capas complementarias (opcionales) ----
const ARCHIVO_COLONIAS = 'Colonias.geojson';
const ARCHIVO_CALLES = 'calles y avenidas.geojson';
const NOMBRES_COLONIA = ['COLONIA'];
// Calle = TIPOVIAL + NOMVIAL (ej. "AVENIDA INSURGENTES")
function nombreCalle(props) {
  const nom = nombreDe(props, ['NOMVIAL']);
  const tipo = nombreDe(props, ['TIPOVIAL']);
  return nom ? (tipo ? tipo + ' ' + nom : nom) : '';
}
const CDMX_VIEWBOX = '-99.37,19.6,-98.94,19.04'; // lon izq, lat arriba, lon der, lat abajo

let datosColonias = null;
let datosCalles = null;
let modoFiltro = 'distrito';
let seccionActiva = null;
let marcadorDir = null;
let resaltado = null;
let mapasReporte = [];

// ---- Utilidades ----
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const listaFeatures = g => !g ? [] : (g.type === 'FeatureCollection' ? g.features : [g]);
const anillosExteriores = geom => {
  if (!geom) return [];
  const polis = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
  return polis.map(p => p[0]);
};
const lineasDe = geom => !geom ? [] : geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
const nombreDe = (props, claves) => { const v = obtenerValorAtributo(props, claves); return v ? String(v).trim() : ''; };
function bboxDe(puntos) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  for (const [x, y] of puntos) { x1 = Math.min(x1, x); y1 = Math.min(y1, y); x2 = Math.max(x2, x); y2 = Math.max(y2, y); }
  return { x1, y1, x2, y2 };
}
const bboxSeSolapan = (a, b) => a.x1 <= b.x2 && b.x1 <= a.x2 && a.y1 <= b.y2 && b.y1 <= a.y2;
function puntoEnAnillo(x, y, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
const contienePunto = (f, lng, lat) => anillosExteriores(f.geometry).some(a => puntoEnAnillo(lng, lat, a));

// ---- Análisis espacial de una sección ----
function coloniasDeSeccion(sec) {
  const anillos = anillosExteriores(sec.geometry);
  const bb = bboxDe(anillos.flat());
  const res = [];
  listaFeatures(datosColonias).forEach(c => {
    const nombre = nombreDe(c.properties, NOMBRES_COLONIA);
    if (!c.geometry || !nombre) return;
    const cAn = anillosExteriores(c.geometry);
    c._bb ??= bboxDe(cAn.flat());
    if (!bboxSeSolapan(bb, c._bb)) return;
    const toca = cAn.some(ca => ca.some(([x, y]) => anillos.some(a => puntoEnAnillo(x, y, a))))
      || anillos.some(a => a.some(([x, y]) => cAn.some(ca => puntoEnAnillo(x, y, ca))));
    if (toca) res.push({ nombre, feature: c });
  });
  return res;
}
function callesLimiteDe(sec) {
  const anillos = anillosExteriores(sec.geometry);
  const bb = bboxDe(anillos.flat());
  const res = [];
  listaFeatures(datosCalles).forEach(c => {
    const nombre = nombreCalle(c.properties);
    if (!c.geometry || !nombre) return;
    const lineas = lineasDe(c.geometry);
    c._bb ??= bboxDe(lineas.flat());
    if (!bboxSeSolapan(bb, c._bb)) return;
    const cruza = lineas.some(linea => linea.some((p, i) => i > 0 &&
      anillos.some(a => a.some((q, j) => j > 0 && segmentosSeCruzan(linea[i - 1], p, a[j - 1], q)))));
    if (cruza) res.push({ nombre, feature: c });
  });
  return res;
}

function resumenSeccion(f) {
  const p = f.properties;
  const v = obtenerValorAtributo(p, ['TOTAL DE FIRMAS', 'TOTALDEFIRMAS']);
  const sinDato = v === null || v === undefined || v === '';
  const rec = sinDato ? 0 : (parseFloat(v) || 0);
  let estado = 'Sin dato', color = '#64748b';
  if (!sinDato && rec >= 10) { estado = 'Completada'; color = '#16a34a'; }
  else if (!sinDato && rec >= 5) { estado = 'En proceso'; color = '#eab308'; }
  else if (!sinDato && rec > 0) { estado = 'Crítica'; color = '#dc2626'; }
  else if (!sinDato) { estado = 'Sin firmas'; color = '#7f1d1d'; }
  return {
    seccion: p.SECCION ?? 'N/A', distrito: p.DISTRITO_L || 'N/A',
    sinDato, rec, falta: Math.max(0, META_POR_SECCION - rec), estado, color
  };
}
const htmlResumen = r => `<div class="text-xs"><b>Sección ${esc(r.seccion)}</b><br>
  Distrito: ${esc(r.distrito)}<br>
  Firmas: ${r.sinDato ? 'N/A' : r.rec} · Faltan: ${r.sinDato ? 'N/A' : r.falta}<br>
  <b style="color:${r.color}">${r.estado}</b></div>`;

// ---- Modos de filtro ----
function setModo(m) {
  modoFiltro = m;
  document.querySelectorAll('.btn-modo').forEach(b => b.classList.toggle('activo', b.dataset.modo === m));
  ['distrito', 'seccion', 'ubicacion'].forEach(k => document.getElementById('panel-' + k).classList.toggle('oculto', k !== m));
}

let resaltadoLayer = null;
function resaltarSeccion(f, ajustar) {
  if (resaltado) resaltado.remove();
  resaltado = L.geoJSON(f, { interactive: false, style: { color: '#7c3aed', weight: 4, fillColor: '#7c3aed', fillOpacity: 0.08, dashArray: '6,4' } }).addTo(map);
  const b = resaltado.getBounds();
  if (ajustar) map.fitBounds(b, { padding: [40, 40] });
  return b;
}

function buscarSeccion() {
  const num = document.getElementById('input-seccion').value.trim();
  const msg = document.getElementById('msg-seccion');
  const sec = listaFeatures(datosSeccionesGeoJSON).find(f => String(f.properties.SECCION).trim() === num);
  if (!sec) { seccionActiva = null; msg.textContent = `No encontré la sección ${num}.`; return; }
  seccionActiva = sec;
  msg.textContent = '';
  const b = resaltarSeccion(sec, true);
  L.popup().setLatLng(b.getCenter()).setContent(htmlResumen(resumenSeccion(sec))).openOn(map);
}

async function buscarDireccion() {
  const calle = document.getElementById('input-calle').value.trim();
  const numero = document.getElementById('input-numero').value.trim();
  const colonia = document.getElementById('input-colonia').value.trim();
  const msg = document.getElementById('msg-direccion');
  if (!calle) { msg.textContent = 'Escribe al menos la calle o avenida.'; return; }
  msg.textContent = 'Buscando…';
  const q = [calle, numero, colonia, 'Ciudad de México', 'México'].filter(Boolean).join(', ');
  const url = 'https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=1&limit=5&countrycodes=mx&bounded=1&accept-language=es&viewbox='
    + CDMX_VIEWBOX + '&q=' + encodeURIComponent(q);
  let lista;
  try {
    lista = await (await fetch(url)).json();
  } catch (e) {
    msg.textContent = 'No se pudo consultar el buscador de direcciones. Revisa tu conexión.';
    return;
  }
  const r = (Array.isArray(lista) ? lista : []).find(x => /Ciudad de M[ée]xico|CDMX/i.test(x.display_name));
  if (!r) { msg.textContent = 'No encontré esa dirección dentro de la CDMX. Revisa la escritura o agrega la colonia.'; return; }
  const lat = parseFloat(r.lat), lng = parseFloat(r.lon);
  const sec = listaFeatures(datosSeccionesGeoJSON).find(f => contienePunto(f, lng, lat)) || null;
  seccionActiva = sec;
  if (marcadorDir) marcadorDir.remove();
  const info = sec ? htmlResumen(resumenSeccion(sec)) : '<i>Fuera de las secciones cargadas</i>';
  marcadorDir = L.marker([lat, lng]).addTo(map).bindPopup(`${esc(r.display_name)}<br>${info}`).openPopup();
  map.setView([lat, lng], 17);
  if (sec) resaltarSeccion(sec, false);
  msg.textContent = sec ? `Ubicado en la sección ${sec.properties.SECCION}.` : 'Ubicado, pero fuera de las secciones.';
}

// ---- Reportes: hojas ----
function seccionesParaReporte() {
  if (modoFiltro !== 'distrito') return seccionActiva ? [seccionActiva] : [];
  return seleccionSecciones;
}

const crearHoja = html => {
  const el = document.createElement('section');
  el.className = 'hoja';
  el.innerHTML = html;
  return el;
};

function hojaSeccion(f, fecha) {
  const r = resumenSeccion(f);
  const colonias = coloniasDeSeccion(f);
  const calles = callesLimiteDe(f);
  const nombresCol = [...new Set(colonias.map(c => c.nombre))].sort();
  const nombresCalle = [...new Set(calles.map(c => c.nombre))].sort();
  const lista = (arr, vacio) => arr.length ? arr.map(n => `<li>${esc(n)}</li>`).join('') : `<li>${vacio}</li>`;
  const el = crearHoja(`
    <div class="hoja-mapa-wrap"><div class="hoja-mapa"></div></div>
    <aside class="hoja-datos">
      <h2>Sección ${esc(r.seccion)}</h2>
      <p class="sub">${esc(r.distrito)} · Generado ${fecha}</p>
      <div class="kpis">
        <div><span>Meta</span><b>${META_POR_SECCION}</b></div>
        <div><span>Firmas</span><b style="color:#15803d">${r.sinDato ? 'N/A' : r.rec}</b></div>
        <div><span>Faltan</span><b style="color:#dc2626">${r.sinDato ? 'N/A' : r.falta}</b></div>
      </div>
      <div class="estado" style="background:${r.color}">${r.estado}</div>
      <h3>Colonias que conforman la sección</h3>
      <ul>${lista(nombresCol, 'Sin capa de colonias cargada')}</ul>
      <h3>Entre calles y avenidas (límites)</h3>
      <ul>${lista(nombresCalle, 'Sin capa de calles cargada')}</ul>
    </aside>`);
  return {
    el,
    dibujar(m) {
      const seccion = L.geoJSON(f, { style: { color: '#0f172a', weight: 3, fillColor: r.color, fillOpacity: 0.2 } }).addTo(m);
      colonias.forEach(c => L.geoJSON(c.feature, { interactive: false, style: { color: '#7c3aed', weight: 1.5, dashArray: '4,4', fillOpacity: 0 } })
        .addTo(m).eachLayer(l => l.bindTooltip(esc(c.nombre), { permanent: true, direction: 'center', className: 'etq-colonia' })));
      calles.forEach(c => L.geoJSON(c.feature, { interactive: false, style: { color: '#ea580c', weight: 4 } }).addTo(m));
      return seccion.getBounds();
    }
  };
}

function hojaDistrito(d, secs, geo, fecha) {
  const res = secs.map(resumenSeccion).sort((a, b) => Number(a.seccion) - Number(b.seccion));
  const grupos = { verde: [], amarillo: [], rojo: [], cero: [], gris: [] };
  let meta = 0, rec = 0, falta = 0;
  res.forEach(r => {
    if (r.sinDato) { grupos.gris.push(r); return; }
    meta += META_POR_SECCION; rec += r.rec; falta += r.falta;
    if (r.rec >= 10) grupos.verde.push(r);
    else if (r.rec >= 5) grupos.amarillo.push(r);
    else if (r.rec > 0) grupos.rojo.push(r);
    else grupos.cero.push(r);
  });
  const pct = meta ? Math.round((rec / meta) * 100) : 0;
  const bloque = (titulo, arr) => arr.length
    ? `<h3>${titulo} (${arr.length})</h3><ul>${arr.map(r => `<li>${esc(r.seccion)}${r.sinDato ? '' : ' · ' + r.rec}</li>`).join('')}</ul>`
    : '';
  const el = crearHoja(`
    <div class="hoja-mapa-wrap"><div class="hoja-mapa"></div></div>
    <aside class="hoja-datos">
      <h2>Distrito Local ${esc(d)}</h2>
      <p class="sub">${res.length} secciones · Generado ${fecha}</p>
      <div class="kpis">
        <div><span>Meta total</span><b>${meta}</b></div>
        <div><span>Recabadas</span><b style="color:#15803d">${rec}</b></div>
        <div><span>Faltantes</span><b style="color:#dc2626">${falta}</b></div>
      </div>
      <div class="estado" style="background:#003366">Avance general: ${pct}%</div>
      <div class="kpis">
        <div><span>Completadas</span><b style="color:#16a34a">${grupos.verde.length}</b></div>
        <div><span>En proceso</span><b style="color:#ca8a04">${grupos.amarillo.length}</b></div>
        <div><span>Críticas</span><b style="color:#dc2626">${grupos.rojo.length}</b></div>
      </div>
      ${bloque('Críticas (1 a 4)', grupos.rojo)}
      ${bloque('Sin firmas (0)', grupos.cero)}
      ${bloque('En proceso (5 a 9)', grupos.amarillo)}
      ${bloque('Completadas (10+)', grupos.verde)}
      ${bloque('Sin dato', grupos.gris)}
    </aside>`);
  return {
    el,
    dibujar(m) {
      const cap = L.geoJSON({ type: 'FeatureCollection', features: secs }, { style: f => estiloSeccion(f, 0.45, 0.8) }).addTo(m);
      if (geo) L.geoJSON(geo, { interactive: false, style: { color: '#8b0000', weight: 3, fillOpacity: 0, dashArray: '6,6' } }).addTo(m);
      return (geo ? L.geoJSON(geo) : cap).getBounds();
    }
  };
}

// ---- Vista previa e impresión ----
function crearVistaPrevia() {
  if (document.getElementById('hojas')) return;
  const o = document.createElement('div');
  o.id = 'hojas';
  o.innerHTML = `<div class="barra-hojas no-imprimir">
      <b>Vista previa del reporte</b> <span id="hojas-estado"></span>
      <span style="flex:1"></span>
      <button class="btn-barra" onclick="window.print()">🖨️ Imprimir / Guardar PDF</button>
      <button class="btn-barra" onclick="cerrarVistaPrevia()">Cerrar</button>
    </div>
    <div id="hojas-cuerpo"></div>`;
  document.body.appendChild(o);
}

function limpiarVistaPrevia() {
  mapasReporte.forEach(m => m.remove());
  mapasReporte = [];
  document.getElementById('hojas-cuerpo').innerHTML = '';
}

function cerrarVistaPrevia() {
  limpiarVistaPrevia();
  document.getElementById('hojas').classList.remove('abierto');
}

async function abrirVistaPrevia(hojas) {
  crearVistaPrevia();
  limpiarVistaPrevia();
  const cuerpo = document.getElementById('hojas-cuerpo');
  const estado = document.getElementById('hojas-estado');
  hojas.forEach(h => cuerpo.appendChild(h.el));
  document.getElementById('hojas').classList.add('abierto');
  const n = hojas.length;
  estado.textContent = `(${n} hoja${n === 1 ? '' : 's'}, preparando mapas…)`;
  const cargas = hojas.map(h => {
    const m = L.map(h.el.querySelector('.hoja-mapa'), { zoomControl: false, zoomSnap: 0.25, zoomAnimation: false, fadeAnimation: false });
    mapasReporte.push(m);
    const b = h.dibujar(m);
    if (b.isValid()) m.fitBounds(b, { padding: [24, 24], animate: false });
    else m.setView([19.4326, -99.1332], 11, { animate: false });
    return registrarCargaTeselas(L.tileLayer(URL_TELAS, { attribution: ATRIBUCION, maxZoom: 19 }).addTo(m));
  });
  await Promise.all(cargas);
  estado.textContent = `(${n} hoja${n === 1 ? '' : 's'} listas)`;
}

async function generarReporte(tipo) {
  if (!datosSeccionesGeoJSON) { alert('Todavía no se cargan las secciones.'); return; }
  const fecha = new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  let hojas;
  if (tipo === 'seccion') {
    const lista = seccionesParaReporte();
    if (!lista.length) {
      alert(modoFiltro === 'distrito' ? 'No hay secciones con este filtro.' : 'Primero busca una sección o una dirección.');
      return;
    }
    hojas = lista.map(f => hojaSeccion(f, fecha));
  } else {
    const sel = document.getElementById('select-distrito').value;
    const geos = { '11': datosDistrito11GeoJSON, '15': datosDistrito15GeoJSON };
    hojas = ['11', '15'].filter(d => sel === 'TODOS' || sel === d).map(d =>
      hojaDistrito(d, listaFeatures(datosSeccionesGeoJSON).filter(f => String(f.properties.DISTRITO_L || '').trim() === d), geos[d], fecha));
  }
  await abrirVistaPrevia(hojas);
}

// ---- Arranque ----
async function leerGeojson(archivo) {
  try {
    const r = await fetch(archivo);
    return r.ok ? await r.json() : null;
  } catch (e) { return null; }
}

window.addEventListener('load', async () => {
  datosColonias = await leerGeojson(ARCHIVO_COLONIAS);
  datosCalles = await leerGeojson(ARCHIVO_CALLES);
  ['input-seccion', 'input-calle', 'input-numero', 'input-colonia'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (id === 'input-seccion') buscarSeccion(); else buscarDireccion();
    }));
});
