FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY public ./public

RUN mkdir -p /app/.cache /config && chown -R node:node /app /config

USER node
EXPOSE 8080
ENV PORT=8080 CLIENTS_FILE=/config/clients.json SERVICES_FILE=/config/services.json

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1

CMD ["node", "src/server.js"]
