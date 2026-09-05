FROM node:22-bookworm-slim AS build
WORKDIR /srv/game
COPY package*.json ./
COPY app/package.json app/package.json
COPY engine/package.json engine/package.json
RUN npm ci --ignore-scripts
COPY engine engine
RUN npm --prefix engine run build

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /srv/game
COPY package*.json ./
COPY app/package.json app/package.json
COPY engine/package.json engine/package.json
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build /srv/game/engine/dist engine/dist
COPY worker worker
COPY supabase/certs/prod-ca-2021.crt supabase/certs/prod-ca-2021.crt
USER node
CMD ["node", "worker/run.mjs"]
