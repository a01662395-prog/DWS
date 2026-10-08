FROM node:24-alpine

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0 \
    UPLOADS_DIR=/app/uploads \
    SIMULATED_DELAY_MS=900

WORKDIR /app

COPY --chown=node:node server.js index.html app.js estilos.css ./

RUN mkdir -p /app/uploads && chown node:node /app/uploads

USER node

EXPOSE 3000

VOLUME ["/app/uploads"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
