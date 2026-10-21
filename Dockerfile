# Debian 13 (trixie): trae Python 3.13, necesario para numpy 2.5 / pandas 3
FROM node:24-trixie-slim

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    UPLOADS_DIR=/app/uploads \
    CLEAN_DIR=/app/data \
    PYTHON_BIN=/opt/venv/bin/python \
    SIMULATED_DELAY_MS=900

# Python para el pipeline de limpieza (en un venv propio, separado del sistema)
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY pipeline/requirements.txt pipeline/
RUN python3 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir -r pipeline/requirements.txt

COPY --chown=node:node server.js index.html app.js estilos.css ./
COPY --chown=node:node backend/ backend/
COPY --chown=node:node componentes/ componentes/
COPY --chown=node:node pipeline/pipeline.py pipeline/

RUN mkdir -p /app/uploads /app/data && chown node:node /app/uploads /app/data

USER node

EXPOSE 3000

VOLUME ["/app/uploads", "/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
