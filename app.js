/* ============================================================================
 *  CifraControl · Lógica del panel (JavaScript puro, sin frameworks)
 * ============================================================================
 *  ARQUITECTURA DE LA CAPA DE PRESENTACIÓN
 *
 *    config ──► api() ──► Modulos.cargar()  ──► renderizadores
 *                  │            │
 *                  │            └── cada módulo es AISLADO: su propio
 *                  │                esqueleto de carga y su propio
 *                  │                error con botón "Reintentar conexión".
 *                  └── un fallo de red NO detiene el resto de la pantalla.
 *
 *  Conceptos clave:
 *    · Router por hash (#/inventario) → navegación sin recarga de página.
 *    · "Módulo" = bloque HTML con data-modulo, data-skel, data-fallo.
 *    · Badge   = contador numérico en el sidebar y en los iconos.
 *    · Aviso   = notificación flotante (toast).
 *    · Componentes en /componentes: cada uno es dueño de su vista y recibe
 *      de este archivo sólo las utilidades que usa (p. ej. ingesta.js).
 * ========================================================================== */

'use strict';

/* ==========================================================================
 *  1. CONFIGURACIÓN Y ESTADO GLOBAL
 * ========================================================================== */

const API = '/api';

const config = {
  /** Retardo simulado que se pide al servidor (lo controla Ajustes). */
  retardo: 900,
  /** Interruptor de pruebas: fuerza errores para ver los reintentos. */
  forzarFallo: false,
  /** Sidebar plegado en escritorio. */
  sidebarPlegado: false,
};

const estado = {
  vista: 'resumen',
  /** Datos ya descargados por módulo: no se vuelven a pedir al navegar. */
  cache: {},
  /** Peticiones en curso, para no duplicar la misma llamada simultánea. */
  vuelo: {},
  /** Datos de los sparklines de los KPI (se redibujan al cambiar de tema). */
  sparks: [],
  notificaciones: [],
};

/** Rango de días activo en el gráfico de barras. */
let rangoDias = 30;

/** Pide los indicadores. Los tres módulos del resumen comparten esta función. */
const pedirMetricas = () => api('/dashboard/metrics', { days: rangoDias, seed: rangoDias * 17 });

/**
 * Definición de cada módulo.
 *   cargar → función que devuelve una promesa con los datos de la API
 *   pintar → renderizador del HTML del módulo
 *   clave  → modules que comparten la misma respuesta (los 3 de métricas)
 */
const MODULOS = {
  kpis:        { clave: 'metricas', cargar: pedirMetricas, pintar: pintarKpis },
  serie:       { clave: 'metricas', cargar: pedirMetricas, pintar: pintarSerie },
  algoritmos:  { clave: 'metricas', cargar: pedirMetricas, pintar: pintarAlgoritmos },
  inventario:  { cargar: () => api('/dashboard/inventario', filtros.inventario), pintar: pintarInventario },
  tecnologias: { cargar: () => api('/dashboard/tecnologias'), pintar: pintarTecnologias },
  monitoreo:   { cargar: () => api('/dashboard/monitoreo'), pintar: pintarMonitoreo },
  excepciones: { cargar: () => api('/dashboard/excepciones', filtros.excepciones), pintar: pintarExcepciones },
  carga:       { cargar: () => api('/health'), pintar: () => {} },   // sólo comprueba que la ingesta responde
  cola:        { cargar: () => Ingesta.cargarCola(), pintar: (d) => Ingesta.pintarCola(d) },   // componentes/ingesta.js
};

/** Filtros vivos de cada módulo (se envían como query). */
const filtros = {
  inventario: { search: '', estado: '', tipo: '', sort: 'ultimoAnalisis', dir: 'desc', page: 1, pageSize: 8 },
  excepciones: { severidad: '' },
};

/* ==========================================================================
 *  2. UTILIDADES
 * ========================================================================== */

/** Crea un elemento. Atajo para no ensuciar el DOM con innerHTML. */
const crear = (etiqueta, clase, texto) => {
  const el = document.createElement(etiqueta);
  if (clase) el.className = clase;
  if (texto != null) el.textContent = texto;
  return el;
};

/** Escapa texto antes de inyectarlo en una plantilla HTML. */
const esc = (v) => String(v == null ? '' : v)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Formatea números en español. */
const nf = new Intl.NumberFormat('es-ES');
const num = (n) => nf.format(n);

/** Formatea un valor según el formato del KPI (gb, percent, num). */
function formatearKPI(valor, formato) {
  if (formato === 'percent') return `${String(valor).replace('.', ',')} %`;
  if (formato === 'gb') return `${num(valor)} GB`;
  return num(valor);
}

/** Fecha corta: 2026-10-03 → 03 oct */
function fechaCorta(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short' }).replace('.', '');
}

/** Fecha y hora legible. */
function fechaHora(iso) {
  return new Date(iso).toLocaleString('es-ES', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
  });
}

/** Espera 'ms' milisegundos. */
const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retrasa la ejecución hasta que el usuario deja de escribir. */
function rebocar(fn, ms) {
  let id;
  return (...args) => { clearTimeout(id); id = setTimeout(() => fn(...args), ms); };
}

/** Choque simple de peticiones: la última gana. */
function crearSenal() {
  let n = 0;
  return () => ++n;
}

/** Pide un icono del sprite por su id. */
const icono = (id, clase = 'ico') => `<svg class="${clase}"><use href="#i-${id}"></use></svg>`;

/** Pone un contador en cualquier badge. 0 lo oculta. */
function setBadge(nombre, valor) {
  document.querySelectorAll(`[data-badge="${nombre}"]`).forEach((el) => {
    const n = Number(valor) || 0;
    el.textContent = n > 99 ? '99+' : n;
    el.hidden = n === 0;
  });
}

/* --------------------------------------------------------------------------
 *  Avisos flotantes
 * ------------------------------------------------------------------------ */
