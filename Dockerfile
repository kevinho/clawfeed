FROM node:20-alpine

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

# Create data directory
RUN mkdir -p /app/data

ENV NODE_ENV=production
ENV DIGEST_PORT=8767
ENV DIGEST_HOST=0.0.0.0

EXPOSE 8767

CMD ["node", "src/server.mjs"]
