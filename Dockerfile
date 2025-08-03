FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
USER root
RUN npm ci --only=production && npm cache clean --force

# Install Chrome for both potential users
RUN npx puppeteer browsers install chrome

# Copy application code
COPY server.js ./

# Ensure Chrome is accessible by both users
RUN mkdir -p /home/node/.cache/puppeteer && \
    mkdir -p /home/pptruser/.cache/puppeteer && \
    cp -r /root/.cache/puppeteer/* /home/node/.cache/puppeteer/ 2>/dev/null || true && \
    cp -r /root/.cache/puppeteer/* /home/pptruser/.cache/puppeteer/ 2>/dev/null || true && \
    chown -R node:node /home/node/.cache/puppeteer && \
    chown -R pptruser:pptruser /home/pptruser/.cache/puppeteer && \
    chown -R pptruser:pptruser /app

# Switch to pptruser
USER pptruser

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/status', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]