function avisar(titulo, texto, tipo = 'info', ms = 4600) {
  const caja = document.getElementById('avisos');
  const el = crear('div', `aviso aviso--${tipo}`);

  const ico = crear('span');
  ico.innerHTML = icono({ exito: 'check', error: 'alerta', alerta: 'alerta', info: 'campana' }[tipo]);

  const cuerpo = crear('div', 'aviso__t');
  cuerpo.append(crear('strong', null, titulo));
  if (texto) cuerpo.append(crear('p', null, texto));

  const cerrar = crear('button', 'aviso__cerrar');
  cerrar.setAttribute('aria-label', 'Cerrar aviso');
  cerrar.innerHTML = icono('cerrar');
  cerrar.onclick = () => el.remove();

  el.append(ico, cuerpo, cerrar);
  caja.append(el);

  // Accesibilidad: sólo se anuncian los avisos relevantes.
  if (tipo === 'error') el.setAttribute('role', 'alert');
  setTimeout(() => el.remove(), ms);
}

/* ==========================================================================
 *  3. CLIENTE HTTP
 * ========================================================================== */

/**
 * Realiza una petición a la API.
 * - Propaga el retardo simulado para que los skeletons sean visibles.
 * - Lanza errores con el mensaje del servidor cuando la API responde 4xx/5xx.
 * - Si el interruptor "Simular fallo" está activo, falla sin tocar la red.
 */
async function api(ruta, params = {}) {
  if (config.forzarFallo) {
    await esperar(650);                                  // simula la latencia
    throw new Error('Conexión perdida con el servidor de métricas (fallo simulado).');
  }

  const qs = new URLSearchParams({ delay: config.retardo, ...params }).toString();
  const url = `${API}${ruta}?${qs}`;

  let res;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch {
    throw new Error('No hay conexión con el servidor local.');
  }

  if (!res.ok) {
    let mensaje = `El servidor respondió ${res.status}.`;
    try { mensaje = (await res.json()).message || mensaje; } catch { /* cuerpo no JSON */ }
    throw new Error(mensaje);
  }
  return res.json();
}

/* ==========================================================================
 *  4. MARCO DE MÓDULOS AISLADOS
 *  Cada módulo tiene tres zonas: esqueleto → datos → error.
 * ========================================================================== */

/** Elemento raíz de un módulo (el que lleva data-modulo="nombre"). */
const raizDe = (nombre) => document.querySelector(`[data-modulo="${nombre}"]`);

/** Muestra el esqueleto y oculta datos y error. */
function modoCarga(nombre) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = false;
  raiz.querySelector('[data-fallo]').hidden = true;
  // Los datos viejos se ocultan: nunca se ve contenido a medio actualizar.
  const datos = raiz.querySelector('[data-datos]');
  if (datos) datos.hidden = true;
}

/** Pasa a estado "con datos". */
function modoListo(nombre) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = true;
  raiz.querySelector('[data-fallo]').hidden = true;
  const datos = raiz.querySelector('[data-datos]');
  if (datos) datos.hidden = false;
}

/** Muestra el error del módulo con su botón de reintento. */
function modoFallo(nombre, error) {
  const raiz = raizDe(nombre);
  if (!raiz) return;
  raiz.querySelector('[data-skel]').hidden = true;
  const caja = raiz.querySelector('[data-fallo]');
  caja.hidden = false;
  const msg = caja.querySelector('[data-fallo-msg]');
  if (msg) msg.textContent = `${error.message} Revisa la conexión y vuelve a intentarlo.`;

  const boton = caja.querySelector('[data-reintentar]');
  if (boton) {
    boton.onclick = () => {
      avisar('Reintentando', 'Volvemos a pedir los datos del módulo.', 'info', 2600);
      cargarModulo(nombre, { forzar: true });
    };
  }
  avisar(`Módulo «${nombre}» no disponible`, error.message, 'error');
}

/**
 * Carga un módulo de forma independiente.
 * Un fallo aquí NO afecta a los demás módulos ya pintados en pantalla.
 */
async function cargarModulo(nombre, opciones = {}) {
  const cfg = MODULOS[nombre];
  if (!cfg) return;

  // Los 3 módulos de métricas comparten clave: una sola llamada al backend.
  const clave = cfg.clave || nombre;

  if (!opciones.forzar && estado.cache[clave]) {
    modoListo(nombre);
    return;
  }

  modoCarga(nombre);
  try {
    const datos = await obtener(clave, cfg, opciones.forzar);
    cfg.pintar(datos, nombre);
    modoListo(nombre);
    // Los badges del sidebar se actualizan aunque su vista no esté abierta.
    if (clave === 'metricas') actualizarBadgesDesdeMetricas(datos);
  } catch (error) {
    modoFallo(nombre, error);
  }
}

/**
 * Resuelve los datos de un módulo respetando dos cachés:
 *  · cache → datos ya descargados (no se repite la petición al navegar)
 *  · vuelo → petición EN CURSO (tres módulos pidiendo lo mismo a la vez
 *    generan una sola llamada, no tres)
 */
function obtener(clave, cfg, forzar) {
  if (!forzar && estado.cache[clave]) return Promise.resolve(estado.cache[clave]);
  if (!forzar && estado.vuelo[clave]) return estado.vuelo[clave];

  estado.vuelo[clave] = cfg.cargar()
    .then((datos) => { estado.cache[clave] = datos; delete estado.vuelo[clave]; return datos; })
    .catch((err) => { delete estado.vuelo[clave]; throw err; });

  return estado.vuelo[clave];
}

/**
 * Los contadores del sidebar se derivan de los datos ya descargados.
 * Cada badge muestra lo que exige una acción, no un total decorativo:
 *   · excepciones → incidencias críticas abiertas
 *   · inventario  → activos con cifrado parcial o inexistente
 */
function actualizarBadgesDesdeMetricas(d) {
  setBadge('excepciones', d.kpis.find((k) => k.id === 'criticas')?.value || 0);
  setBadge('inventario', d.inventario?.pendientes || 0);
}

