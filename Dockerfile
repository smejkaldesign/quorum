# Managed transcription relay (relay/). Lives at the repository root so Railway picks it up and so relay/ can import the
# prompt builders in app/. The desktop app and the site do not use it.
FROM node:22-alpine
WORKDIR /srv
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev
COPY relay/ relay/
COPY app/*.js app/
COPY app/speech/ app/speech/
WORKDIR /srv/relay
ENV NODE_ENV=production
CMD ["node", "server.js"]
