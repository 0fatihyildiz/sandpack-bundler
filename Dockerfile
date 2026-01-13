# Build stage - FORCE REBUILD v4
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies - cache bust by changing this comment: v4-20260113
COPY package.json yarn.lock* ./
RUN yarn install --network-timeout 100000

# Copy source and build
COPY . .

# Force no cache - timestamp will change every build
RUN echo "Build timestamp: $(date +%s)" > /tmp/build-version && yarn build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Force fresh copy from builder
COPY --from=builder /app/dist ./dist
COPY server.js ./

# Install server dependencies
RUN yarn init -y && yarn add fastify@3 fastify-static@4 && yarn cache clean

# Easypanel uses PORT env variable
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
