# Stage 1: Base
# Use a lightweight Node.js image
FROM node:22-slim AS base

# Set the working directory
WORKDIR /app

# Install system dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libappindicator3-1 \
    libasound2 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libu2f-udev \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    lsb-release \
    xdg-utils \
    wget \
    --no-install-recommends && \
    rm -rf /var/lib/apt/lists/*

# Copy package.json and package-lock.json
COPY package*.json ./


# Stage 2: Development
FROM base AS development

# Install all dependencies (including devDependencies)
RUN npm install

# Copy application source code
COPY . .

# Expose the application port
EXPOSE 5002

# Run the application in development mode
CMD ["node", "index.js"]


# Stage 3: Production
FROM base AS production

# Install production dependencies only
RUN npm install --only=production

# Copy application source code
COPY . .

# Expose the application port
EXPOSE 5002

# Run the application in production mode
CMD ["node", "index.js"]
