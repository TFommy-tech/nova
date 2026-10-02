FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

# Cache bust — меняй значение чтобы форсировать свежий клон
ARG CACHEBUST=2026-10-02-22-35

RUN git clone --depth 1 https://github.com/TFommy-tech/nova.git . && rm -rf .git

RUN npm install --omit=dev --no-audit --no-fund

EXPOSE 3123
CMD ["node", "server/server.js"]
