# Build Taskwarrior v3.4.2 from source (requires Rust + CMake >= 3.24)
FROM node:18-bookworm-slim AS taskwarrior-builder

ARG TASKWARRIOR_VERSION=3.4.2

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    cmake \
    curl \
    git \
    pkg-config \
    uuid-dev \
    && rm -rf /var/lib/apt/lists/*

# Install Rust toolchain (Taskwarrior requires Rust 1.64+)
RUN curl https://sh.rustup.rs -sSf | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

RUN git clone --branch "v${TASKWARRIOR_VERSION}" --depth 1 --recurse-submodules \
      https://github.com/GothenburgBitFactory/taskwarrior.git /tmp/taskwarrior \
    && cmake -S /tmp/taskwarrior -B /tmp/taskwarrior/build -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /tmp/taskwarrior/build -j "$(nproc)" \
    && DESTDIR=/tmp/taskwarrior-install cmake --install /tmp/taskwarrior/build \
    && rm -rf /tmp/taskwarrior

# Final image: Node.js runtime with Taskwarrior
FROM node:18-bookworm-slim

# Taskwarrior runtime dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    libuuid1 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=taskwarrior-builder /tmp/taskwarrior-install/ /

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
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

# Ensure entrypoint is executable
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Expose port
EXPOSE 3000

# Set environment variable for port
ENV PORT=3000

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["npm", "start"]
