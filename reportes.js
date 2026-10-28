/* Búsqueda por sección y dirección (CDMX), modos de filtro y reporte general por distrito.
   Se carga después del script principal de index.html. */

let modoFiltro = 'distrito';
let seccionActiva = null;
let marcadorDir = null;
let resaltado = null;
let mapasReporte = [];

const FILL_GRUPO = { verde: '#22c55e', amarillo: '#eab308', rojo: '#ef4444', gris: '#94a3b8' };
const TITULO_GRUPO = { verde: '#15803d', amarillo: '#a16207', rojo: '#b91c1c', gris: '#475569' };
const CLASE_GRUPO = { verde: 'bg-meta-ok', amarillo: 'bg-meta-proceso', rojo: 'bg-meta-critico', gris: 'bg-meta-na' };
const NOMBRE_GRUPO = { verde: 'Completadas (10 o más)', amarillo: 'En proceso (5 a 9)', rojo: 'Críticas (1 a 4)', gris: 'Sin firmas (0) / sin dato' };
const ORDEN_TABLAS = ['rojo', 'gris', 'verde', 'amarillo'];
const CENTRO_CDMX = [19.4326, -99.1332];
const CDMX_VIEWBOX = '-99.37,19.6,-98.94,19.04'; // lon izq, lat arriba, lon der, lat abajo

// ---- Utilidades ----
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const listaFeatures = g => !g ? [] : (g.type === 'FeatureCollection' ? g.features : [g]);
const porSeccion = (a, b) => Number(a.seccion) - Number(b.seccion);

function puntoEnAnillo(x, y, anillo) {
  let dentro = false;
  for (let i = 0, j = anillo.length - 1; i < anillo.length; j = i++) {
    const [xi, yi] = anillo[i], [xj, yj] = anillo[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) dentro = !dentro;
  }
  return dentro;
}
function contienePunto(f, lng, lat) {
  const g = f.geometry;
  if (!g) return false;
  const polis = g.type === 'MultiPolygon' ? g.coordinates : [g.coordinates];
  return polis.some(p => puntoEnAnillo(lng, lat, p[0]));
}

// ---- Datos por sección ----
const TEXTO_ESTADO = { verde: 'Completada (10+)', amarillo: 'En proceso (5-9)', rojo: 'Crítica (1-4)', gris: 'Sin firmas (0)' };
function resumenSeccion(f) {
  const p = f.properties;
  const v = obtenerValorAtributo(p, ['TOTAL DE FIRMAS', 'TOTALDEFIRMAS']);
  const sinDato = v === null || v === undefined || v === '';
  const rec = sinDato ? 0 : (parseFloat(v) || 0);
  const grupo = sinDato || rec <= 0 ? 'gris' : rec >= 10 ? 'verde' : rec >= 5 ? 'amarillo' : 'rojo';
  return {
    feature: f, seccion: p.SECCION ?? 'N/A', distrito: String(p.DISTRITO_L ?? '').trim(),
    sinDato, rec, falta: sinDato ? META_POR_SECCION : Math.max(0, META_POR_SECCION - rec),
    grupo, estado: sinDato ? 'Sin dato' : TEXTO_ESTADO[grupo]
  };
}
function estadisticas(res) {
  const cuenta = { verde: 0, amarillo: 0, rojo: 0, gris: 0 };
  res.forEach(r => cuenta[r.grupo]++);
  const meta = res.length * META_POR_SECCION;
  const rec = res.reduce((s, r) => s + (r.sinDato ? 0 : r.rec), 0);
  return {
    cuenta, secciones: res.length, meta, rec,
    falta: res.reduce((s, r) => s + r.falta, 0),
    avance: meta ? Math.min(100, Math.round((rec / meta) * 100)) : 0
  };
}
const htmlResumen = r => `<div class="text-xs"><b>Sección ${esc(r.seccion)}</b><br>
  Distrito: ${esc(r.distrito)}<br>
  Firmas: ${r.sinDato ? 'N/A' : r.rec} · Faltan: ${r.sinDato ? 'N/A' : r.falta}<br>
  <b style="color:${TITULO_GRUPO[r.grupo]}">${r.estado}</b></div>`;

// ---- Modos de filtro y búsqueda ----
function setModo(m) {
  modoFiltro = m;
  document.querySelectorAll('.btn-modo').forEach(b => b.classList.toggle('activo', b.dataset.modo === m));
  ['distrito', 'seccion', 'ubicacion'].forEach(k => document.getElementById('panel-' + k).classList.toggle('oculto', k !== m));
}

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

// ---- Hojas del reporte ----
const crearHoja = (clase, html) => {
  const el = document.createElement('section');
  el.className = 'hoja ' + clase;
  el.innerHTML = html;
  return el;
};
const cabecera = (titulo, sub) => `<header class="cab-hoja"><div><h2>${esc(titulo)}</h2><p>${sub}</p></div>
  <div class="marca">Meta: ${META_POR_SECCION} firmas por sección</div></header>`;

