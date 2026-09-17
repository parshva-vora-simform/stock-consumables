# Built from the REPO ROOT as context — the server needs shared/ and the root
# lockfile. See .dockerignore for what is kept out.

# --- builder: full workspace install, used by the migrate/seed one-shot too ---
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY shared/package.json ./shared/
COPY server/package.json ./server/
RUN pnpm install --frozen-lockfile --filter @stock/server... --filter @stock/shared

COPY shared ./shared
COPY server ./server
RUN pnpm --filter @stock/server prisma:generate
RUN pnpm --filter @stock/server build

# --- runner ---
FROM node:22-alpine AS runner
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate
WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/shared ./shared
COPY --from=builder /app/server/node_modules ./server/node_modules
COPY --from=builder /app/server/dist ./server/dist
COPY --from=builder /app/server/package.json ./server/
COPY --from=builder /app/server/prisma ./server/prisma

WORKDIR /app/server
EXPOSE 4000
CMD ["node", "dist/server/src/index.js"]
