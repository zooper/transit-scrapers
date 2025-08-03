FROM ghcr.io/puppeteer/puppeteer:latest

# Set working directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
USER root
RUN npm ci --only=production && npm cache clean --force

# Copy application code
COPY server.js ./

# Change ownership to pptruser (default user in Puppeteer image)
RUN chown -R pptruser:pptruser /app

# Switch to pptruser and install Chrome browser
USER pptruser
RUN npx puppeteer browsers install chrome

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/status', (res) => { process.exit(res.statusCode === 200 ? 0 : 1) })"

# Start the application
CMD ["npm", "start"]