// Etiquetas de sección: mismo algoritmo que el mapa interactivo (tamaño común, sin encimarse)
function obstaculosHoja(m) {
  const hoja = m.getContainer().closest('.hoja');
  const leyenda = hoja && hoja.querySelector('.leyenda-hoja');
  if (!leyenda) return [];
  const base = m.getContainer().getBoundingClientRect();
  const r = leyenda.getBoundingClientRect();
  const z = m.getZoom();
  const a = m.project(m.containerPointToLatLng(L.point(r.left - base.left, r.top - base.top)), z);
  const b = m.project(m.containerPointToLatLng(L.point(r.right - base.left, r.bottom - base.top)), z);
  return [{ x1: Math.min(a.x, b.x) - 4, y1: Math.min(a.y, b.y) - 4, x2: Math.max(a.x, b.x) + 4, y2: Math.max(a.y, b.y) + 4 }];
}

function etiquetarPoligonos(m, res) {
  const registros = [];
  res.forEach(r => {
    const anillo = anilloPrincipal(r.feature.geometry);
    if (!anillo.length) return;
    const p0 = anillo.map(([lng, lat]) => { const p = m.project([lat, lng], 0); return [p.x, p.y]; });
    const pole0 = poloDeInaccesibilidad(p0);
    const texto = String(r.seccion);
    const est = ESTILO_ETIQUETA[CLASE_GRUPO[r.grupo]];
    const marker = L.marker(m.unproject(L.point(pole0[0], pole0[1]), 0), {
      interactive: false, keyboard: false,
      icon: L.divIcon({
        className: 'etiqueta-wrap', iconSize: [0, 0],
        html: `<span class="etiqueta-seccion" style="background:${est.fondo};color:${est.texto};border-color:${est.borde}">${texto}</span>`
      })
    }).addTo(m);
    registros.push({ marker, pole0, ringRel0: p0.map(([x, y]) => [x - pole0[0], y - pole0[1]]), anchoPorPx: anchoPorPixel(texto) });
  });
  ajustarEtiquetasEn(m, registros, obstaculosHoja(m), ETIQUETA.max);
}

function hojaMapa(titulo, res, contornos, fecha) {
  const e = estadisticas(res);
  const leyenda = ['verde', 'amarillo', 'rojo', 'gris'].map(g =>
    `<span class="ley"><i style="background:${FILL_GRUPO[g]}"></i>${NOMBRE_GRUPO[g]} <b>${e.cuenta[g]}</b></span>`).join('');
  const el = crearHoja('mapa', cabecera(titulo, `${res.length} secciones · Generado ${fecha}`)
    + `<div class="cuerpo-mapa"><div class="hoja-mapa"></div><div class="leyenda-hoja">${leyenda}</div></div>`);
  const grupoPor = new Map(res.map(r => [r.feature, r.grupo]));
  return {
    el,
    dibujar(m) {
      const capa = L.geoJSON({ type: 'FeatureCollection', features: res.map(r => r.feature) }, {
        style: f => ({ color: '#0f172a', weight: 1.5, fillColor: FILL_GRUPO[grupoPor.get(f)], fillOpacity: 0.6 })
      }).addTo(m);
      contornos.forEach(g => L.geoJSON(g, { interactive: false, style: { color: '#7f1d1d', weight: 3, fillOpacity: 0, dashArray: '8,6' } }).addTo(m));
      return capa.getBounds();
    },
    etiquetar(m) { etiquetarPoligonos(m, res); }
  };
}

function hojaResumen(distritos, fecha) {
  const filas = distritos.map(d => ({ nombre: `Distrito Local ${d.id}`, ...estadisticas(d.res) }));
  if (distritos.length > 1) filas.push({ nombre: 'Total', total: true, ...estadisticas(distritos.flatMap(d => d.res)) });
  const cuerpo = filas.map(f => `<tr class="${f.total ? 'total' : ''}"><td>${f.nombre}</td>
      <td class="num">${f.secciones}</td><td class="num">${f.meta}</td><td class="num">${f.rec}</td><td class="num">${f.falta}</td>
      <td class="num">${f.avance}%</td><td class="num">${f.cuenta.verde}</td><td class="num">${f.cuenta.amarillo}</td>
      <td class="num">${f.cuenta.rojo}</td><td class="num">${f.cuenta.gris}</td></tr>`).join('');
  return { el: crearHoja('tabla', `${cabecera('Resumen general por distrito', 'Generado ' + fecha)}
    <div class="tabla-cuerpo"><table class="tabla-resumen"><thead><tr><th>Distrito</th><th class="num">Secciones</th><th class="num">Meta</th>
    <th class="num">Recabadas</th><th class="num">Faltantes</th><th class="num">Avance</th><th class="num">Completadas</th>
    <th class="num">En proceso</th><th class="num">Críticas</th><th class="num">Sin firmas</th></tr></thead><tbody>${cuerpo}</tbody></table>
    <p class="nota">Completadas: 10 o más firmas · En proceso: 5 a 9 · Críticas: 1 a 4 · Sin firmas: 0 o sin dato. La meta cuenta todas las secciones.</p></div>`) };
}

