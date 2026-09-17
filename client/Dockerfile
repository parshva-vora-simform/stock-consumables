# Built from the REPO ROOT as context — the client imports @stock/shared.

FROM node:22-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY client/package.json ./client/
RUN pnpm install --frozen-lockfile --filter @stock/client... --filter @stock/shared
COPY shared ./shared
COPY client ./client

# --- dev: Vite dev server with HMR (what docker compose up runs) ---
FROM base AS dev
WORKDIR /app/client
EXPOSE 5173
CMD ["pnpm", "dev", "--host", "0.0.0.0"]

# --- build + static serve, for a production-shaped run ---
FROM base AS builder
RUN pnpm --filter @stock/client build

FROM nginx:1.27-alpine AS runner
COPY --from=builder /app/client/dist /usr/share/nginx/html
COPY client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
