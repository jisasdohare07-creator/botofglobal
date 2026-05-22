# Use Node.js 18 slim image as the base
FROM node:18-bullseye-slim

# Create and change to the app directory
WORKDIR /app

# Install dependencies required for Puppeteer and Chromium
RUN apt-get update && apt-get install -y \
    wget \
    gnupg \
    ca-certificates \
    procps \
    libxss1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libgbm-dev \
    libasound2 \
    chromium \
    && rm -rf /var/lib/apt/lists/*

# Set Puppeteer environment variables so it uses the installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Copy application dependency manifests to the container image.
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy local code to the container image.
COPY . .

# Hugging Face Spaces specific requirement:
# Set permissions and run as the non-root 'node' user (UID 1000)
RUN chown -R node:node /app
USER node

# Hugging Face spaces use port 7860 by default
EXPOSE 7860
ENV PORT=7860

# Provide a hint to backend/bot.js not to use desktop-specific paths if needed
ENV NODE_ENV=production

# Command to run on start
CMD ["node", "backend/index.js"]