function hojaTablas(titulo, res, fecha) {
  const TITULO_BLOQUE = {
    rojo: '🔴 Críticas (1 a 4 firmas)',
    gris: '⚪ Sin firmas (0) / sin dato',
    verde: '🟢 Completadas (10 o más firmas)',
    amarillo: '🟡 En proceso (5 a 9 firmas)'
  };
  const e = estadisticas(res);
  const bloque = g => {
    const del = res.filter(r => r.grupo === g).sort(porSeccion);
    const filas = del.map(r => `<tr><td class="sec">${esc(r.seccion)}</td><td class="num">${META_POR_SECCION}</td>
      <td class="num">${r.sinDato ? 'Sin dato' : r.rec}</td><td class="num">${r.sinDato ? '—' : r.falta}</td></tr>`).join('');
    return `<div class="bloque"><div class="titulo-bloque" style="background:${TITULO_GRUPO[g]}"><span>${TITULO_BLOQUE[g]}</span><span>Total: ${del.length} secciones</span></div>
      <table><thead><tr><th>Sección</th><th class="num">Meta</th><th class="num">Recabadas</th><th class="num">Faltantes</th></tr></thead>
      <tbody>${filas || '<tr><td colspan="4" class="vacio">Sin secciones en este grupo</td></tr>'}</tbody></table></div>`;
  };
  const tarjetas = [['Secciones', e.secciones], ['Meta total', e.meta], ['Recabadas', e.rec], ['Faltantes', e.falta], ['Avance', e.avance + '%']]
    .map(([k, v]) => `<div class="tarjeta"><span>${k}</span><b>${v}</b></div>`).join('');
  return { el: crearHoja('tabla', `${cabecera(titulo, 'Detalle por sección · Generado ' + fecha)}
    <div class="tabla-cuerpo"><div class="tarjetas">${tarjetas}</div><div class="grid-grupos">${ORDEN_TABLAS.map(bloque).join('')}</div></div>`) };
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
  hojas.forEach(h => cuerpo.appendChild(h.el));
  document.getElementById('hojas').classList.add('abierto');
  const estado = document.getElementById('hojas-estado');
  estado.textContent = '(preparando mapas…)';
  const cargas = hojas.filter(h => h.dibujar).map(h => {
    const m = L.map(h.el.querySelector('.hoja-mapa'), { zoomControl: false, zoomSnap: 0.1, zoomAnimation: false, fadeAnimation: false });
    mapasReporte.push(m);
    const b = h.dibujar(m);
    if (b.isValid()) m.fitBounds(b, { padding: [30, 30], animate: false });
    else m.setView(CENTRO_CDMX, 11, { animate: false });
    h.etiquetar(m);
    return registrarCargaTeselas(L.tileLayer(URL_TELAS, { attribution: ATRIBUCION, maxZoom: 19 }).addTo(m));
  });
  await Promise.all(cargas);
  estado.textContent = `(${hojas.length} hojas listas)`;
}

async function generarReporte() {
  if (!datosSeccionesGeoJSON) { alert('Todavía no se cargan las secciones.'); return; }
  const fecha = new Date().toLocaleString('es-MX', { dateStyle: 'long', timeStyle: 'short' });
  const sel = document.getElementById('select-distrito').value;
  const todas = listaFeatures(datosSeccionesGeoJSON);
  const distritos = [{ id: '11', geo: datosDistrito11GeoJSON }, { id: '15', geo: datosDistrito15GeoJSON }]
    .filter(d => sel === 'TODOS' || sel === d.id)
    .map(d => ({ ...d, res: todas.filter(f => String(f.properties.DISTRITO_L || '').trim() === d.id).map(resumenSeccion).sort(porSeccion) }));
  const hojas = [];
  if (distritos.length > 1) {
    hojas.push(hojaMapa('Vista general · Distritos Locales 11 y 15', distritos.flatMap(d => d.res), distritos.map(d => d.geo).filter(Boolean), fecha));
  }
  distritos.forEach(d => hojas.push(hojaMapa(`Distrito Local ${d.id}`, d.res, [d.geo].filter(Boolean), fecha)));
  hojas.push(hojaResumen(distritos, fecha));
  distritos.forEach(d => hojas.push(hojaTablas(`Distrito Local ${d.id}`, d.res, fecha)));
  await abrirVistaPrevia(hojas);
}

// ---- Arranque ----
window.addEventListener('load', () => {
  ['input-seccion', 'input-calle', 'input-numero', 'input-colonia'].forEach(id =>
    document.getElementById(id).addEventListener('keydown', e => {
      if (e.key !== 'Enter') return;
      if (id === 'input-seccion') buscarSeccion(); else buscarDireccion();
    }));
});
