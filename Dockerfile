# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock* ./
RUN yarn install

# Copy source and build - v3 cache bust
COPY . .
RUN yarn build

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
