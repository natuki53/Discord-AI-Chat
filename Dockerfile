FROM node:24-bookworm-slim AS dependencies

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:24-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules

COPY src ./src
COPY scripts ./scripts
COPY config/bot.example.yaml ./config/bot.example.yaml

RUN mkdir -p /app/data && chown -R node:node /app
USER node

CMD ["node", "src/index.js"]
