# Sift: web server and fetcher in one (server/main.js).
FROM node:22-slim
ENV NODE_ENV=production DATA_DIR=/data
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts
COPY server/ server/
COPY fetch/ fetch/
COPY migrations/ migrations/
COPY public/ public/
USER node
HEALTHCHECK --interval=10s --timeout=5s --retries=6 --start-period=10s CMD node -e "fetch('http://127.0.0.1:8000/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "server/main.js"]
