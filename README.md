# CifraControl · Dashboard

Dashboard de inventario tecnológico hecho en **vanilla JavaScript** (sin frameworks) con un backend en **Node.js puro** (sin Express ni Multer). Se ejecuta entero en **Docker**.

## Arranque rápido

```bash
docker compose up -d --build
```

- Panel: http://localhost:3000
- Salud: http://localhost:3000/api/health
- Logs: `docker compose logs -f`
- Parar: `docker compose down` (los archivos subidos se conservan)

## Requisitos

- Docker + Docker Compose (no hace falta Node.js instalado)

## Ejecutar sin Docker

```bash
node server.js
```

## Variables de entorno

| Variable | Por defecto | Descripción |
|---|---|---|
| `PORT` | `3000` | Puerto del servidor |
| `HOST` | `127.0.0.1` (`0.0.0.0` en Docker) | Interfaz de escucha |
| `UPLOADS_DIR` | `./uploads` (`/app/uploads` en Docker) | Carpeta de recepción de Excel/CSV |
| `SIMULATED_DELAY_MS` | `900` | Retardo simulado para ver los Skeleton Loaders |

## API

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/api/health` | Estado del servicio |
| GET | `/api/dashboard/metrics` | KPIs + series |
| GET | `/api/dashboard/inventario` | Activos filtrables y paginados |
| GET | `/api/dashboard/tecnologias` | Stack detectado con riesgo |
| GET | `/api/dashboard/monitoreo` | Salud de servicios |
| GET | `/api/dashboard/excepciones` | Incidencias por severidad |
| GET | `/api/uploads` | Metadatos de lo recibido |
| POST | `/api/upload-excel` | Ingesta `.xlsx` / `.xls` / `.csv` (campo `file`) |

## Subir un Excel

Desde la web (pestaña de ingesta) o por curl:

```bash
curl -F "file=@inventario.xlsx" http://localhost:3000/api/upload-excel
```

Los ficheros se guardan en el volumen `uploads_data` de Docker (no en el repositorio).

## Estructura

```
index.html          Frontend (vanilla)
app.js              Lógica del dashboard
estilos.css         Estilos
server.js           Backend Node.js (sólo módulos nativos)
Dockerfile          Imagen del servicio
docker-compose.yml  Orquestación + volumen de uploads
```

> **Nota:** los ficheros de `uploads/` contienen datos de clientes y **nunca** se versionan (están en `.gitignore` y en `.dockerignore`).
