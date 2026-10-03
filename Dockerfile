FROM node:20-alpine

WORKDIR /app

# git нужен, если какие-то пакеты тянут git-зависимости
RUN apk add --no-cache git

# Копируем манифесты и ставим зависимости (кэшируется отдельно)
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

# Копируем ВСЁ содержимое репозитория
COPY . .

EXPOSE 3123
CMD ["node", "server/server.js"]
