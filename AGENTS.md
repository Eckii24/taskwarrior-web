# AGENTS.md — taskwarrior-web

This file is guidance for agentic coding agents working in this repository.

## Project Overview

- Bun backend in `backend/server.js` (`Bun.serve`).
- Static Vue 3 frontend in `public/` (no bundler; served as static files).
- Jest tests live in `tests/`:
  - Backend: `tests/backend/*.test.js` (Bun Fetch harness).
  - UI: `tests/ui/*.test.js` (jsdom preload; mounts via `require('../../public/app.js')`).

## Agent Rules (Cursor/Copilot)

- No Cursor/Copilot rule files found (`.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md` absent).

## Setup

- Install: `bun install` (postinstall copies Vue to `public/vue.js`).
- Run: `bun run start` (starts `bun backend/server.js`).
- Port: `3000` by default (override via `PORT`).

## Build / Lint / Test

### Build

- No build step (static frontend, no bundler); ensure deps installed: `npm install`.

### Lint

- No linter is configured; keep changes consistent with existing style.

### Test (Bun)

- Run all tests: `bun test --preload ./tests/setup.js`
- Run one file: `bun test --preload ./tests/setup.js tests/backend/server.test.js`
- Filter by name: `bun test --preload ./tests/setup.js --test-name-pattern "filters CRUD"`
- Watch: `bun test --watch --preload ./tests/setup.js`

### Docker (optional)

- Start: `docker compose up -d`  •  Logs: `docker compose logs -f`  •  Stop: `docker compose down`

## Runtime Configuration

Backend env vars used by `backend/server.js`:
- `PORT` (default `3000`), `TASK_TIMEOUT_MS` (default `60000`).
- `TASKDATA` (default `~/.task`), `TASKRC` (default `${TASKDATA}/taskrc`).
- `SETTINGS_DB` (default `${TASKDATA}/taskwarrior-web.sqlite`).

## Code Style Guidelines

### General

- Language: plain JavaScript (no TypeScript).
- Modules:
  - Backend uses CommonJS (`require`, `module.exports`) on Bun.
  - Frontend is packaged as a UMD-style IIFE with CommonJS support
    (`public/app.js` exports when `module.exports` is available).
- Indentation: 4 spaces.
- Quotes: single quotes for strings; use template literals for interpolation.
- Semicolons: used consistently.
- Trailing commas: used in multiline object/array literals.

### Imports / Requires

- Prefer `const X = require('pkg')` at the top of the file.
- In Node backend, prefer built-ins first, then third-party, then local:
  - built-in: `path`, `os`, `util`, `child_process`, `fs/promises`.
  - Bun built-ins: `bun:sqlite`, `Bun.serve`.
  - local: project modules.

### Naming

- Classes: `PascalCase` (e.g., `TaskApiClient`, `TaskQueryService`).
- Functions/vars: `camelCase` (e.g., `ensureTaskrcExists`).
- Constants: `UPPER_SNAKE_CASE` for module-level constants (e.g., `PORT`).
- Filenames:
  - Runtime JS: `.js`.
  - Bun tests: `.test.cjs`.

### Formatting Patterns to Follow

- Prefer early-return validation blocks for request input.
- Prefer small helper functions for repeated logic (e.g., token parsing,
  positive int parsing).
- Keep API JSON responses consistent:
  - success path: `{ success: true, ... }`
  - failure path: `{ success: false, error: <message> }`

### Types / Defensive Programming (JS)

- Validate external input aggressively:
  - `req.body` may be missing or wrong type.
  - `req.params` and `req.query` arrive as strings.
- Use `typeof x === 'string'` / `Array.isArray(x)` checks.
- When coercing to numbers:
  - Use `Number(...)` then `Number.isFinite(...)` / `Number.isSafeInteger(...)`.
- Optional chaining is used (`req.body?.name`, `task?.status`).

### Error Handling

Backend (`backend/server.js`):
- Use `try/catch` around async route handlers.
- Return appropriate status codes:
  - `400` for validation errors.
  - `404` for missing resources.
  - `500` for unexpected errors.
- Return error messages with `error.message` (or `error.stderr` when proxying
  task execution failures).
- Avoid throwing raw errors into Express; send a response instead.

Frontend (`public/app.js`):
- API layer (`TaskApiClient`) converts transport failures into
  `{ success: false, error: error.message }`.
- UI methods typically show a toast on error and keep UI state consistent.

### Security / Shell Execution

- Backend executes Taskwarrior via `execFile` (not `exec`) to prevent shell
  injection. Bun provides Node-compatible `child_process` APIs.
- Keep/extend this pattern when adding new task invocations.
- When supporting string commands, tokenize safely (see `tokenizeShellArgs`).

## Testing Conventions

- Backend tests:
  - Use `request(app)` from `tests/request.js` against the Fetch router returned by `createApp({...})`.
  - Prefer injecting `execTaskOverride` to avoid depending on a real `task`
    installation.
  - Temporary directories use `fs.mkdtempSync(os.tmpdir())`.

- UI tests:
  - Use jsdom (`jest-environment-jsdom` by default).
  - Load `public/index.html` into `document.documentElement.innerHTML`.
  - Mount via `TaskwarriorWeb.mountTaskwarriorApp({ fetchImpl })`.
  - Use fake timers (`jest.useFakeTimers()`) and a small `flushPromises` helper.

## When Making Changes

- Prefer minimal, localized changes; update/add Jest tests when changing behavior.
- Don’t add new tooling (ESLint/Prettier/build pipeline) unless explicitly asked.