/* ==========================================================================
 *  5. ENRUTADOR POR HASH (navegación sin recarga de página)
 * ========================================================================== */

const VISTAS = {
  resumen:     { titulo: 'Resumen de cifrado',    sub: 'Estado global del cifrado del parque' },
  inventario:  { titulo: 'Inventario',            sub: 'Activos, ubicación y estado de cifrado' },
  tecnologias: { titulo: 'Tecnologías',           sub: 'Stack detectado, versiones y riesgo' },
  monitoreo:  { titulo: 'Monitoreo',             sub: 'Disponibilidad de los servicios internos' },
  excepciones:{ titulo: 'Excepciones',           sub: 'Incidencias de cifrado por severidad' },
  carga:       { titulo: 'Cargar Excel',          sub: 'Ingesta diferida hacia el almacén de recepción' },
  ajustes:     { titulo: 'Ajustes',               sub: 'Preferencias locales y estado del servicio' },
};

/** Módulos que se piden al entrar en cada vista. */
const MODULOS_POR_VISTA = {
  resumen: ['kpis', 'serie', 'algoritmos'],
  inventario: ['inventario'],
  tecnologias: ['tecnologias'],
  monitoreo: ['monitoreo'],
  excepciones: ['excepciones'],
  carga: ['carga', 'cola'],
  ajustes: [],
};

function irA(vista, { empujar = true } = {}) {
  if (!VISTAS[vista]) vista = 'resumen';

  estado.vista = vista;
  const meta = VISTAS[vista];
  document.getElementById('tituloVista').textContent = meta.titulo;
  document.getElementById('subtituloVista').textContent = meta.sub;
  document.title = `${meta.titulo} · CifraControl`;

  // Sólo una vista visible: la navegación no recarga la página.
  document.querySelectorAll('.vista').forEach((v) => {
    const activa = v.dataset.vista === vista;
    v.hidden = !activa;
    v.classList.toggle('is-activa', activa);
  });

  // Resalta el enlace del sidebar.
  document.querySelectorAll('.nav__link').forEach((a) => {
    a.classList.toggle('is-activo', a.dataset.ir === vista);
  });

  if (empujar && location.hash !== `#/${vista}`) {
    history.pushState({ vista }, '', `#/${vista}`);
  }

  // En móvil, cerrar el cajón tras navegar.
  cerrarMenuMovil();

  // Carga perezosa: sólo se piden los módulos de la vista visitada.
  (MODULOS_POR_VISTA[vista] || []).forEach((m) => cargarModulo(m));
}

/* ==========================================================================
 *  6. INTERFAZ GENERAL: menú, tema, salud y notificaciones
 * ========================================================================== */

const app = document.querySelector('.app');

function abrirMenuMovil() {
  app.classList.add('is-abierto');
  document.getElementById('capa').hidden = false;
  document.getElementById('btnMenu').setAttribute('aria-expanded', 'true');
}
function cerrarMenuMovil() {
  app.classList.remove('is-abierto');
  document.getElementById('capa').hidden = true;
  document.getElementById('btnMenu').setAttribute('aria-expanded', 'false');
}

/** El botón hamburguesa pliega en escritorio y abre el cajón en móvil. */
function alternarMenu() {
  if (window.matchMedia('(max-width: 860px)').matches) {
    app.classList.contains('is-abierto') ? cerrarMenuMovil() : abrirMenuMovil();
  } else {
    config.sidebarPlegado = !app.classList.contains('is-plegado');
    aplicarSidebar();
  }
}

function aplicarSidebar() {
  app.classList.toggle('is-plegado', config.sidebarPlegado);
  const cb = document.getElementById('setSidebar');
  if (cb) cb.checked = config.sidebarPlegado;
  try { localStorage.setItem('cc:sidebar', config.sidebarPlegado ? '1' : '0'); } catch { /* modo privado */ }
}

/* ------------------------------ Tema ------------------------------------ */
function aplicarTema(oscuro) {
  document.documentElement.dataset.tema = oscuro ? 'oscuro' : 'claro';
  const cb = document.getElementById('setTema');
  if (cb) cb.checked = oscuro;
  try { localStorage.setItem('cc:tema', oscuro ? 'oscuro' : 'claro'); } catch { /* noop */ }
  // Los gráficos canvas hay que redibujarlos al cambiar los colores del tema.
  requestAnimationFrame(redibujarGraficos);
}

/* ------------------------- Salud de la API ------------------------------ */
async function comprobarSalud() {
  const cajas = [
    document.getElementById('saludSidebar'),
    document.getElementById('pastillaApi'),
  ];
  const textoSidebar = cajas[0]?.querySelector('.salud__txt');
  const textoPastilla = document.getElementById('pastillaApiTxt');
  const bloque = document.getElementById('saludJson');

  cajas.forEach((c) => c && (c.dataset.estado = 'comprobando'));
  if (textoSidebar) textoSidebar.textContent = 'Comprobando API…';
  if (textoPastilla) textoPastilla.textContent = 'Comprobando…';

  try {
    const d = await api('/health');
    cajas.forEach((c) => c && (c.dataset.estado = 'ok'));
    if (textoSidebar) textoSidebar.textContent = 'API conectada';
    if (textoPastilla) textoPastilla.textContent = 'API en línea';
    if (bloque) bloque.textContent = JSON.stringify(d, null, 2);
    return true;
  } catch (error) {
    cajas.forEach((c) => c && (c.dataset.estado = 'error'));
    if (textoSidebar) textoSidebar.textContent = 'API sin respuesta';
    if (textoPastilla) textoPastilla.textContent = 'API caída';
    if (bloque) bloque.textContent = `Sin conexión con el servidor.\n\n${error.message}`;
    return false;
  }
}

