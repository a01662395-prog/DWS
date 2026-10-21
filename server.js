/**
 * ============================================================================
 *  CifraControl · Servidor backend en Node.js puro (sin Express, sin Multer)
 * ============================================================================
 *  Dependencias: NINGUNA. Sólo módulos nativos:
 *    http · fs · path · url · crypto
 *
 *  Arranque:  node server.js
 *  Variables: PORT=3000  HOST=127.0.0.1  UPLOADS_DIR=./uploads  SIMULATED_DELAY_MS=900
 *
 *  ── REST API ──────────────────────────────────────────────────────────────
 *    GET  /api/health                     Estado del servicio
 *    GET  /api/dashboard/metrics          KPIs + series (con retardo simulado)
 *    GET  /api/dashboard/inventario       Activos filtrables y paginados
 *    GET  /api/dashboard/tecnologias      Stack detectado con riesgo
 *    GET  /api/dashboard/monitoreo        Salud de servicios
 *    GET  /api/dashboard/excepciones      Incidencias por severidad
 *    GET  /api/uploads                    Metadatos de lo recibido + estado del pipeline
 *    GET  /api/datos/estado               Resumen de los datos limpios vigentes
 *    POST /api/upload-excel               Ingesta .xlsx/.xls/.csv → /uploads → pipeline
 *
 *  ── Principio de la ingesta (NO NEGOCIABLE) ────────────────────────────────
 *  Node.js NO abre, parsea, limpia ni procesa los Excel. Sólo es un guardián
 *  de recepción seguro: valida y almacena, y delega la limpieza en el
 *  pipeline de Python (backend/ingesta.js → pipeline/pipeline.py).
 * ============================================================================
 */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const ingesta = require('./backend/ingesta');

/* ============================================================================
 *  1. CONFIGURACIÓN
 * ========================================================================== */

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const ROOT = __dirname;

/** Carpura de recepción. En producción será un volumen Docker (/uploads). */
const UPLOADS_DIR = path.resolve(ROOT, process.env.UPLOADS_DIR || 'uploads');

/** Retardo artificial para poder ver los Skeleton Loaders en acción. */
const DELAY_MS = Math.max(0, Number(process.env.SIMULATED_DELAY_MS) || 900);

/** Tope de tamaño del cuerpo de la petición (evita agotar la memoria). */
const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // 25 MB

/** Extensiones admitidas por la ingesta. */
const EXTENSIONES_OK = ['.xlsx', '.xls', '.csv'];

/** Tipos MIME estáticos permitidos. Lista blanca: nunca se sirve nada más. */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/* ============================================================================
 *  2. UTILIDADES
 * ========================================================================== */

/** PRNG determinista: los datos simulados son estables entre peticiones. */
function prng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const randInt = (rnd, min, max) => Math.floor(rnd() * (max - min + 1)) + min;
const round = (n, dec = 2) => Math.round(n * 10 ** dec) / 10 ** dec;

/** Fecha ISO (yyyy-mm-dd) de hace `dias` días. */
function isoDaysAgo(dias) {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - dias);
  return d.toISOString().slice(0, 10);
}

/** Fecha ISO completa (hora y minutos) para los metadatos de ingesta. */
const isoAhora = () => new Date().toISOString();

/**
 * Sanea el nombre de archivo SUBIDO POR EL CLIENTE.
 * Sin esto, un "../../etc/passwd" o un "archivo.exe" terminarían en el disco.
 */
function sanearNombre(nombre) {
  return path
    .basename(String(nombre || 'archivo'))          // elimina cualquier ruta
    .normalize('NFKD')                             // descompone acentos
    .replace(/[^\w.\- ]+/g, '')                    // fuera todo lo sospechoso
    .replace(/\s+/g, '_')
    .replace(/^\.+/, '')                           // nada de archivos ocultos
    .slice(0, 120) || 'archivo';
}

/** MIME de un archivo por extensión. */
const mimeDe = (ext) =>
  ({ '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
     '.xls': 'application/vnd.ms-excel',
     '.csv': 'text/csv' }[ext.toLowerCase()] || 'application/octet-stream');

/** Promesa de espera (para el retardo simulado). */
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================================================================
 *  3. CAPA DE RESPUESTA
 * ========================================================================== */

function cabeceras(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'X-Content-Type-Options': 'nosniff',
    ...extra,
  };
}

function enviarJSON(res, codigo, objeto) {
  res.writeHead(codigo, cabeceras({ 'Content-Type': 'application/json; charset=utf-8' }));
  res.end(JSON.stringify(objeto, null, 2));
}

