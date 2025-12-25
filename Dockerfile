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

# Install Node.js dependencies (disable SSL verification due to environment)
RUN npm config set strict-ssl false && \
    (npm ci || npm install) && \
    npm config set strict-ssl true

# Copy application files
COPY backend ./backend
COPY public ./public

# Create directory for taskwarrior data and configure sync server
RUN mkdir -p /root/.task && \
    echo "# Taskwarrior configuration" > /root/.taskrc && \
    echo "data.location=/root/.task" >> /root/.taskrc && \
    echo "sync.server.url=http://taskchampion-sync:8080" >> /root/.taskrc

# Expose port
EXPOSE 3000

# Set environment variable for port
ENV PORT=3000

# Start the application
CMD ["npm", "start"]
