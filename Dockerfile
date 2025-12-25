# Final image: Node.js runtime with taskwarrior
FROM node:18-slim

# Install taskwarrior from Ubuntu repositories
RUN apt-get update && apt-get install -y \
    taskwarrior \
    && rm -rf /var/lib/apt/lists/*

# Create working directory
WORKDIR /app

# Copy package files first for better caching
COPY package*.json ./

# Create public directory for postinstall script
RUN mkdir -p public

# Install Node.js dependencies
# Note: SSL verification is disabled during build due to sandbox/CI environment constraints
# In production environments with proper SSL certificates, remove the strict-ssl config lines
RUN npm config set strict-ssl false && \
    npm ci && \
    npm config set strict-ssl true

# Copy application files
COPY backend ./backend
COPY public ./public

# Create directory for taskwarrior data
RUN mkdir -p /root/.task

# Expose port
EXPOSE 3000

# Set environment variable for port
ENV PORT=3000

# Start the application
CMD ["npm", "start"]
