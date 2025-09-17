FROM node:20-slim

ENV NODE_ENV=production

WORKDIR /app

# Install dependencies first to leverage Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy source files
COPY . .

# Ensure tmp directory exists for audio capture
RUN mkdir -p tmp && chown -R node:node /app

USER node

CMD ["npm", "start"]
