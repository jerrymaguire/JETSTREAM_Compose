FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --omit=optional

COPY tsconfig.json ./
COPY src ./src
COPY public ./public
COPY skills ./skills
RUN npm run build && npm prune --omit=dev --offline

FROM node:24-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54 AS runtime

ENV NODE_ENV=production \
    AGENT_PORT=8080 \
    AGENT_DATA_DIR=/app/data \
    AGENT_WORKSPACE_DIR=/workspace

WORKDIR /app

COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist/src ./dist/src
COPY --from=build /app/public ./public
COPY --from=build /app/skills ./skills

RUN mkdir -p /app/data/runs /workspace \
 && chown -R node:node /app/data /workspace

USER node

EXPOSE 8080

CMD ["node", "dist/src/index.js"]
