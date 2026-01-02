# Build stage
FROM node:18-alpine AS builder

WORKDIR /app

# Install dependencies
COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

# Copy source and build
COPY . .
RUN yarn build

# Production stage
FROM node:18-alpine AS production

WORKDIR /app

# Copy built files
COPY --from=builder /app/dist ./dist

# Install only server dependencies
RUN yarn add fastify@3 fastify-static@4 && yarn cache clean

COPY server.js ./

# Easypanel uses PORT env variable
ENV PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
