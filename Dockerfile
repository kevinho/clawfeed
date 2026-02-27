# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Install build dependencies for better-sqlite3
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy source code
COPY src/ ./src/
COPY migrations/ ./migrations/
COPY templates/ ./templates/
COPY web/ ./web/

# Production stage
FROM node:20-alpine

WORKDIR /app

# Copy built artifacts from builder
COPY --from=builder /app ./

# Create data directory and set ownership
RUN mkdir -p /app/data && chown -R node:node /app

# Use non-root user
USER node

ENV NODE_ENV=production
ENV DIGEST_PORT=8767
ENV DIGEST_HOST=0.0.0.0

EXPOSE 8767

# Health check for orchestration environments
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD wget -q --spider http://localhost:8767/ || exit 1

CMD ["node", "src/server.mjs"]
