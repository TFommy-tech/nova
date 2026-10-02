# Деплой NOVA на Suga

## 1. Подготовь проект

Распакуй архив так, чтобы внутри корня проекта были:

- `Dockerfile`
- `package.json`
- `main.js`
- `.gitignore`
- `.env.example`
- `server/server.js`
- `web/index.html`

`.env` в GitHub не загружай.

## 2. Создай GitHub-репозиторий

Создай пустой репозиторий с именем `nova`.

На GitHub нажми `Add file` → `Upload files` и перетащи **содержимое папки `nova-rebuild`**, а не саму папку целиком.

В результате `Dockerfile` должен лежать в корне репозитория, а не в `nova-rebuild/Dockerfile`.

Нажми `Commit changes`.

## 3. Создай проект в Suga

Открой Suga Dashboard → `New` / `New project` → `Import a GitHub repo`.

Выбери репозиторий `TFommy-tech/nova` и ветку `main`.

Suga поддерживает GitHub builds и Dockerfile. Для NOVA Dockerfile уже подготовлен.

## 4. Настрой порт

Для сервиса выставь публичный HTTP-порт `3123`.

В контейнере приложение читает:

`PORT=3123`

и слушает `0.0.0.0`, поэтому внешний порт Suga сможет направить в контейнер.

## 5. Environment Variables

Добавь только реальные значения, без кавычек:

`PORT=3123`

`HOST=0.0.0.0`

`PUBLIC_URL=https://ТВОЙ-ДОМЕН-SUGA`

`SPOTIFY_CLIENT_ID=...`

`SPOTIFY_CLIENT_SECRET=...`

`AUDIUS_API_KEY=...`

Если используешь Discord OAuth, добавь также:

`DISCORD_CLIENT_ID=...`

`DISCORD_CLIENT_SECRET=...`

Секреты не добавляй в GitHub и не помещай в `web/index.html`.

## 6. Deploy

Нажми `Deploy`.

Suga соберёт Dockerfile, установит production-зависимости и запустит:

`node server/server.js`

## 7. Проверка

После появления публичного URL открой:

`https://ТВОЙ-ДОМЕН-SUGA/api/health`

Должен прийти JSON с `ok: true` и версией NOVA.

После этого открой основной URL:

`https://ТВОЙ-ДОМЕН-SUGA/`

## 8. Discord OAuth

В Discord Developer Portal добавь точный callback URL опубликованного сервера:

`https://ТВОЙ-ДОМЕН-SUGA/auth/discord/callback`

URL должен совпадать с redirect URI, который использует backend.

## 9. Автодеплой

После первого успешного деплоя изменения из отслеживаемой GitHub-ветки можно публиковать через обычный `git push`. Suga поддерживает push-to-deploy.

## Важно

Suga Free сейчас предоставляет 1 проект, 1 environment, 0.1 vCPU, 256 MiB RAM и 1 GB storage. Поэтому не загружай в контейнер медиатеку или большие файлы.

NOVA хранит пользовательский фон локально в браузере/Electron, а не на сервере.
