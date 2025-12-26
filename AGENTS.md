# AGENTS.md — taskwarrior-web

This file is guidance for agentic coding agents working in this repository.

## Project Overview

- Node/Express backend in `backend/server.js`.
- Static Vue 3 frontend in `public/` (no bundler; served as static files).
- Jest tests live in `tests/`:
  - Backend: `tests/backend/*.test.cjs` (supertest; `@jest-environment node`).
  - UI: `tests/ui/*.test.cjs` (jsdom; mounts via `require('../../public/app.js')`).

## Agent Rules (Cursor/Copilot)

- No Cursor/Copilot rule files found (`.cursor/rules/`, `.cursorrules`, `.github/copilot-instructions.md` absent).

## Setup

- Install: `npm install` (postinstall copies Vue to `public/vue.js`).
- Run: `npm start` (starts `node backend/server.js`).
- Port: `3000` by default (override via `PORT`).

## Build / Lint / Test

### Build

- No build step (static frontend, no bundler); ensure deps installed: `npm install`.

### Lint

- No linter is configured; keep changes consistent with existing style.

### Test (Jest)

- Run all tests: `npm test`
- Run a single test file:
  - `npx jest tests/backend/server.test.cjs`
  - `npx jest tests/ui/app.test.cjs`
- Run a single test by name (substring match):
  - `npx jest tests/ui/app.test.cjs -t "mounts and loads initial tasks"`
  - `npx jest -t "filters CRUD"` (searches all tests)
- Watch mode during development:
  - `npx jest --watch`

Jest config: `jest.config.cjs` sets `testMatch: ['**/tests/**/*.test.cjs']`.

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
  - Backend uses CommonJS (`require`, `module.exports`).
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
  - third-party: `express`, `cors`, `better-sqlite3`.
  - local: project modules.

### Naming

- Classes: `PascalCase` (e.g., `TaskApiClient`, `TaskQueryService`).
- Functions/vars: `camelCase` (e.g., `ensureTaskrcExists`).
- Constants: `UPPER_SNAKE_CASE` for module-level constants (e.g., `PORT`).
- Filenames:
  - Runtime JS: `.js`.
  - Jest tests: `.test.cjs`.

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
  injection.
- Keep/extend this pattern when adding new task invocations.
- When supporting string commands, tokenize safely (see `tokenizeShellArgs`).

## Testing Conventions

- Backend tests:
  - Use `supertest(request(app))` on an app created by `createApp({...})`.
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
