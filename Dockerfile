# Managed transcription relay (relay/). Lives at the repository root so Railway picks it up and so relay/ can import the
# prompt builders in app/. The desktop app and the site do not use it.
FROM node:22-alpine
WORKDIR /srv
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev
COPY relay/ relay/
COPY app/*.js app/
COPY app/speech/ app/speech/
# the KB sync worker (relay/kbSync/run.js) plans notes with app/ee/kbUpstream.js; these are it and the modules it
# imports outside app/*.js. relay/scripts/check-image.mjs builds this same tree and fails when an import is missing
COPY app/ee/kbUpstream.js app/ee/sync.js app/ee/
COPY app/ee/store/remote.js app/ee/store/
COPY app/store/local.js app/store/
# the shared engines import ws from their own directory; the relay's install serves them
RUN ln -s /srv/relay/node_modules /srv/app/node_modules
WORKDIR /srv/relay
ENV NODE_ENV=production
CMD ["node", "server.js"]
