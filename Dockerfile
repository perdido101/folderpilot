# FolderPilot — one container: API + web app + worker (see scripts/start.mjs, docs/DEPLOY.md).
FROM node:22-bookworm-slim
WORKDIR /app
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=1 PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.28.0 --activate

# Dependencies first (cached while only source changes).
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/server/package.json apps/server/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/core/package.json packages/core/
COPY packages/ai/package.json packages/ai/
COPY packages/analysis/package.json packages/analysis/
COPY packages/ui/package.json packages/ui/
COPY packages/db/package.json packages/db/
COPY packages/adapters/package.json packages/adapters/
COPY e2e/package.json e2e/
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

ENV NODE_ENV=production FP_WEB_DIST=/app/apps/web/dist PORT=3000
EXPOSE 3000
CMD ["node", "scripts/start.mjs"]
