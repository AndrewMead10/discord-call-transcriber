FROM node:22-slim

ENV NODE_ENV=production
ENV PYTHON=/usr/bin/python3

WORKDIR /app

# System dependencies for native modules
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    python3 \
    build-essential \
    pkg-config \
    libsqlite3-dev \
  && rm -rf /var/lib/apt/lists/*

# Install dependencies first to leverage Docker layer caching
COPY package*.json ./
RUN npm install --omit=dev

# Copy source files
COPY . .

# Ensure tmp directory exists for audio capture
RUN mkdir -p tmp data && chown -R node:node /app

USER node

CMD ["npm", "start"]
