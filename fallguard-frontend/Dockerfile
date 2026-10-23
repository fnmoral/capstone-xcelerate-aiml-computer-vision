# syntax=docker/dockerfile:1
# FallGuard frontend: React build served by nginx, which also forwards /api to the backend.
#
# Built from the repository root (see docker-compose.yml) so the build can read git for the
# version number (vite.config.ts); Dockerfile.dockerignore lets in only this folder and .git.
FROM node:24-alpine AS build
RUN apk add --no-cache git && git config --global --add safe.directory '*'
WORKDIR /src/fallguard-frontend
COPY fallguard-frontend/package.json fallguard-frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY .git /src/.git
COPY fallguard-frontend/ ./
RUN npm run build

FROM nginx:1.29.8-alpine
COPY fallguard-frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /src/fallguard-frontend/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
