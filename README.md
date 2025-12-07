# taskwarrior-web
Web Interface for Task Warrior

A simple web interface that wraps the taskwarrior CLI, allowing you to manage your tasks through a browser while maintaining full CLI syntax compatibility.

## Features

- ✅ **Backend that wraps taskwarrior CLI**: Directly calls the native taskwarrior executable
- ✅ **Add tasks with CLI syntax**: Full support for taskwarrior's powerful command syntax
- ✅ **Edit tasks with CLI syntax**: Modify tasks using the same syntax as the command line
- ✅ **Custom report commands**: Execute any taskwarrior report command (list, next, pending, all, etc.)
- ✅ **Task management**: View, add, edit, complete, and delete tasks
- ✅ **Execute custom commands**: Advanced users can execute any taskwarrior command directly

## Prerequisites

- [Taskwarrior](https://taskwarrior.org/) installed on your system
- Node.js (v14 or higher)
- npm

### Installing Taskwarrior

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

## API Endpoints

The backend provides the following REST API endpoints:

- `POST /api/tasks/list` - List tasks using custom report command
- `POST /api/tasks/add` - Add a new task
- `POST /api/tasks/modify` - Modify an existing task
- `POST /api/tasks/done` - Mark task as done
- `POST /api/tasks/delete` - Delete a task
- `POST /api/tasks/execute` - Execute any taskwarrior command
- `GET /api/tasks/attributes` - Get available task attributes
- `GET /api/tasks/reports` - Get available reports

## Architecture

### Backend
- **Node.js + Express**: Lightweight REST API server
- **Direct CLI Integration**: Executes taskwarrior commands using child_process
- **No Database**: Uses taskwarrior's native file-based storage

### Frontend
- **Vanilla JavaScript**: No framework dependencies
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
