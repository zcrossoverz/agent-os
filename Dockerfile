# AgentOS control plane + embedded runner.
# Build:  docker build -t agentos .
# Run:    see deploy/docker-compose.yml and docs/operations.md
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates openssh-client tini \
 && rm -rf /var/lib/apt/lists/*
# The unmodified Claude Code CLI, used by the embedded runner. Pin the version you have tested.
ARG CLAUDE_CODE_VERSION=2.1.327
RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force
RUN useradd --create-home --uid 1001 agentos && mkdir -p /data && chown agentos:agentos /data
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server && npm cache clean --force
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
ENV NODE_ENV=production \
    AGENTOS_DATA_DIR=/data \
    AGENTOS_HOST=0.0.0.0 \
    AGENTOS_PORT=4600
USER agentos
VOLUME ["/data"]
EXPOSE 4600
ENTRYPOINT ["/usr/bin/tini", "--", "node", "--disable-warning=ExperimentalWarning", "/app/server/dist/cli.js"]
CMD ["server", "--embedded-runner"]