/** Error de API uniforme: el frontend siempre recibe {error, message}. */
const enviarError = (res, codigo, error, message, extra = {}) =>
  enviarJSON(res, codigo, { error, message, ...extra });

/** Página HTML mínima para errores del servidor de archivos. */
function enviarErrorHTML(res, codigo, titulo, detalle) {
  res.writeHead(codigo, cabeceras({ 'Content-Type': 'text/html; charset=utf-8' }));
  res.end(`<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><title>${codigo}</title>
<style>body{font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;
background:#F8FAFC;color:#0F172A;text-align:center}.b{max-width:420px;padding:2rem}h1{font-size:4rem;margin:0;color:#7C3AED}
a{display:inline-block;margin-top:1rem;padding:.6rem 1.2rem;background:#7C3AED;color:#fff;border-radius:8px;
text-decoration:none;font-weight:600}</style></head><body><div class="b"><h1>${codigo}</h1>
<p><strong>${titulo}</strong><br>${detalle}</p><a href="/">Volver al panel</a></div></body></html>`);
}

/* ============================================================================
 *  4. DATOS SIMULADOS · dominio "CifraControl"
 * ========================================================================== */

/** Activos del inventario con su estado de cifrado. */
const ACTIVOS = [
  ['PostgreSQL producción', 'Base de datos', 'AES-256', 'protegido', 'us-east-1 / RDS'],
  ['MySQL legado reporting', 'Base de datos', 'AES-128', 'parcial', 'us-east-1 / EC2'],
  ['Bucket S3 facturas', 'Almacenamiento', 'AES-256', 'protegido', 'eu-west-1 / S3'],
  ['SharePoint corporativo', 'Almacenamiento', 'NINGUNO', 'sin_cifrar', 'on-premise / SMB'],
  ['Laptopule HR-4471', 'Endpoint', 'AES-256', 'protegido', 'Madrid / Intune'],
  ['Servidor de ficheros', 'Servidor', '3DES', 'parcial', 'on-premise / Windows'],
  ['MongoDB métricas', 'Base de datos', 'AES-256', 'protegido', 'us-west-2 / Atlas'],
  ['Backup tapes archivados', 'Almacenamiento', 'AES-256', 'parcial', 'on-premise / LTO'],
  ['MacBook diseño-12', 'Endpoint', 'NINGUNO', 'sin_cifrar', 'Barcelona / JAMF'],
  ['Kafka bus de eventos', 'Middleware', 'SASL_SSL', 'protegido', 'us-east-1 / MSK'],
  ['Redis de sesiones', 'Base de datos', 'TLS', 'protegido', 'us-east-1 / ElastiCache'],
  ['NAS departmental', 'Almacenamiento', 'AES-128', 'parcial', 'Valencia / Synology'],
];

const RESPONSABLES = ['A. Torres', 'B. Díaz', 'C. Méndez', 'D. Rojas', 'E. Vidal', 'F. Ortiz', 'G. Solar'];

/** Tipos de excepción con su severidad característica. */
const TIPOS_EXCEPCION = [
  'Clave de cifrado expirada',
  'Algoritmo obsoleto (3DES)',
  'Certificado a punto de expirar',
  'Acceso anómalo detectado',
  'Clave almacenada en texto plano',
  'Rotación de claves vencida',
  'Dispositivo no inventariado',
  'Copia de seguridad sin cifrar',
];

const SEVERIDADES = ['critica', 'alta', 'media', 'baja'];

/** Stack tecnológico con riesgo asociado. */
const TECNOLOGIAS = [
  ['PostgreSQL', 'Base de datos', '16.2', 'medio', 5.3, 128],
  ['Node.js', 'Lenguaje', '22.11', 'bajo', 3.1, 94],
  ['React', 'Framework', '18.3', 'bajo', 4.1, 87],
  ['OpenSSL', 'Criptografía', '3.2.1', 'critico', 7.5, 61],
  ['Nginx', 'Infraestructura', '1.25', 'bajo', 2.8, 74],
  ['jQuery', 'Frontend', '3.7.1', 'medio', 6.1, 22],
  ['Docker', 'Infraestructura', '24.0', 'bajo', 2.4, 69],
  ['Windows Server 2012', 'Sistema', '6.3', 'critico', 8.1, 15],
  ['log4j', 'Dependencia', '2.14', 'critico', 9.0, 12],
  ['Python', 'Lenguaje', '3.12', 'bajo', 2.1, 55],
];

/** Servicios vigilados por el módulo de monitoreo. */
const SERVICIOS = [
  ['API Gateway', 'operativo', 99.98, 82],
  ['Motor de escaneo', 'operativo', 99.92, 140],
  ['Indexador de activos', 'degradado', 97.40, 620],
  ['Notificaciones', 'operativo', 99.99, 45],
  ['Sincronizador AD', 'operativo', 99.85, 210],
  ['Worker de rotación', 'caido', 91.20, 0],
];

