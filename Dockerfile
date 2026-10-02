# BUILD_VERSION: 2026-10-02-19-30
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=3123

EXPOSE 3123

CMD ["node", "server/server.js"]
