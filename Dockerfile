FROM node:20-alpine

WORKDIR /app

# Git для клонирования (если используется), curl и python для yt-dlp
RUN apk add --no-cache git curl python3

# Устанавливаем yt-dlp как бинарник
RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && \
    chmod a+rx /usr/local/bin/yt-dlp && \
    yt-dlp --version

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY . .

EXPOSE 3123
CMD ["node", "server/server.js"]