/** Dataset de inventario (paginable/filtrable desde el frontend). */
function generarInventario(seed) {
  const rnd = prng(seed);
  return Array.from({ length: 64 }, (_, i) => {
    const [nombre, tipo, cifrado, estado, ubicacion] = ACTIVOS[randInt(rnd, 0, ACTIVOS.length - 1)];
    const sufijo = i >= ACTIVOS.length ? ` ${i + 1}` : '';
    return {
      id: 'AST-' + String(4820 - i),
      nombre: nombre + sufijo,
      tipo,
      cifrado,
      estado,
      ubicacion,
      responsable: RESPONSABLES[randInt(rnd, 0, RESPONSABLES.length - 1)],
      bytesCifrados: randInt(rnd, 2, 980) * 1e6,
      ultimoAnalisis: isoDaysAgo(randInt(rnd, 0, 45)),
      // Iniciales para el avatar de la tabla
      iniciales: nombre.split(' ').slice(0, 2).map((p) => p[0]).join('').toUpperCase(),
    };
  });
}

/** Incidencias con severidad, estado de triage y responsable. */
function generarExcepciones(seed) {
  const rnd = prng(seed);
  return Array.from({ length: 47 }, (_, i) => {
    const activo = ACTIVOS[randInt(rnd, 0, ACTIVOS.length - 1)][0];
    const severidad = SEVERIDADES[randInt(rnd, 0, 3)] === 'critica' && rnd() < 0.3 ? 'critica' : SEVERIDADES[randInt(rnd, 0, 3)];
    return {
      id: 'EXC-' + String(9130 - i),
      activo,
      tipo: TIPOS_EXCEPCION[randInt(rnd, 0, TIPOS_EXCEPCION.length - 1)],
      severidad,
      estado: ['abierta', 'en_revision', 'resuelta'][randInt(rnd, 0, 2)],
      responsable: RESPONSABLES[randInt(rnd, 0, RESPONSABLES.length - 1)],
      detectada: isoDaysAgo(randInt(rnd, 0, 30)),
    };
  });
}

/** KPIs + series de los gráficos del resumen. */
function generarMetricas(days, seed) {
  const rnd = prng(seed);
  const labels = [];
  const cifrado = [];      // GB cifrados por día
  const eventos = [];      // eventos de clave detectados
  const objetivo = [];

  let base = 620;
  for (let i = days - 1; i >= 0; i--) {
    base += (rnd() - 0.45) * 90;
    labels.push(isoDaysAgo(i));
    cifrado.push(round(Math.max(220, base + Math.sin(i / 3) * 120), 1));
    eventos.push(randInt(rnd, 4, 38));
    objetivo.push(round(640 + Math.sin(i / 5) * 30, 1));
  }

  const totalCifrado = round(cifrado.reduce((a, b) => a + b, 0), 1);
  const totalEventos = eventos.reduce((a, b) => a + b, 0);
  const anterior = totalCifrado * 0.82;

  return {
    generadoEn: isoAhora(),
    rango: { dias: days, desde: labels[0], hasta: labels[labels.length - 1] },

    kpis: [
      { id: 'cifrado', label: 'Datos cifrados', format: 'gb', value: totalCifrado,
        delta: round(((totalCifrado - anterior) / anterior) * 100, 1), sufijo: 'vs. periodo anterior',
        icono: 'candado', color: '#7C3AED', spark: cifrado.slice(-14) },
      { id: 'activos', label: 'Activos inventariados', format: 'num', value: 412,
        delta: 2.4, sufijo: 'vs. periodo anterior', icono: 'servidor', color: '#8B5CF6',
        spark: activosSpark(rnd) },
      { id: 'cobertura', label: 'Cobertura de cifrado', format: 'percent', value: 87.3,
        delta: 1.8, sufijo: 'vs. periodo anterior', icono: 'escudo', color: '#0EA5E9',
        spark: Array.from({ length: 14 }, (_, i) => round(82 + i * 0.4 + rnd() * 2, 1)) },
      { id: 'criticas', label: 'Excepciones críticas', format: 'num', value: 7,
        delta: -12.5, sufijo: 'vs. periodo anterior', icono: 'alerta', color: '#EF4444',
        spark: Array.from({ length: 14 }, (_, i) => Math.max(1, 12 - i * 0.4 + randInt(rnd, 0, 3))) },
    ],

    graficos: {
      serie: { labels, cifrado, eventos, objetivo },
      algoritmos: [
        { label: 'AES-256', value: 62, color: '#7C3AED' },
        { label: 'AES-128', value: 18, color: '#A78BFA' },
        { label: 'RSA-2048', value: 11, color: '#0EA5E9' },
        { label: 'TLS', value: 6, color: '#10B981' },
        { label: 'Sin cifrar', value: 3, color: '#F97316' },
      ],
      maximo: Math.max(...cifrado),
      pico: labels[cifrado.indexOf(Math.max(...cifrado))],
    },
    resumen: { totalEventos, días: days },
    // Reparto del parque: alimenta el badge accionable del sidebar.
    inventario: resumenInventario(seed),
  };
}