/* --------------------------- Notificaciones ----------------------------- */
function anadirNotificacion(tipo, titulo, texto) {
  estado.notificaciones.unshift({ tipo, titulo, texto, hora: new Date() });
  estado.notificaciones = estado.notificaciones.slice(0, 12);
  pintarNotificaciones();
  const cuenta = estado.notificaciones.length;
  setBadge('notificaciones', cuenta);
}

function pintarNotificaciones() {
  const lista = document.getElementById('listaNotificaciones');
  if (!estado.notificaciones.length) {
    lista.innerHTML = '<p class="popover__vacio">Sin novedades.</p>';
    return;
  }
  lista.innerHTML = estado.notificaciones.map((n) => `
    <article class="notif">
      <span class="notif__pt notif__pt--${n.tipo}"></span>
      <div>
        <strong>${esc(n.titulo)}</strong>
        <p>${esc(n.texto)}</p>
        <time>${esc(n.hora.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }))}</time>
      </div>
    </article>`).join('');
}

/* ==========================================================================
 *  7. RENDERIZADORES DE CADA MÓDULO
 * ========================================================================== */

/* ------------------------------ KPIs ------------------------------------ */
function pintarKpis(d) {
  // Los sparklines se guardan aparte para poder redibujarlos sin re-renderizar.
  estado.sparks = d.kpis.map((k) => ({ valores: k.spark, color: k.color }));

  document.querySelector('[data-datos="kpis"]').innerHTML = d.kpis.map((k, indice) => {
    const sube = k.delta >= 0;
    // El KPI de excepciones invierte la lógica: menos es mejor.
    const malo = k.id === 'criticas';
    const clase = (sube !== malo) ? 'delta--sube' : 'delta--baja';
    return `
      <article class="kpi" style="--kpi-color:${esc(k.color)}">
        <div class="kpi__cab">
          <span class="kpi__label">${esc(k.label)}</span>
          <span class="kpi__icono">${icono(k.icono)}</span>
        </div>
        <p class="kpi__valor">${esc(formatearKPI(k.value, k.format))}</p>
        <div class="kpi__pie">
          <span class="delta ${clase}">
            ${icono(sube ? 'flecha-arriba' : 'flecha-abajo')}${Math.abs(k.delta).toString().replace('.', ',')} %
          </span>
          <span>${esc(k.sufijo)}</span>
        </div>
        <canvas class="kpi__spark" data-spark="${indice}" aria-hidden="true"></canvas>
      </article>`;
  }).join('');

  // Los sparklines se dibujan cuando la vista ya es visible.
  requestAnimationFrame(dibujarSparks);
}

/* ------------------------- Gráfico de líneas --------------------------- */
const graficos = [];   // { canvas, fn } para redibujar al cambiar de tamaño

function pintarSerie(d) {
  document.querySelector('[data-datos="serie"]').innerHTML = `
    <canvas class="grafico" id="graficoSerie" role="img"
      aria-label="Volumen cifrado por día durante ${d.rango.dias} días"></canvas>
    <div class="leyenda">
      <span class="leyenda__it"><i class="leyenda__pt leyenda__pt--linea" style="background:#7C3AED"></i>GB cifrados</span>
      <span class="leyenda__it"><i class="leyenda__pt leyenda__pt--linea" style="background:#94A3B8"></i>Objetivo</span>
      <span class="leyenda__it"><i class="leyenda__pt" style="background:#F97316"></i>Eventos de clave</span>
    </div>`;

  const canvas = document.getElementById('graficoSerie');
  const fn = () => dibujarLinea(canvas, d.graficos.serie, d.graficos.maximo);
  registrarGrafico(canvas, fn);
  requestAnimationFrame(fn);
  observarResize(canvas, fn);
}

/** Registra un canvas para redibujarlo al cambiar de tema o de tamaño.
 *  Si el canvas ya estaba registrado, se sustituye (nada de duplicados). */
function registrarGrafico(canvas, fn) {
  const i = graficos.findIndex((g) => g.canvas.id === canvas.id);
  if (i >= 0) graficos[i] = { canvas, fn };
  else graficos.push({ canvas, fn });
}

function pintarAlgoritmos(d) {
  const total = d.graficos.algoritmos.reduce((a, b) => a + b.value, 0);
  document.querySelector('[data-datos="algoritmos"]').innerHTML = `
    <div class="donut-zona">
      <canvas class="donut" id="graficoDonut" role="img" aria-label="Reparto por algoritmo de cifrado"></canvas>
      <ul class="donut-lista">
        ${d.graficos.algoritmos.map((a) => `
          <li>
            <i class="leyenda__pt" style="background:${esc(a.color)}"></i>
            <span>${esc(a.label)}</span>
            <b>${a.value} %</b>
          </li>`).join('')}
      </ul>
    </div>
    <div class="totales" style="margin-top:20px;margin-bottom:0">
      <div class="total"><b>${num(total)}</b><span>algoritmos</span></div>
      <div class="total total--exito"><b>${num(d.kpis.find((k) => k.id === 'cobertura').value)} %</b><span>cobertura</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.totalEventos)}</b><span>eventos</span></div>
    </div>`;

  const canvas = document.getElementById('graficoDonut');
  const fn = () => dibujarDonut(canvas, d.graficos.algoritmos);
  registrarGrafico(canvas, fn);
  requestAnimationFrame(fn);
  observarResize(canvas, fn);
}

/* ---------------------------- Inventario -------------------------------- */
async function pedirInventario() {
  await cargarModulo('inventario', { forzar: true });
}

