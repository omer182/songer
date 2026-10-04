# One image: builds the web app and the API server, then serves both from Node on port 5100.
FROM node:22-alpine AS build
WORKDIR /app
# Commit the image is built from (CI passes github.sha); shown in the app's corner and /api/health.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine
WORKDIR /app
ARG APP_VERSION=dev
ENV NODE_ENV=production PORT=5100 DATA_DIR=/data APP_VERSION=$APP_VERSION
RUN apk add --no-cache su-exec
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN sed -i 's/\r$//' /usr/local/bin/docker-entrypoint.sh && chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 5100
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:5100/api/health || exit 1
# Starts as root only to fix /data ownership, then drops to the node user (see docker-entrypoint.sh).
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "dist/server/server/index.js"]