/** Recuento por estado de cifrado del inventario completo. */
function resumenInventario(seed) {
  const filas = generarInventario(seed);
  const cuentas = filas.reduce((acc, f) => ({ ...acc, [f.estado]: (acc[f.estado] || 0) + 1 }), {});
  const protegidos = cuentas.protegido || 0;
  const parcial = cuentas.parcial || 0;
  const sinCifrar = cuentas.sin_cifrar || 0;
  return {
    total: filas.length,
    protegidos,
    parcial,
    sinCifrar,
    // Lo que un humano tiene que atacar: parciales + sin cifrar.
    pendientes: parcial + sinCifrar,
    cobertura: Math.round((protegidos / filas.length) * 1000) / 10,
  };
}

/** Sparkline sintético para el KPI de activos. */
function activosSpark(rnd) {
  return Array.from({ length: 14 }, (_, i) => 380 + i * 2 + randInt(rnd, 0, 12));
}

/* ============================================================================
 *  5. ALMACÉN DE INGESTA (equivalente al volumen /uploads)
 * ========================================================================== */

/** Crea el directorio de recepción si no existe. */
function asegurarUploads() {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
    console.log(`[uploads] Directorio de recepción creado: ${UPLOADS_DIR}`);
  }
}

/**
 * Lista los archivos recibidos SOLO con sus metadatos.
 * No lee su contenido: el estado lo aporta el registro del pipeline.
 */
function listarUploads() {
  return fs.readdirSync(UPLOADS_DIR)
    .filter((n) => !n.startsWith('.'))
    .map((n) => {
      const st = fs.statSync(path.join(UPLOADS_DIR, n));
      const id = n.split('__')[0];
      return {
        id,
        archivo: n.split('__').slice(1).join('__') || n,
        bytes: st.size,
        bytesLegibles: etiquetaBytes(st.size),
        recibidoEn: st.birthtime.toISOString(),
        // status (pending_processing | procesado | error), avisos o error del pipeline
        ...ingesta.estadoDe(id),
      };
    })
    .sort((a, b) => new Date(b.recibidoEn) - new Date(a.recibidoEn));
}