function pintarInventario(d) {
  const cont = document.querySelector('[data-datos="inventario"]');

  if (!d.filas.length) {
    cont.innerHTML = `<div class="vacio"><strong>Ningún activo coincide</strong>
      Prueba a cambiar la búsqueda o los filtros.</div>`;
    return;
  }

  const p = d.paginacion;
  const etiquetasEstado = {
    protegido: ['et--exito', 'Cifrado'],
    parcial: ['et--alerta', 'Parcial'],
    sin_cifrar: ['et--peligro', 'Sin cifrar'],
  };

  const columnas = [
    { k: 'id', t: 'ID', ordenable: true },
    { k: 'nombre', t: 'Activo', ordenable: true },
    { k: 'cifrado', t: 'Algoritmo', ordenable: true },
    { k: 'estado', t: 'Estado', ordenable: true },
    { k: 'bytesCifrados', t: 'Volumen', num: true, ordenable: true },
    { k: 'ubicacion', t: 'Ubicación', ordenable: true },
    { k: 'responsable', t: 'Responsable', ordenable: false },
    { k: 'ultimoAnalisis', t: 'Último análisis', ordenable: true },
  ];

  cont.innerHTML = `
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          ${columnas.map((c) => `<th class="${c.num ? 'num' : ''}">${
            c.ordenable
              ? `<button type="button" data-orden="${esc(c.k)}">${esc(c.t)}${flechaOrden(c.k)}</button>`
              : esc(c.t)
          }</th>`).join('')}
        </tr></thead>
        <tbody>
          ${d.filas.map((f) => {
            const [clase, texto] = etiquetasEstado[f.estado] || ['et--neutro', f.estado];
            return `<tr>
              <td class="tenue">${esc(f.id)}</td>
              <td>
                <div class="celda-activo">
                  <span class="avatar-mini">${esc(f.iniciales)}</span>
                  <span><strong>${esc(f.nombre)}</strong><small>${esc(f.tipo)}</small></span>
                </div>
              </td>
              <td>${esc(f.cifrado)}</td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td class="num">${num(Math.round(f.bytesCifrados / 1e6))} MB</td>
              <td class="tenue">${esc(f.ubicacion)}</td>
              <td>${esc(f.responsable)}</td>
              <td class="tenue">${esc(fechaCorta(f.ultimoAnalisis))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="paginacion">
      <span class="paginacion__info">Mostrando ${p.desde}–${p.hasta} de ${num(p.total)} activos</span>
      <div class="paginacion__botones">
        <button class="pag-btn" data-pag="prev" ${p.pagina <= 1 ? 'disabled' : ''} aria-label="Página anterior">${icono('flecha-izq')}</button>
        ${botonesPagina(p.pagina, p.totalPaginas)}
        <button class="pag-btn" data-pag="next" ${p.pagina >= p.totalPaginas ? 'disabled' : ''} aria-label="Página siguiente">${icono('flecha-der')}</button>
      </div>
    </div>`;

  // Llena el selector de tipos con lo que devuelve la API.
  const sel = document.getElementById('fTipo');
  if (sel && sel.options.length <= 1 && d.tiposDisponibles) {
    d.tiposDisponibles.forEach((t) => sel.add(new Option(t, t)));
    sel.value = filtros.inventario.tipo;
  }

  // Enlaces de ordenación
  cont.querySelectorAll('[data-orden]').forEach((btn) => {
    btn.onclick = () => {
      const col = btn.dataset.orden;
      const f = filtros.inventario;
      f.dir = f.sort === col && f.dir === 'desc' ? 'asc' : 'desc';
      f.sort = col;
      pedirInventario();
    };
  });
  // Paginación
  cont.querySelectorAll('[data-pag]').forEach((btn) => {
    btn.onclick = () => {
      filtros.inventario.page += btn.dataset.pag === 'next' ? 1 : -1;
      pedirInventario();
    };
  });
  cont.querySelectorAll('[data-ir-pag]').forEach((btn) => {
    btn.onclick = () => { filtros.inventario.page = Number(btn.dataset.irPag); pedirInventario(); };
  });

  setBadge('inventario', d.resumen?.pendientes ?? d.paginacion.total);
}

/** Indicador de columna ordenada. */
function flechaOrden(col) {
  const f = filtros.inventario;
  if (f.sort !== col) return '';
  return icono(f.dir === 'asc' ? 'flecha-arriba' : 'flecha-abajo');
}

/** Ventana de páginas alrededor de la actual. */
function botonesPagina(actual, total) {
  const salida = [];
  const desde = Math.max(1, actual - 1);
  const hasta = Math.min(total, actual + 1);
  if (desde > 1) salida.push(`<button class="pag-btn" data-ir-pag="1">1</button>`);
  if (desde > 2) salida.push('<span class="tenue">…</span>');
  for (let i = desde; i <= hasta; i++) {
    salida.push(`<button class="pag-btn ${i === actual ? 'is-activo' : ''}" data-ir-pag="${i}">${i}</button>`);
  }
  if (hasta < total - 1) salida.push('<span class="tenue">…</span>');
  if (hasta < total) salida.push(`<button class="pag-btn" data-ir-pag="${total}">${total}</button>`);
  return salida.join('');
}

/* --------------------------- Tecnologías -------------------------------- */
function pintarTecnologias(d) {
  const riesgos = {
    critico: ['et--peligro', 'Crítico'], alto: ['et--peligro', 'Alto'],
    medio: ['et--alerta', 'Medio'], bajo: ['et--exito', 'Bajo'],
  };

  document.querySelector('[data-datos="tecnologias"]').innerHTML = `
    <div class="totales">
      <div class="total"><b>${num(d.resumen.total)}</b><span>componentes</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.criticas)}</b><span>críticos</span></div>
      <div class="total total--alerta"><b>${num(d.resumen.alto)}</b><span>riesgo alto</span></div>
    </div>
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          <th>Componente</th><th>Categoría</th><th>Versión</th>
          <th class="num">CVSS</th><th>Riesgo</th><th>Uso</th><th class="num">Dependencias</th>
        </tr></thead>
        <tbody>
          ${d.filas.map((t) => {
            const [clase, texto] = riesgos[t.riesgo] || ['et--neutro', t.riesgo];
            const color = { critico: '#EF4444', alto: '#F97316', medio: '#F97316', bajo: '#10B981' }[t.riesgo];
            return `<tr>
              <td>
                <div class="celda-activo">
                  <span class="avatar-mini">${esc(t.nombre.slice(0, 2).toUpperCase())}</span>
                  <span><strong>${esc(t.nombre)}</strong>
                    <small>${t.desactualizada ? `La última es ${esc(t.ultimaVersion)}` : 'Al día'}</small></span>
                </div>
              </td>
              <td class="tenue">${esc(t.categoria)}</td>
              <td>${esc(t.version)}</td>
              <td class="num" style="color:${color};font-weight:700">${String(t.cvss).replace('.', ',')}</td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td>
                <div class="barra-dato">
                  <span class="barra-dato__riel"><span class="barra-dato__fill" style="width:${t.uso}%;background:${color}"></span></span>
                  <span class="barra-dato__val">${t.uso} %</span>
                </div>
              </td>
              <td class="num">${num(t.dependencias)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  setBadge('tecnologias', d.resumen.criticas + d.resumen.alto);
}

/* ---------------------------- Monitoreo --------------------------------- */
function pintarMonitoreo(d) {
  const etiquetas = { operativo: ['et--exito', 'Operativo'], degradado: ['et--alerta', 'Degradado'], caido: ['et--peligro', 'Caído'] };

  document.querySelector('[data-datos="monitoreo"]').innerHTML = `
    <div class="totales">
      <div class="total total--exito"><b>${num(d.resumen.operativos)}</b><span>operativos</span></div>
      <div class="total total--alerta"><b>${num(d.resumen.degradados)}</b><span>degradados</span></div>
      <div class="total total--peligro"><b>${num(d.resumen.caidos)}</b><span>caídos</span></div>
    </div>
    <div class="servicios">
      ${d.filas.map((s) => {
        const [clase, texto] = etiquetas[s.estado] || ['et--neutro', s.estado];
        return `<article class="servicio" data-estado="${esc(s.estado)}">
          <div class="servicio__n"><strong>${esc(s.servicio)}</strong>
            <span class="etiqueta ${clase}">${esc(texto)}</span></div>
          <div class="servicio__m">
            <div><span>Disponibilidad</span><b>${String(s.uptime).replace('.', ',')} %</b></div>
            <div><span>Latencia</span><b>${num(s.latencia)} ms</b></div>
            <div><span>Reintentos</span><b>${num(s.intentos)}</b></div>
          </div>
          <p class="servicio__host">${esc(s.hostname)}</p>
        </article>`;
      }).join('')}
    </div>`;

  setBadge('monitoreo', d.resumen.degradados + d.resumen.caidos);
  d.filas.filter((s) => s.estado !== 'operativo').forEach((s) => {
    anadirNotificacion(s.estado === 'caido' ? 'peligro' : 'alerta',
      `${s.servicio} · ${etiquetas[s.estado][1]}`,
      `Latencia de ${num(s.latencia)} ms y ${s.intentos} reintentos.`);
  });
}

/* ---------------------------- Excepciones ------------------------------- */
function pintarExcepciones(d) {
  const sev = {
    critica: ['et--peligro', 'Crítica'], alta: ['et--peligro', 'Alta'],
    media: ['et--alerta', 'Media'], baja: ['et--neutro', 'Baja'],
  };
  const triaje = { abierta: 'Abierta', en_revision: 'En revisión', resuelta: 'Resuelta' };

  document.querySelector('[data-datos="excepciones"]').innerHTML = `
    <div class="totales">
      <div class="total total--peligro"><b>${num(d.conteo.critica)}</b><span>críticas</span></div>
      <div class="total"><b>${num(d.conteo.alta)}</b><span>altas</span></div>
      <div class="total total--alerta"><b>${num(d.conteo.media + d.conteo.baja)}</b><span>resto</span></div>
    </div>
    <div class="tabla-marco">
      <table class="tabla">
        <thead><tr>
          <th>ID</th><th>Activo</th><th>Incidencia</th><th>Severidad</th><th>Estado</th><th>Responsable</th><th>Detectada</th>
        </tr></thead>
        <tbody>
          ${d.filas.map((f) => {
            const [clase, texto] = sev[f.severidad] || ['et--neutro', f.severidad];
            return `<tr>
              <td class="tenue">${esc(f.id)}</td>
              <td><strong>${esc(f.activo)}</strong></td>
              <td>${esc(f.tipo)}</td>
              <td><span class="etiqueta ${clase}">${esc(texto)}</span></td>
              <td class="tenue">${esc(triaje[f.estado] || f.estado)}</td>
              <td>${esc(f.responsable)}</td>
              <td class="tenue">${esc(fechaCorta(f.detectada))}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  setBadge('excepciones', d.conteo.critica);
}

/* ==========================================================================
 *  8. MOTORES DE GRÁFICO (CANVAS)
 * ========================================================================== */

/** Prepara el canvas al tamaño real en píxeles de dispositivo. */
function preparar(canvas, altoCSS) {
  const dpr = window.devicePixelRatio || 1;
  const ancho = canvas.clientWidth || canvas.parentElement.clientWidth || 600;
  const alto = altoCSS || canvas.clientHeight || 268;
  canvas.width = Math.round(ancho * dpr);
  canvas.height = Math.round(alto * dpr);
  canvas.style.height = `${alto}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, ancho, alto);
  return { ctx, ancho, alto };
}

/** Redibuja los sparklines de los KPI usando los datos guardados. */
function dibujarSparks() {
  document.querySelectorAll('.kpi__spark').forEach((c) => {
    const s = estado.sparks[Number(c.dataset.spark)];
    if (!s) return;
    const { ctx, ancho, alto } = preparar(c, 34);
    const serie = s.valores;
    const max = Math.max(...serie, 1);
    const min = Math.min(...serie, 0);
    const rango = max - min || 1;
    const px = (i) => (i / ((serie.length - 1) || 1)) * ancho;
    const py = (v) => alto - 3 - ((v - min) / rango) * (alto - 8);

    // Área degradada bajo la línea
    const degradado = ctx.createLinearGradient(0, 0, 0, alto);
    degradado.addColorStop(0, s.color + '44');
    degradado.addColorStop(1, s.color + '00');
    ctx.beginPath();
    ctx.moveTo(0, alto);
    serie.forEach((v, i) => ctx.lineTo(px(i), py(v)));
    ctx.lineTo(ancho, alto);
    ctx.closePath();
    ctx.fillStyle = degradado;
    ctx.fill();

    // Trazo
    ctx.beginPath();
    serie.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.stroke();
  });
}

/** Serie temporal: área + línea, objetivo punteado y eventos en barras. */
function dibujarLinea(canvas, serie, maximo) {
  if (!canvas) return;
  const { ctx, ancho, alto } = preparar(canvas, 268);
  const M = { arriba: 18, derecha: 14, abajo: 30, izquierda: 46 };
  const w = ancho - M.izquierda - M.derecha;
  const h = alto - M.arriba - M.abajo;
  const n = serie.labels.length;
  const maxEventos = Math.max(...serie.eventos, 1);

  // Retícula y eje Y
  const max = Math.ceil(maximo / 200) * 200;
  ctx.font = '11px system-ui, sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    const y = M.arriba + h - (v / max) * h;
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--borde').trim();
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(M.izquierda, y);
    ctx.lineTo(M.izquierda + w, y);
    ctx.stroke();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto-baj').trim();
    ctx.fillText(`${Math.round(v)}`, M.izquierda - 9, y);
  }

  // Barras de eventos de clave (eje secundario)
  const anchoBarra = Math.max(2, (w / n) * 0.42);
  serie.eventos.forEach((v, i) => {
    const x = M.izquierda + (i + 0.5) * (w / n);
    const bh = (v / maxEventos) * (h * 0.5);
    ctx.fillStyle = 'rgba(249,115,22,.22)';
    ctx.beginPath();
    ctx.roundRect(x - anchoBarra / 2, M.arriba + h - bh, anchoBarra, bh, 2);
    ctx.fill();
  });

  // Área + línea principal
  const px = (i) => M.izquierda + (i / (n - 1 || 1)) * w;
  const py = (v) => M.arriba + h - (v / max) * h;

  const degradado = ctx.createLinearGradient(0, M.arriba, 0, M.arriba + h);
  degradado.addColorStop(0, 'rgba(124,58,237,.26)');
  degradado.addColorStop(1, 'rgba(124,58,237,0)');
  ctx.beginPath();
  ctx.moveTo(px(0), py(serie.cifrado[0]));
  serie.cifrado.forEach((v, i) => ctx.lineTo(px(i), py(v)));
  ctx.lineTo(px(n - 1), M.arriba + h);
  ctx.lineTo(px(0), M.arriba + h);
  ctx.closePath();
  ctx.fillStyle = degradado;
  ctx.fill();

  ctx.beginPath();
  serie.cifrado.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = '#7C3AED';
  ctx.lineWidth = 2.4;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Objetivo: línea discontinua
  ctx.beginPath();
  ctx.setLineDash([5, 4]);
  serie.objetivo.forEach((v, i) => (i ? ctx.lineTo(px(i), py(v)) : ctx.moveTo(px(i), py(v))));
  ctx.strokeStyle = '#94A3B8';
  ctx.lineWidth = 1.6;
  ctx.stroke();
  ctx.setLineDash([]);

  // Etiquetas del eje X (una de cada ~5 días)
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto-baj').trim();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const salto = Math.max(1, Math.ceil(n / 7));
  serie.labels.forEach((l, i) => {
    if (i % salto) return;
    ctx.fillText(fechaCorta(l), px(i), M.arriba + h + 9);
  });
}

/** Anillo de reparto por algoritmo. */
function dibujarDonut(canvas, datos) {
  if (!canvas) return;
  const { ctx, ancho, alto } = preparar(canvas, 168);
  const cx = ancho / 2;
  const cy = alto / 2;
  const radio = Math.min(ancho, alto) / 2 - 14;
  const grosor = 26;
  let inicio = -Math.PI / 2;

  datos.forEach((a) => {
    const angulo = (a.value / 100) * Math.PI * 2;
    ctx.beginPath();
    ctx.arc(cx, cy, radio, inicio + 0.02, inicio + angulo - 0.02);
    ctx.strokeStyle = a.color;
    ctx.lineWidth = grosor;
    ctx.lineCap = 'butt';
    ctx.stroke();
    inicio += angulo;
  });

  // Texto central
  const primero = datos[0];
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto').trim();
  ctx.font = '700 22px system-ui, sans-serif';
  ctx.fillText(`${primero.value} %`, cx, cy - 7);
  ctx.font = '11px system-ui, sans-serif';
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--texto-baj').trim();
  ctx.fillText(primero.label, cx, cy + 14);
}

/** Redibuja todos los gráficos registrados (cambio de tema o de tamaño). */
function redibujarGraficos() {
  // Descarta los canvas que ya no están en el DOM (vista cerrada o re-render).
  for (let i = graficos.length - 1; i >= 0; i--) {
    if (document.body.contains(graficos[i].canvas)) graficos[i].fn();
    else graficos.splice(i, 1);
  }
  dibujarSparks();
}

/** Observa el tamaño de un canvas y redibuja sólo cuando cambia de verdad. */
function observarResize(canvas, fn) {
  if (typeof ResizeObserver === 'undefined') return;
  let anchoPrevio = canvas.clientWidth;
  const ro = new ResizeObserver(() => {
    const ancho = canvas.clientWidth;
    if (Math.abs(ancho - anchoPrevio) < 8) return;   // ignora cambios mínimos
    anchoPrevio = ancho;
    fn();
  });
  ro.observe(canvas);
}

/* ==========================================================================
 *  10. ARRANQUE
 * ========================================================================== */

function conectarNavegacion() {
  // Enlaces del sidebar
  document.querySelectorAll('.nav__link').forEach((a) => {
    a.addEventListener('click', (e) => {
      e.preventDefault();
      irA(a.dataset.ir);
      cerrarMenuMovil();
    });
  });

  document.getElementById('btnMenu').addEventListener('click', alternarMenu);
  document.getElementById('capa').addEventListener('click', cerrarMenuMovil);

  // Botón atrás / adelante del navegador
  window.addEventListener('popstate', () => irA((location.hash || '#/resumen').slice(2), { empujar: false }));

  // Atajo: "/" enfoca la búsqueda del inventario
  document.addEventListener('keydown', (e) => {
    if (e.key === '/' && !/input|select|textarea/i.test(document.activeElement.tagName)) {
      e.preventDefault();
      irA('inventario');
      setTimeout(() => document.getElementById('fBusqueda')?.focus(), 80);
    }
    if (e.key === 'Escape') cerrarMenuMovil();
  });
}

function conectarNotificaciones() {
  const btn = document.getElementById('btnNotificaciones');
  const lista = document.getElementById('listaNotificaciones');

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const abierta = !lista.hidden;
    lista.hidden = abierta;
    btn.setAttribute('aria-expanded', String(!abierta));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#popNotificaciones')) {
      lista.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  });
  lista.addEventListener('click', (e) => e.stopPropagation());
}

function conectarTema() {
  document.getElementById('btnTema').addEventListener('click', () => {
    aplicarTema(document.documentElement.dataset.tema !== 'oscuro');
  });
}

function conectarFiltros() {
  const f = filtros.inventario;

  // Búsqueda con rebote: no se lanza una petición por cada tecla.
  document.getElementById('fBusqueda').addEventListener('input', rebocar((e) => {
    f.search = e.target.value.trim();
    f.page = 1;
    pedirInventario();
  }, 320));

  document.getElementById('fEstado').addEventListener('change', (e) => {
    f.estado = e.target.value; f.page = 1; pedirInventario();
  });
  document.getElementById('fTipo').addEventListener('change', (e) => {
    f.tipo = e.target.value; f.page = 1; pedirInventario();
  });
  document.getElementById('btnRefrescarInventario').addEventListener('click', pedirInventario);
  document.getElementById('btnRefrescarMonitoreo').addEventListener('click', () => cargarModulo('monitoreo', { forzar: true }));

  // Segmentos del gráfico (7 / 30 / 90 días)
  document.querySelectorAll('[data-rango]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-rango]').forEach((x) => x.classList.remove('is-activo'));
      b.classList.add('is-activo');
      rangoDias = Number(b.dataset.rango);
      // Se invalida la caché compartida y los tres módulos del resumen
      // se recargan: cada uno vuelve a mostrar su esqueleto.
      delete estado.cache.metricas;
      ['kpis', 'serie', 'algoritmos'].forEach((m) => cargarModulo(m, { forzar: true }));
    });
  });

  // Segmentos de severidad
  document.querySelectorAll('[data-sev]').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('[data-sev]').forEach((x) => x.classList.remove('is-activo'));
      b.classList.add('is-activo');
      filtros.excepciones.severidad = b.dataset.sev;
      cargarModulo('excepciones', { forzar: true });
    });
  });
}

