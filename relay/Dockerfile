# Managed transcription relay. Built from the repository root so relay/ can import the prompt builders in app/.
FROM node:22-alpine
WORKDIR /srv
COPY relay/package.json relay/package-lock.json relay/
RUN cd relay && npm ci --omit=dev
COPY relay/ relay/
COPY app/*.js app/
WORKDIR /srv/relay
ENV NODE_ENV=production
CMD ["node", "server.js"]
