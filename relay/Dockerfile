# SplitMate relay for local testing: runs the Worker under `wrangler dev` (real workerd runtime).
# Secrets are NOT baked into the image: mount relay/.dev.vars at /app/.dev.vars at runtime.
# workerd ships glibc binaries, so use Debian slim rather than Alpine.
FROM node:24-bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY tsconfig.json wrangler.toml worker-configuration.d.ts ./
COPY src ./src
COPY migrations ./migrations
COPY scripts ./scripts

ENV WRANGLER_SEND_METRICS=false \
    CI=true

EXPOSE 8787

# --test-scheduled exposes /cdn-cgi/handler/scheduled so the cron dispatcher can be triggered by hand.
CMD ["npx", "wrangler", "dev", "--ip", "0.0.0.0", "--port", "8787", "--test-scheduled"]
