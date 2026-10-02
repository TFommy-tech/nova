FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache git

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3123
CMD ["node", "server/server.js"]
