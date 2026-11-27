FROM node:22-slim
ENV NODE_ENV=production PORT=8000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY bee/ bee/
COPY preview/mock-backend.js preview/
COPY supabase/functions/_shared/ supabase/functions/_shared/
COPY public/ public/
USER node
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "bee/server.js"]
