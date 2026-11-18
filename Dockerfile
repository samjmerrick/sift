FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY . .
ENV NODE_ENV=production SIFT_DB=/data/sift.db PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["npm", "start"]
