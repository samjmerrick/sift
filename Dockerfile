# The Sift runner: fetches feeds and reads articles for the app on Cloudflare (see runner/run.js).
FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --ignore-scripts || npm install --omit=dev --no-audit --no-fund
COPY runner/ runner/
USER node
CMD ["node", "runner/run.js"]
