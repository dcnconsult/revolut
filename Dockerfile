FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --include=dev

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS production

ENV NODE_ENV=production
ENV PORT=3000
ENV REVOLUT_MODE=mock

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node scripts/sandbox/droplet-accounts.mjs ./scripts/sandbox/droplet-accounts.mjs
COPY --chown=node:node scripts/sandbox/account-transfer-core.mjs ./scripts/sandbox/account-transfer-core.mjs
COPY --chown=node:node scripts/sandbox/droplet-transfer.mjs ./scripts/sandbox/droplet-transfer.mjs

USER node

EXPOSE 3000

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=4 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)throw new Error(String(r.status))}).catch(e=>{console.error(e);process.exit(1)})"]

CMD ["node", "dist/src/server.js"]
