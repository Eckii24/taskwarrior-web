# taskwarrior-web
Web Interface for Task Warrior

A simple web interface that wraps the taskwarrior CLI, allowing you to manage your tasks through a browser while maintaining full CLI syntax compatibility.

## Features

- ✅ **Simplified Backend**: Single endpoint that executes taskwarrior commands
- ✅ **Vue.js Frontend**: Modern reactive UI with CQRS architecture
- ✅ **CQRS Pattern**: Separate query (read) and command (write) services
- ✅ **Add tasks with CLI syntax**: Full support for taskwarrior's powerful command syntax
- ✅ **Edit tasks with CLI syntax**: Modify tasks using the same syntax as the command line
- ✅ **Custom report commands**: Execute any taskwarrior report command (list, next, pending, all, etc.)
- ✅ **Task management**: View, add, edit, complete, and delete tasks
- ✅ **Execute custom commands**: Advanced users can execute any taskwarrior command directly

## Architecture

### Backend (Simplified)
- **Single Endpoint**: `POST /api/task` - Accepts any taskwarrior command arguments
- **Direct CLI Execution**: Uses `execFile()` for secure command execution
- **No Business Logic**: Frontend decides what commands to execute

### Frontend (Vue.js + CQRS)
- **TaskQueryService**: Handles read operations (queries)
- **TaskCommandService**: Handles write operations (commands)
- **TaskApiClient**: Single point of communication with backend
- **Reactive UI**: Vue.js 3 Composition API

## Prerequisites

### Option 1: Docker (Recommended)
- Docker
- Docker Compose

See [Docker Setup Guide](DOCKER.md) for Docker-based installation.

### Option 2: Local Installation
- [Taskwarrior](https://taskwarrior.org/) installed on your system
- Node.js (v14 or higher)
- npm

### Installing Taskwarrior (Local Installation Only)

**Ubuntu/Debian:**
```bash
sudo apt-get install taskwarrior
```

**macOS:**
```bash
brew install task
```

**Other systems:** See [Taskwarrior installation guide](https://taskwarrior.org/download/)

## Installation

### Using Docker (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/Eckii24/taskwarrior-web.git
cd taskwarrior-web
```

2. Start with Docker Compose:
```bash
docker compose up -d
```

3. Access the application:
- Web Interface: http://localhost:3000
- Sync Server: http://localhost:8080

For more details, see the [Docker Setup Guide](DOCKER.md).

### Local Installation

1. Clone the repository:
```bash
git clone https://github.com/Eckii24/taskwarrior-web.git
cd taskwarrior-web
```

2. Install dependencies:
```bash
npm install
```

## Usage

### Docker

```bash
# Start services
docker compose up -d

# View logs
docker compose logs -f

# Stop services
docker compose down
```

### Local Installation

1. Start the server:
```bash
npm start
```

2. Open your browser and navigate to:
```
http://localhost:3000
```

## Interface Guide

### Adding Tasks

Use the "Add Task" section with full taskwarrior CLI syntax:

```
Buy milk project:groceries +shopping due:tomorrow
Write report project:work priority:H due:friday
Call dentist +phone +urgent
```

### Viewing Tasks

Select a report type to view your tasks:
- **list**: Active tasks (default)
- **next**: Most urgent tasks
- **pending**: All pending tasks
- **all**: All tasks including completed
- **completed**: Completed tasks only

Or enter any custom taskwarrior report command.

### Editing Tasks

Click the "Edit" button on any task and use CLI syntax:
- `priority:H` - Set high priority
- `project:work due:tomorrow` - Change project and due date
- `+urgent` - Add tag
- `-shopping` - Remove tag
- `New description text` - Change description

### Custom Commands

For advanced operations, use the "Execute Custom Command" section:
- `1 modify priority:H` - Modify task 1
- `2 annotate 'Important note'` - Add annotation to task 2
- `project:work done` - Mark all work tasks as done

## API Endpoint

The backend provides a single simplified endpoint:

### `POST /api/task`

Execute any taskwarrior command by passing arguments.

**Request Body:**
```json
{
  "args": "add Buy milk project:groceries +shopping"
}
```

**Response:**
```json
{
  "success": true,
  "output": "Created task 1.\n",
  "error": ""
}
```

**Examples:**

```bash
# Add a task
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: application/json" \
  -d '{"args": "add Buy milk project:groceries +shopping"}'

# List tasks (export as JSON)
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: application/json" \
  -d '{"args": "status:pending export"}'

# Modify a task
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: application/json" \
  -d '{"args": "1 modify priority:H"}'

# Mark task as done
curl -X POST http://localhost:3000/api/task \
  -H "Content-Type: application/json" \
  -d '{"args": "1 done"}'
```

## CQRS Architecture

The frontend implements Command Query Responsibility Segregation:

### Query Service (Read Operations)
```javascript
class TaskQueryService {
  async getTasks(filter) {
    // Executes: task <filter> export
    // Returns parsed JSON array of tasks
  }
}
```

### Command Service (Write Operations)
```javascript
class TaskCommandService {
  async addTask(description) { }
  async modifyTask(taskId, modifications) { }
  async completeTask(taskId) { }
  async deleteTask(taskId) { }
  async executeCustom(command) { }
}
```

### API Client
```javascript
class TaskApiClient {
  async execute(args) {
    // Calls POST /api/task with args
  }
}
```

## Technical Details

### Backend (60 lines)
- **Single Endpoint**: `POST /api/task` - executes any taskwarrior command
- **Security**: Uses `execFile()` to prevent command injection
- **No Business Logic**: Frontend controls all task operations

### Frontend (Vue.js)
- **Vue.js 3**: Reactive UI with Composition API
- **CQRS Pattern**: Separated read/write operations
- **Service Layer**: TaskQueryService, TaskCommandService, TaskApiClient
- **Responsive Design**: Works on desktop and mobile
- **CLI Syntax First**: Maintains taskwarrior's command syntax

## Configuration

The application uses your existing taskwarrior configuration (`~/.taskrc`). Any custom reports, filters, or settings defined in your taskwarrior configuration will be available in the web interface.

## Development

To modify the application:

1. **Backend**: Edit `backend/server.js`
2. **Frontend HTML**: Edit `public/index.html`
3. **Frontend JavaScript**: Edit `public/app.js`
4. **Frontend Styles**: Edit `public/styles.css`

## License

ISC

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request.