function conectarAjustes() {
  document.getElementById('setTema').addEventListener('change', (e) => aplicarTema(e.target.checked));

  document.getElementById('setFallo').addEventListener('change', (e) => {
    config.forzarFallo = e.target.checked;
    // Se vacía la caché para que la próxima visita vuelva a pedir los datos
    // y el error del módulo sea reproducible.
    if (config.forzarFallo) estado.cache = {};
    avisar(
      e.target.checked ? 'Modo de fallo activado' : 'Modo de fallo desactivado',
      e.target.checked
        ? 'Las próximas peticiones fallarán: usa «Reintentar conexión» para recuperarte.'
        : 'Las peticiones volverán a salir a la red.',
      e.target.checked ? 'alerta' : 'info');
  });

  document.getElementById('setRetardo').addEventListener('change', (e) => {
    config.retardo = Number(e.target.value);
    avisar('Retardo actualizado', `La API responderá en ${config.retardo} ms.`, 'info');
  });

  document.getElementById('btnComprobarSalud').addEventListener('click', comprobarSalud);
}

/** Restaura preferencias guardadas en el navegador. */
function restaurarPreferencias() {
  try {
    const tema = localStorage.getItem('cc:tema');
    if (tema) aplicarTema(tema === 'oscuro');
    const side = localStorage.getItem('cc:sidebar');
    config.sidebarPlegado = side === '1';
    app.classList.toggle('is-plegado', config.sidebarPlegado);
    const cb = document.getElementById('setSidebar');
    if (cb) cb.checked = config.sidebarPlegado;
  } catch { /* almacenamiento no disponible */ }
}

function iniciar() {
  restaurarPreferencias();
  conectarNavegacion();
  conectarTema();
  conectarNotificaciones();
  conectarFiltros();
  conectarAjustes();

  // Componente de ingesta: recibe las utilidades del panel que necesita.
  Ingesta.iniciar({
    api, avisar, anadirNotificacion, cargarModulo, setBadge, esc, num, icono, fechaHora,
    // Datos limpios nuevos: se vacía la caché para que cada dashboard los pida al abrirse.
    alProcesar: () => { estado.cache = {}; },
  });

  // Vista inicial según el hash (permite enlaces profundos /#/inventario)
  irA((location.hash || '#/resumen').slice(2), { empujar: false });

  // Comprobación de salud inicial y periódica.
  comprobarSalud();
  setInterval(comprobarSalud, 30000);

  // Aviso de bienvenida con el estado real del servicio.
  setTimeout(() => {
    const criticas = estado.cache.metricas?.kpis?.find((k) => k.id === 'criticas')?.value;
    if (criticas) {
      anadirNotificacion('peligro', `${criticas} excepciones críticas`,
        'Revisa la sección Excepciones para priorizarlas.');
    }
  }, 1200);
}

document.addEventListener('DOMContentLoaded', iniciar);