/** Alias con nombre en español (legibilidad). */
const etiquetaBytes = (b) => {
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${round(n, i ? 1 : 0)} ${u[i]}`;
};

/* ============================================================================
 *  6. PARSER MULTIPART NATIVO (sustituye a Multer, sin dependencias)
 * ========================================================================== */

/**
 * Analiza un cuerpo multipart/form-data y devuelve {campos, archivos}.
 *
 * Implementa sólo el subconjunto que produce un navegador con FormData:
 *   --boundary\r\n
 *   Content-Disposition: form-data; name="file"; filename="datos.xlsx"\r\n
 *   Content-Type: ...\r\n\r\n
 *   <bytes>\r\n
 *
 * El cuerpo se lee COMPLETO en memoria (con tope de MAX_UPLOAD_BYTES) porque
 * es la única forma de encontrar los límites sin parsear en streaming.
 */
function parseMultipart(buffer, boundary) {
  const campos = {};
  const archivos = [];

  // El estándar termina las partes con CRLF antes del siguiente --boundary.
  const delimitador = Buffer.from(`--${boundary}`);
  const posiciones = [];
  let desde = buffer.indexOf(delimitador);
  while (desde !== -1) {
    posiciones.push(desde);
    desde = buffer.indexOf(delimitador, desde + delimitador.length);
  }

  for (let i = 0; i < posiciones.length - 1; i++) {
    const inicio = posiciones[i] + delimitador.length;
    const fin = posiciones[i + 1];
    // "--boundary--" marca el cierre: se descarta.
    if (buffer.slice(inicio, inicio + 2).toString() === '--') break;
    // Salta el CRLF posterior al delimitador.
    let cursor = inicio + 2;

    // Cabeceras de la parte → separación con la línea en blanco.
    const finCabeceras = buffer.indexOf('\r\n\r\n', cursor);
    if (finCabeceras === -1 || finCabeceras > fin) continue;

    const cabeceras = buffer.slice(cursor, finCabeceras).toString('utf8');
    const cuerpo = buffer.slice(finCabeceras + 4, fin - 2); // -2 quita el CRLF final

    const nombreCampo = /name="([^"]*)"/i.exec(cabeceras);
    const nombreArchivo = /filename="([^"]*)"/i.exec(cabeceras);
    if (!nombreCampo) continue;

    if (nombreArchivo) {
      archivos.push({
        campo: nombreCampo[1],
        nombre: nombreArchivo[1],
        mime: (/content-type:\s*([^\r\n]+)/i.exec(cabeceras) || [, 'application/octet-stream'])[1].trim(),
        datos: cuerpo,
      });
    } else {
      campos[nombreCampo[1]] = cuerpo.toString('utf8');
    }
  }

  return { campos, archivos };
}

/** Lee el cuerpo de la petición con un tope duro de tamaño. */
function leerCuerpo(req, limite) {
  return new Promise((resolve, reject) => {
    const trozos = [];
    let total = 0;
    req.on('data', (trozo) => {
      total += trozo.length;
      if (total > limite) {
        reject(Object.assign(new Error('El archivo supera el tamaño máximo permitido'), { code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      trozos.push(trozo);
    });
    req.on('end', () => resolve(Buffer.concat(trozos)));
    req.on('error', reject);
  });
}

/**
 * POST /api/upload-excel
 * Valida y guarda el archivo. NO lo abre ni lo transforma: eso lo hace el
 * pipeline, y la respuesta espera a su resultado.
 */
async function apiUploadExcel(req, res) {
  const tipo = req.headers['content-type'] || '';
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(tipo);

  if (!/multipart\/form-data/i.test(tipo) || !boundary) {
    return enviarError(res, 400, 'BAD_REQUEST', 'Se esperaba un envío multipart/form-data con el campo "file".');
  }

  let cuerpo;
  try {
    cuerpo = await leerCuerpo(req, MAX_UPLOAD_BYTES);
  } catch (err) {
    return enviarError(res, err.code === 'TOO_LARGE' ? 413 : 400,
      err.code === 'TOO_LARGE' ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
      `Máximo permitido por archivo: ${etiquetaBytes(MAX_UPLOAD_BYTES)}.`);
  }

  const { campos, archivos } = parseMultipart(cuerpo, (boundary[1] || boundary[2]).trim());
  const archivo = archivos.find((a) => a.campo === 'file') || archivos[0];

  if (!archivo || !archivo.datos.length) {
    return enviarError(res, 400, 'NO_FILE', 'No se recibió ningún archivo en el campo "file".');
  }
  if (archivo.datos.length > MAX_UPLOAD_BYTES) {
    return enviarError(res, 413, 'PAYLOAD_TOO_LARGE', `El archivo supera los ${etiquetaBytes(MAX_UPLOAD_BYTES)}.`);
  }

  const nombreLimpio = sanearNombre(archivo.nombre);
  const ext = path.extname(nombreLimpio).toLowerCase();

  if (!EXTENSIONES_OK.includes(ext)) {
    return enviarError(res, 415, 'UNSUPPORTED_MEDIA_TYPE',
      `Extensión no admitida: "${ext || 'sin extensión'}". Se aceptan ${EXTENSIONES_OK.join(', ')}.`);
  }
  // Ceguera mínima: un CSV/XLSX nunca empieza por la firma de un ejecutable PE.
  if (archivo.datos[0] === 0x4d && archivo.datos[1] === 0x5a) {
    return enviarError(res, 415, 'UNSUPPORTED_MEDIA_TYPE', 'El contenido no parece una hoja de cálculo.');
  }

  // Nombre en disco: id único + nombre saneado → nunca se pisan entre sí.
  const id = crypto.randomUUID();
  const nombreDisco = `${id}__${nombreLimpio}`;
  const destino = path.join(UPLOADS_DIR, nombreDisco);

  try {
    await fs.promises.writeFile(destino, archivo.datos);
  } catch (err) {
    console.error('[uploads] Error de escritura:', err.message);
    return enviarError(res, 500, 'STORAGE_ERROR', 'No se pudo guardar el archivo en el almacén de recepción.');
  }

  console.log(`[uploads] Recibido ${nombreDisco} (${etiquetaBytes(archivo.datos.length)}) → pipeline`);
  const recibidoEn = isoAhora();
  const resultado = await ingesta.procesar(destino, id);

  // Si el pipeline rechaza el archivo, los datos limpios anteriores siguen vigentes.
  if (resultado.status === 'error') {
    return enviarError(res, 422, 'PROCESSING_ERROR',
      `No se pudo procesar el archivo: ${resultado.error.replace(/\.$/, '')}. Se mantienen los datos anteriores.`,
      { id, archivo: nombreLimpio, status: 'error' });
  }

  // Respuesta: metadatos + resultado del pipeline. El frontend muestra la confirmación.
  enviarJSON(res, 201, {
    id,
    archivo: nombreLimpio,
    bytes: archivo.datos.length,
    bytesLegibles: etiquetaBytes(archivo.datos.length),
    contentType: mimeDe(ext),
    recibidoEn,
    ...resultado,
    mensaje: `Archivo procesado: ${resultado.filas} equipos. Los dashboards ya usan estos datos.`,
  });
}

/* ============================================================================
 *  7. SERVIDOR DE ARCHIVOS ESTÁTICOS
 * ========================================================================== */

function servirEstatico(req, res, pathname) {
  const relativa = pathname === '/' ? '/index.html' : pathname;
  const destino = path.join(ROOT, path.normalize(relativa));

  // Barrera anti path-traversal: el archivo debe seguir dentro de ROOT.
  if (!destino.startsWith(ROOT + path.sep)) {
    return enviarErrorHTML(res, 403, 'Acceso denegado', 'Ruta fuera del directorio permitido.');
  }

  // El almacén de ingesta, los datos limpios y el código del servidor son privados:
  // sólo se exponen por la API.
  if (/^\/(uploads|data|backend|pipeline)(\/|$)/.test(pathname)) {
    return enviarErrorHTML(res, 403, 'Acceso denegado', 'Este recurso no es público.');
  }

  const ext = path.extname(destino).toLowerCase();
  if (!MIME[ext]) {
    return enviarErrorHTML(res, 404, 'Recurso no disponible',
      `No se permite servir archivos "${ext || 'sin extensión'}".`);
  }

  fs.readFile(destino, (err, datos) => {
    if (err) {
      if (err.code === 'ENOENT' || err.code === 'EISDIR') {
        return pathname.startsWith('/api/')
          ? enviarError(res, 404, 'NOT_FOUND', `No existe el recurso ${pathname}`)
          : enviarErrorHTML(res, 404, 'Página no encontrada', `El archivo "${pathname}" no está en el servidor.`);
      }
      return enviarErrorHTML(res, 500, 'Error interno', 'No se pudo leer el archivo solicitado.');
    }

    res.writeHead(200, cabeceras({
      'Content-Type': MIME[ext],
      'Content-Length': datos.length,
      'Cache-Control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
    }));
    res.end(req.method === 'HEAD' ? undefined : datos);
  });
}

/**
 * Retardo artificial de un endpoint.
 * Se puede forzar desde el cliente con ?delay=ms (lo usa la vista Ajustes)
 * y si no, se aplica una fracción del retardo global del servidor.
 */
function retardo(query, factor = 1) {
  const pedido = query.delay ?? DELAY_MS;
  const ms = Math.min(Math.max(Number(pedido), 0), 8000);
  return dormir(Math.round(ms * factor));
}

/* ============================================================================
 *  8. ENDPOINTS DEL DASHBOARD
 * ========================================================================== */

function apiHealth(res) {
  enviarJSON(res, 200, {
    status: 'ok',
    servicio: 'cifracontrol-core',
    version: '1.0.0',
    uptime: round(process.uptime(), 1),
    node: process.version,
    timestamp: isoAhora(),
    almacenamiento: { dir: path.relative(ROOT, UPLOADS_DIR) || '.', pendientes: listarUploads().length },
  });
}

/**
 * GET /api/dashboard/metrics?days=30&delay=900
 * El retardo es INTENTIONAL: permite ver los Skeleton Loaders del frontend.
 */
async function apiMetrics(req, res, query) {
  const days = [7, 30, 90].includes(Number(query.days)) ? Number(query.days) : 30;
  const seed = Number.isFinite(Number(query.seed)) ? Number(query.seed) : days * 17;
  await retardo(query, 1);              // ← lo que hace útil al Skeleton Loader
  enviarJSON(res, 200, generarMetricas(days, seed));
}

/** GET /api/dashboard/inventario?search=&estado=&tipo=&sort=&dir=&page=&pageSize= */
async function apiInventario(req, res, query) {
  await retardo(query, 0.6);
  let filas = generarInventario(Number(query.seed) || 11);

  const q = String(query.search || '').trim().toLowerCase();
  if (q) {
    filas = filas.filter((f) =>
      f.nombre.toLowerCase().includes(q) || f.id.toLowerCase().includes(q) ||
      f.ubicacion.toLowerCase().includes(q) || f.responsable.toLowerCase().includes(q));
  }
  if (query.estado) filas = filas.filter((f) => f.estado === query.estado);
  if (query.tipo) filas = filas.filter((f) => f.tipo === query.tipo);

  const columna = ['id', 'nombre', 'tipo', 'cifrado', 'estado', 'ubicacion', 'bytesCifrados', 'ultimoAnalisis'].includes(query.sort)
    ? query.sort : 'ultimoAnalisis';
  const dir = query.dir === 'asc' ? 1 : -1;
  filas.sort((a, b) => {
    const va = a[columna], vb = b[columna];
    return typeof va === 'number' ? (va - vb) * dir : String(va).localeCompare(String(vb), 'es', { numeric: true }) * dir;
  });

  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || 8, 1), 50);
  const totalPaginas = Math.max(1, Math.ceil(filas.length / pageSize));
  const pagina = Math.min(Math.max(parseInt(query.page, 10) || 1, 1), totalPaginas);
  const desde = (pagina - 1) * pageSize;

  enviarJSON(res, 200, {
    filas: filas.slice(desde, desde + pageSize),
    // El resumen se calcula sobre el dataset SIN filtrar: el badge del
    // sidebar debe reflejar el parque completo, no la búsqueda actual.
    resumen: resumenInventario(Number(query.seed) || 11),
    paginacion: {
      pagina, porPagina: pageSize, total: filas.length, totalPaginas: totalPaginas,
      desde: desde + 1, hasta: Math.min(desde + pageSize, filas.length),
    },
    filtros: { search: q, estado: query.estado || '', tipo: query.tipo || '', sort: columna, dir: query.dir === 'asc' ? 'asc' : 'desc' },
    tiposDisponibles: [...new Set(ACTIVOS.map((a) => a[1]))],
  });
}

/** GET /api/dashboard/excepciones?severidad= */
async function apiExcepciones(req, res, query) {
  await retardo(query, 0.5);
  let filas = generarExcepciones(Number(query.seed) || 23);
  if (query.severidad) filas = filas.filter((f) => f.severidad === query.severidad);

  // Las críticas primero: es el dato que obliga a actuar.
  const peso = { critica: 0, alta: 1, media: 2, baja: 3 };
  filas.sort((a, b) => (peso[a.severidad] - peso[b.severidad]) || (a.detectada < b.detectada ? 1 : -1));

  // El conteo por severidad se calcula de una sola pasada sobre el dataset.
  const conteo = SEVERIDADES.reduce((acc, s) => {
    acc[s] = generarExcepciones(Number(query.seed) || 23).filter((f) => f.severidad === s).length;
    return acc;
  }, {});

  enviarJSON(res, 200, {
    filas: filas.slice(0, 25),
    conteo,
    total: filas.length,
  });
}

/** GET /api/dashboard/tecnologias */
async function apiTecnologias(req, res, query) {
  await retardo(query, 0.5);
  const rnd = prng(41);
  enviarJSON(res, 200, {
    filas: TECNOLOGIAS.map(([nombre, categoria, version, riesgo, cvss, uso]) => ({
      nombre, categoria, version, riesgo, cvss,
      uso,
      dependencias: randInt(rnd, 1, 48),
      ultimaVersion: version + '.' + randInt(rnd, 0, 9),
      desactualizada: rnd() < 0.35,
    })).sort((a, b) => b.cvss - a.cvss),
    resumen: {
      total: TECNOLOGIAS.length,
      criticas: TECNOLOGIAS.filter((t) => t[3] === 'critico').length,
      alto: TECNOLOGIAS.filter((t) => t[3] === 'alto').length,
    },
  });
}

/** GET /api/dashboard/monitoreo */
async function apiMonitoreo(req, res, query) {
  await retardo(query, 0.4);
  const rnd = prng(67);
  enviarJSON(res, 200, {
    filas: SERVICIOS.map(([servicio, estado, uptime, latencia]) => ({
      servicio, estado, uptime, latencia,
      ultimaComprobacion: isoAhora(),
      intentos: estado === 'caido' ? randInt(rnd, 3, 9) : randInt(rnd, 0, 2),
     Hostname: `svc-${servicio.toLowerCase().replace(/\s/g, '-')}.internal`,
    })),
    resumen: {
      operativos: SERVICIOS.filter((s) => s[1] === 'operativo').length,
      degradados: SERVICIOS.filter((s) => s[1] === 'degradado').length,
      caidos: SERVICIOS.filter((s) => s[1] === 'caido').length,
    },
  });
}

/** GET /api/uploads → archivos recibidos con el resultado del pipeline */
function apiListarUploads(res) {
  const filas = listarUploads();
  enviarJSON(res, 200, {
    filas,
    pendientes: filas.filter((f) => f.status === 'pending_processing').length,
    nota: 'Cada archivo se limpia con el pipeline al recibirlo; el último procesado alimenta los dashboards.',
  });
}

/** GET /api/datos/estado → resumen de los datos limpios vigentes (o disponible:false) */
function apiEstadoDatos(res) {
  const meta = ingesta.metaActual();
  if (!meta) return enviarJSON(res, 200, { disponible: false });
  // En disco el archivo es {id}__{nombre}: al front sólo le interesa el nombre.
  const archivoOrigen = meta.archivo_origen.split('__').slice(1).join('__') || meta.archivo_origen;
  enviarJSON(res, 200, { disponible: true, ...meta, archivo_origen: archivoOrigen });
}

/* ============================================================================
 *  9. ENRUTADOR
 * ========================================================================== */

async function enrutar(req, res) {
  const { pathname, query } = url.parse(req.url, true);
  const metodo = (req.method || 'GET').toUpperCase();

  if (metodo === 'OPTIONS') {
    res.writeHead(204, cabeceras({ 'Content-Length': 0 }));
    return res.end();
  }

  const esApi = pathname.startsWith('/api/');

  // Control de métodos: sólo lectura + la ingesta POST.
  if (metodo !== 'GET' && metodo !== 'HEAD' && !(metodo === 'POST' && pathname === '/api/upload-excel')) {
    res.setHeader('Allow', 'GET, HEAD, POST, OPTIONS');
    return esApi
      ? enviarError(res, 405, 'METHOD_NOT_ALLOWED', `El método ${metodo} no está permitido.`)
      : enviarErrorHTML(res, 405, 'Método no permitido', 'Este servidor responde a GET, HEAD y POST /api/upload-excel.');
  }

  /* ------------------------------- API ---------------------------------- */
  switch (pathname) {
    case '/api/health':                return apiHealth(res);
    case '/api/dashboard/metrics':     return apiMetrics(req, res, query);
    case '/api/dashboard/inventario':  return apiInventario(req, res, query);
    case '/api/dashboard/excepciones': return apiExcepciones(req, res, query);
    case '/api/dashboard/tecnologias': return apiTecnologias(req, res, query);
    case '/api/dashboard/monitoreo':   return apiMonitoreo(req, res, query);
    case '/api/uploads':               return apiListarUploads(res);
    case '/api/datos/estado':          return apiEstadoDatos(res);
    case '/api/upload-excel':          return apiUploadExcel(req, res);
  }

  if (esApi) {
    return enviarError(res, 404, 'NOT_FOUND', `El endpoint ${pathname} no existe en la API.`);
  }

  /* ---------------------------- Estáticos ------------------------------- */
  return servirEstatico(req, res, pathname);
}

/* ============================================================================
 *  10. ARRANQUE
 * ========================================================================== */

const server = http.createServer((req, res) => {
  const inicio = process.hrtime.bigint();

  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    console.log(`${res.statusCode}  ${req.method}  ${req.url}  ${ms.toFixed(1)}ms`);
  });

  Promise.resolve()
    .then(() => enrutar(req, res))
    .catch((err) => {
      // Manejo centralizado de excepciones: la UI nunca ve un fallo desnudo.
      console.error('[500]', req.url, '→', err);
      if (res.headersSent) return res.end();
      if ((req.url || '').startsWith('/api/')) {
        return enviarError(res, 500, 'INTERNAL_ERROR', 'Error inesperado en el servidor.');
      }
      return enviarErrorHTML(res, 500, 'Error interno del servidor', 'Se ha registrado el incidente. Inténtalo de nuevo.');
    });
});

asegurarUploads();

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────────────┐');
  console.log('  │  CifraControl · API Core (Node.js puro)             │');
  console.log('  └───────────────────────────────────────────────────┘');
  console.log(`  → Panel:   http://${HOST}:${PORT}/`);
  console.log(`  → Salud:   http://${HOST}:${PORT}/api/health`);
  console.log(`  → Ingesta: POST http://${HOST}:${PORT}/api/upload-excel  (campo "file")`);
  console.log(`  → Retardo simulado: ${DELAY_MS}ms  ·  almacén: ${UPLOADS_DIR}`);
  console.log(`  → Datos limpios: ${ingesta.DATA_DIR}`);
  console.log('');
});

for (const senal of ['SIGINT', 'SIGTERM']) {
  process.on(senal, () => {
    console.log(`\n[${senal}] Cerrando servidor…`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 3000).unref();
  });
}
