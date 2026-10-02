# NOVA

NOVA is split into a deployable Node backend and a client that can run in a browser or inside Electron.

## Local web
`npm install` then `npm start`

## Desktop
`npm install` then `npm run desktop`

## Environment
Copy `.env.example` to `.env` and fill provider credentials as needed.

## Suga / Docker
The root `Dockerfile` exposes port 3123 and runs `node server/server.js`.
