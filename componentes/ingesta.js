/* ============================================================================
 *  CifraControl · Componente de ingesta (vista "Cargar Excel")
 * ============================================================================
 *  Conecta la vista con el pipeline de limpieza:
 *
 *    Excel ──► POST /api/upload-excel ──► pipeline (Python) ──► data/current.json
 *                       │                                              │
 *                       └── respuesta: procesado + avisos | error      └── dashboards
 *
 *  Contrato con app.js:
 *    Ingesta.iniciar(deps)   conecta la zona de carga. deps = utilidades de app.js
 *                            { api, avisar, anadirNotificacion, cargarModulo, setBadge,
 *                              esc, num, icono, fechaHora, alProcesar }
 *    Ingesta.cargarCola()    datos del módulo "cola" (archivos + datos vigentes)
 *    Ingesta.pintarCola(d)   renderizador del módulo "cola"
 *
 *  alProcesar() se llama cuando hay datos limpios nuevos: app.js decide qué
 *  dashboards refrescar. El componente no conoce al resto del panel.
 * ========================================================================== */

'use strict';

const Ingesta = (() => {
  const MAX_MB = 25;
  const EXT_OK = ['.xlsx', '.xls', '.csv'];

  /** Etiqueta visual de cada estado del pipeline. */
  const ESTADOS = {
    procesado:          { texto: 'procesado', clase: 'et--exito' },
    error:              { texto: 'error', clase: 'et--peligro' },
    pending_processing: { texto: 'pendiente', clase: 'et--violeta' },
  };

  let d = null;   // dependencias recibidas de app.js
  let el = {};    // elementos del DOM de la vista

  /* ------------------------------------------------------------------------
   *  Envío del archivo
   * ---------------------------------------------------------------------- */

  /** Valida el archivo antes de enviarlo: no desperdicia red con errores tontos. */
  function validarArchivo(archivo) {
    if (!archivo) return 'No se ha seleccionado ningún archivo.';
    const ext = '.' + archivo.name.split('.').pop().toLowerCase();
    if (!EXT_OK.includes(ext)) return `Formato no admitido: ${ext}. Se aceptan ${EXT_OK.join(', ')}.`;
    if (archivo.size > MAX_MB * 1024 * 1024) return `El archivo supera el máximo de ${MAX_MB} MB.`;
    if (archivo.size === 0) return 'El archivo está vacío.';
    return null;
  }

  function pintarProgreso(porcentaje, texto, error = false) {
    el.progreso.hidden = false;
    el.barra.style.width = `${Math.max(0, Math.min(100, porcentaje))}%`;
    el.pct.textContent = `${Math.round(porcentaje)} %`;
    el.estado.textContent = texto;
    el.progreso.classList.toggle('es-error', error);
  }

  /**
   * Envía el archivo con XMLHttpRequest porque fetch no expone progreso
   * de subida. La respuesta llega cuando el pipeline ha terminado.
   */
  function enviarArchivo(archivo) {
    const problema = validarArchivo(archivo);
    el.zona.classList.toggle('is-error', !!problema);
    if (problema) {
      d.avisar('Archivo no válido', problema, 'error');
      return;
    }

    el.confirmacion.hidden = true;
    el.nombre.textContent = archivo.name;
    pintarProgreso(0, 'Preparando el envío…');

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload-excel');

    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) return;
      const pct = (e.loaded / e.total) * 100;
      pintarProgreso(pct, pct < 100 ? 'Transmitiendo al servidor…' : 'Limpiando y estandarizando los datos…');
    };

    xhr.onload = () => {
      let cuerpo = null;
      try { cuerpo = JSON.parse(xhr.responseText); } catch { /* respuesta no JSON */ }

      if (xhr.status >= 200 && xhr.status < 300 && cuerpo) {
        const avisos = cuerpo.avisos || [];
        pintarProgreso(100, 'Archivo procesado correctamente.');
        mostrarConfirmacion(cuerpo);
        const tipo = avisos.length ? 'alerta' : 'exito';
        d.avisar('Datos actualizados', `${cuerpo.archivo} · ${d.num(cuerpo.filas)} equipos`, tipo);
        d.anadirNotificacion(tipo, 'Datos actualizados',
          `${cuerpo.archivo}: ${d.num(cuerpo.filas)} equipos${avisos.length ? ` · ${avisos.length} aviso(s)` : ''}.`);
        d.alProcesar();
      } else {
        const msg = cuerpo?.message || `El servidor respondió ${xhr.status}.`;
        pintarProgreso(100, msg, true);
        d.avisar('No se pudo procesar el archivo', msg, 'error');
      }
      d.cargarModulo('cola', { forzar: true });   // el historial se actualiza solo
    };

    xhr.onerror = () => {
      pintarProgreso(100, 'Se perdió la conexión con el servidor.', true);
      d.avisar('Error de red', 'El archivo no ha llegado al servidor.', 'error');
    };

    const datos = new FormData();
    datos.append('file', archivo);          // campo que espera el backend
    datos.append('nombreOriginal', archivo.name);
    xhr.send(datos);
  }

  /** Confirmación con el resumen del pipeline y sus avisos (columnas eliminadas, valores raros…). */
  function mostrarConfirmacion(r) {
    el.confirmacion.hidden = false;
    el.confirmNombre.textContent = r.archivo;
    el.confirmDetalle.textContent =
      `${r.bytesLegibles} · procesado el ${d.fechaHora(r.procesadoEn)}. ${r.mensaje}`;
    el.confirmEstado.textContent = `status: ${r.status}`;
    el.confirmAvisos.innerHTML = (r.avisos || []).map((a) => `<li>${d.esc(a)}</li>`).join('');
    el.confirmAvisos.hidden = !(r.avisos || []).length;
  }

  /* ------------------------------------------------------------------------
   *  Módulo "cola": historial de cargas + datos vigentes
   * ---------------------------------------------------------------------- */

  function cargarCola() {
    return Promise.all([d.api('/uploads'), d.api('/datos/estado')])
      .then(([uploads, datos]) => ({ uploads, datos }));
  }

  function pintarCola({ uploads, datos }) {
    const cont = document.querySelector('[data-datos="cola"]');
    d.setBadge('carga', uploads.pendientes);

    const vigentes = datos.disponible
      ? `<p class="paginacion__info" style="margin-bottom:14px">
           Datos vigentes: <strong>${d.esc(datos.archivo_origen)}</strong> ·
           ${d.num(datos.filas)} equipos · procesado ${d.esc(d.fechaHora(datos.procesado_en))}
         </p>`
      : `<p class="paginacion__info" style="margin-bottom:14px">
           Todavía no hay datos procesados: los dashboards muestran datos de ejemplo.
         </p>`;

    if (!uploads.filas.length) {
      cont.innerHTML = `${vigentes}<div class="vacio"><strong>Aún no se ha subido ningún archivo</strong>
        Sube un archivo .xlsx, .xls o .csv: se limpia al recibirlo y alimenta los dashboards.</div>`;
      return;
    }

    cont.innerHTML = `
      ${vigentes}
      <div class="cola-lista">
        ${uploads.filas.map((f) => {
          const est = ESTADOS[f.status] || ESTADOS.pending_processing;
          const detalle = f.status === 'error' ? f.error
            : f.status === 'procesado' ? `${d.num(f.filas)} equipos${f.avisos?.length ? ` · ${f.avisos.length} aviso(s)` : ''}`
            : '';
          return `
          <article class="cola-item" ${f.avisos?.length ? `title="${d.esc(f.avisos.join('\n'))}"` : ''}>
            <span class="cola-item__ico">${d.icono('subir')}</span>
            <div class="cola-item__t">
              <strong>${d.esc(f.archivo)}</strong>
              <small>${d.esc(f.bytesLegibles)} · recibido ${d.esc(d.fechaHora(f.recibidoEn))}${detalle ? ` · ${d.esc(detalle)}` : ''}</small>
            </div>
            <span class="etiqueta ${est.clase}">${est.texto}</span>
          </article>`;
        }).join('')}
      </div>`;
  }

  /* ------------------------------------------------------------------------
   *  Arranque
   * ---------------------------------------------------------------------- */

  function iniciar(dependencias) {
    d = dependencias;
    const $ = (id) => document.getElementById(id);
    el = {
      zona: $('zonaSoltar'), input: $('inputExcel'),
      progreso: $('progreso'), barra: $('progresoBarra'), pct: $('progresoPct'),
      estado: $('progresoEstado'), nombre: $('progresoNombre'),
      confirmacion: $('confirmacion'), confirmNombre: $('confirmNombre'),
      confirmDetalle: $('confirmDetalle'), confirmEstado: $('confirmEstado'),
      confirmAvisos: $('confirmAvisos'),
    };

    el.zona.addEventListener('click', () => el.input.click());
    el.zona.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.input.click(); }
    });
    $('btnBuscarArchivo').addEventListener('click', (e) => {
      e.stopPropagation();
      el.input.click();
    });
    el.input.addEventListener('change', () => {
      if (el.input.files[0]) enviarArchivo(el.input.files[0]);
      el.input.value = '';   // permite volver a subir el mismo archivo
    });

    ['dragenter', 'dragover'].forEach((evt) => el.zona.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      el.zona.classList.add('is-sobre');
      pintarProgreso(0, 'Suelta el archivo para enviarlo…');
    }));

    ['dragleave', 'drop'].forEach((evt) => el.zona.addEventListener(evt, (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (evt === 'dragleave' && el.zona.contains(e.relatedTarget)) return;
      el.zona.classList.remove('is-sobre');
    }));

    el.zona.addEventListener('drop', (e) => {
      const archivo = e.dataTransfer?.files?.[0];
      if (archivo) enviarArchivo(archivo);
    });

    // El formulario nunca se envía de forma nativa: todo pasa por XHR.
    $('formCarga').addEventListener('submit', (e) => e.preventDefault());
    $('btnRefrescarCola').onclick = () => d.cargarModulo('cola', { forzar: true });
  }

  return { iniciar, cargarCola, pintarCola };
})();
