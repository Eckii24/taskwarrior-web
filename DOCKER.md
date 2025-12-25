# Docker Setup for Taskwarrior Web

This directory contains Docker configuration files to run the Taskwarrior Web Interface along with the TaskChampion Sync Server.

## What's Included

- **Taskwarrior**: Task management CLI tool (version 2.6.2)
- **TaskChampion Sync Server**: Official sync server for task synchronization
- **Taskwarrior Web Frontend**: Web interface for managing tasks

## Quick Start

### Prerequisites

- Docker
- Docker Compose (or `docker compose` command)

### Running the Services

1. Start all services:
   ```bash
   docker compose up -d
   ```

2. Access the web interface:
   - Web Frontend: http://localhost:3000
   - TaskChampion Sync Server: http://localhost:8080

3. Stop all services:
   ```bash
   docker compose down
   ```

## Services

### Taskwarrior Web Frontend
- **Port**: 3000
- **Container**: `taskwarrior-web`
- **Volume**: `taskwarrior-data` (persists task database at `/root/.task`)

### TaskChampion Sync Server
- **Port**: 8080
- **Container**: `taskchampion-sync-server`
- **Volume**: `taskchampion-data` (persists sync server data at `/var/lib/taskchampion-sync-server`)

## Data Persistence

All task data and sync server data are stored in Docker volumes:

- `taskwarrior-data`: Contains your task database
- `taskchampion-data`: Contains sync server data

These volumes persist even when containers are stopped or removed. To completely remove all data:

```bash
docker compose down -v
```

**Warning**: This will delete all your tasks and sync data!

## Viewing Logs

View logs from all services:
```bash
docker compose logs
```

View logs from a specific service:
```bash
docker compose logs taskwarrior-web
docker compose logs taskchampion-sync
```

Follow logs in real-time:
```bash
docker compose logs -f
```

## Rebuilding

If you make changes to the code, rebuild the containers:

```bash
docker compose up --build -d
```

## Customization

### Changing Ports

Edit `docker-compose.yml` and modify the port mappings:

```yaml
ports:
  - "YOUR_PORT:3000"  # For web frontend
  - "YOUR_PORT:8080"  # For sync server
```

### Volume Locations

To use host directories instead of Docker volumes, modify the volume mappings in `docker-compose.yml`:

```yaml
volumes:
  - ./your-task-data:/root/.task
  - ./your-sync-data:/var/lib/taskchampion-sync-server
```

## Troubleshooting

### Container keeps restarting

Check the logs:
```bash
docker compose logs taskwarrior-web
```

### Cannot access web interface

1. Ensure the container is running:
   ```bash
   docker compose ps
   ```

2. Check if port 3000 is already in use:
   ```bash
   lsof -i :3000  # On macOS/Linux
   netstat -ano | findstr :3000  # On Windows
   ```

### Data not persisting

Verify volumes are mounted:
```bash
docker volume ls
docker compose ps
```

## Connecting to TaskChampion Sync Server

The Taskwarrior instance is pre-configured to sync with the TaskChampion server. The sync server URL is automatically set to `http://taskchampion-sync:8080` in the container's `.taskrc` file.

To use sync functionality, you can run:
```bash
docker exec -it taskwarrior-web task sync
```

No additional manual configuration is required.

## Building from Scratch

To build the Docker image manually:

```bash
docker build -t taskwarrior-web .
```

## Architecture

- **Dockerfile**: Multi-layer build that installs Taskwarrior from Debian repositories and sets up the Node.js application
- **docker-compose.yml**: Orchestrates both the web frontend and sync server with proper networking and volumes

## Version Information

- Taskwarrior: 2.6.2 (from Debian repositories)
- TaskChampion Sync Server: Latest (from official Docker image)
- Node.js: 18 (slim variant)

## Notes

- The Dockerfile uses a simplified approach by installing Taskwarrior from the Debian package repository (version 2.6.2) rather than building from source
- **Note on Latest Version**: Taskwarrior 3.4.2 is the latest release, but building it from source in containerized environments requires complex dependencies (Rust toolchain, CMake 3.24+, cxxbridge). For production use with 3.4.2, build the Docker image in an environment with proper SSL certificates
- **Security Warning**: The Dockerfile includes `npm config set strict-ssl false` as a workaround for sandbox/CI environments. Remove this in production environments with proper SSL certificates
- The task database is stored in `/root/.task` within the container
- TaskChampion sync is pre-configured to use `http://taskchampion-sync:8080` - no manual configuration needed
- Both containers communicate over a dedicated Docker network (`taskwarrior-network`)
