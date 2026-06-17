# syntax=docker/dockerfile:1
# ============================================================
# Stage 1 — install production dependencies only
# ============================================================
FROM node:22-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ============================================================
# Stage 2 — runtime image
# Target platform: linux/arm/v7 (Raspberry Pi 3)
#
# NOTE: config.yaml and .env are mounted at runtime via
#       docker-compose volumes / env_file — they are NOT
#       baked into this image.
# ============================================================
FROM node:22-slim AS runtime

# Create a dedicated non-root user and group
RUN groupadd --gid 10001 appgroup \
 && useradd  --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin appuser

WORKDIR /app

# Copy production node_modules from the deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy TypeScript source (Node 22 strips types natively — no compilation needed)
COPY src/ ./src/

# Copy the healthcheck helper script
COPY scripts/healthcheck.sh /usr/local/bin/healthcheck.sh
RUN chmod +x /usr/local/bin/healthcheck.sh

ENV NODE_ENV=production \
    TZ=Asia/Jerusalem

# Minimal HEALTHCHECK — real tuning (interval/timeout/retries/start_period)
# is defined in docker-compose.yml so it can be adjusted without rebuilding.
HEALTHCHECK CMD ["/usr/local/bin/healthcheck.sh"]

USER 10001

CMD ["node", "--experimental-strip-types", "src/app.ts"]
