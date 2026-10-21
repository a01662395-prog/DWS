/**
 * ============================================================================
 *  Ingesta · puente entre Node.js y el pipeline de limpieza (Python)
 * ============================================================================
 *  Node NO abre ni limpia los Excel: sólo lanza pipeline/pipeline.py sobre el
 *  archivo recibido y devuelve lo que el pipeline responde.
 *
 *    procesar(ruta, id)   Ejecuta el pipeline (de uno en uno) y registra el resultado
 *    estadoDe(id)         Estado de una carga: pending_processing | procesado | error
 *    datosActuales()      Filas de data/current.json (cacheadas hasta que cambie)
 *    metaActual()         Resumen de la última carga válida (data/current_meta.json)
 *
 *  Variables: PYTHON_BIN (por defecto .venv/bin/python o python3) · CLEAN_DIR=./data
 * ============================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

/* ============================================================================
 *  1. CONFIGURACIÓN
 * ========================================================================== */

const ROOT = path.resolve(__dirname, '..');

/** Salida del pipeline: current.json, current_meta.json y el registro de cargas. */
const DATA_DIR = path.resolve(ROOT, process.env.CLEAN_DIR || 'data');

const PIPELINE = path.join(ROOT, 'pipeline', 'pipeline.py');

/** En local se usa el .venv del proyecto si existe; en Docker lo fija PYTHON_BIN. */
const VENV_PYTHON = path.join(ROOT, '.venv', 'bin', 'python');
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : 'python3');

/** Tope de tiempo por archivo: si se pasa, la carga se marca como error. */
const TIMEOUT_MS = 120 * 1000;

const ARCHIVO_DATOS = path.join(DATA_DIR, 'current.json');
const ARCHIVO_META = path.join(DATA_DIR, 'current_meta.json');
const ARCHIVO_REGISTRO = path.join(DATA_DIR, 'registro_cargas.json');

/* ============================================================================
 *  2. REGISTRO DE CARGAS  (id → resultado del pipeline)
 * ========================================================================== */

function leerJSON(ruta, porDefecto) {
  try {
    return JSON.parse(fs.readFileSync(ruta, 'utf8'));
  } catch {
    return porDefecto;
  }
}

/** Escribe a un temporal y lo renombra: nunca queda un archivo a medias. */
function escribirJSONAtomico(ruta, objeto) {
  const tmp = `${ruta}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(objeto, null, 2));
  fs.renameSync(tmp, ruta);
}

function registrar(id, resultado) {
  const registro = leerJSON(ARCHIVO_REGISTRO, {});
  registro[id] = resultado;
  escribirJSONAtomico(ARCHIVO_REGISTRO, registro);
}

/** Lo que aún no tiene resultado (o se subió antes de existir el pipeline) sigue pendiente. */
function estadoDe(id) {
  return leerJSON(ARCHIVO_REGISTRO, {})[id] || { status: 'pending_processing' };
}

/* ============================================================================
 *  3. EJECUCIÓN DEL PIPELINE
 * ========================================================================== */

/** Ejecuta pipeline.py y traduce su salida a {ok, filas, columnas, avisos} | {ok:false, error}. */
function ejecutarPipeline(ruta) {
  return new Promise((resolve) => {
    execFile(PYTHON_BIN, [PIPELINE, ruta, '--out-dir', DATA_DIR],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        // el pipeline siempre imprime un JSON en la última línea, también cuando falla
        const ultima = String(stdout).trim().split('\n').pop();
        let salida = null;
        try { salida = JSON.parse(ultima); } catch { /* sin JSON: falló antes de llegar */ }

        if (salida) return resolve(salida);
        if (err && err.killed) return resolve({ ok: false, error: `El procesamiento superó ${TIMEOUT_MS / 1000} s.` });
        if (err && err.code === 'ENOENT') return resolve({ ok: false, error: `No se encontró Python (${PYTHON_BIN}).` });

        console.error('[ingesta] Pipeline sin respuesta válida:', stderr || (err && err.message));
        resolve({ ok: false, error: 'El pipeline de limpieza falló de forma inesperada.' });
      });
  });
}

/**
 * Cola: los archivos se procesan de uno en uno para que dos cargas
 * simultáneas no escriban current.json a la vez. Gana la última en terminar.
 */
let cola = Promise.resolve();

function procesar(ruta, id) {
  const tarea = cola.then(async () => {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const inicio = Date.now();
    const salida = await ejecutarPipeline(ruta);

    const resultado = {
      status: salida.ok ? 'procesado' : 'error',
      procesadoEn: new Date().toISOString(),
      duracionMs: Date.now() - inicio,
      ...(salida.ok
        ? { filas: salida.filas, columnas: salida.columnas, avisos: salida.avisos || [] }
        : { error: salida.error }),
    };
    registrar(id, resultado);
    console.log(`[ingesta] ${path.basename(ruta)} → ${resultado.status} (${resultado.duracionMs}ms)`);
    return resultado;
  });
  cola = tarea.catch(() => {});   // un fallo no bloquea las cargas siguientes
  return tarea;
}

/* ============================================================================
 *  4. LECTURA DE LOS DATOS LIMPIOS  (para los endpoints del dashboard)
 * ========================================================================== */

let cache = { mtimeMs: 0, filas: null };

/** Filas limpias; se vuelven a leer sólo cuando el pipeline reemplaza current.json. */
function datosActuales() {
  let st;
  try {
    st = fs.statSync(ARCHIVO_DATOS);
  } catch {
    return null;   // todavía no se ha procesado ningún archivo
  }
  if (st.mtimeMs !== cache.mtimeMs) {
    cache = { mtimeMs: st.mtimeMs, filas: leerJSON(ARCHIVO_DATOS, null) };
  }
  return cache.filas;
}

function metaActual() {
  return leerJSON(ARCHIVO_META, null);
}

module.exports = { DATA_DIR, procesar, estadoDe, datosActuales, metaActual };
