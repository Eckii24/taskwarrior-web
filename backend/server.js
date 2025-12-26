const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_TASKDATA_PATH = path.join(process.env.HOME || os.homedir(), '.task');
const DEFAULT_TASKRC_PATH = path.join(DEFAULT_TASKDATA_PATH, 'taskrc');

const TASKDATA_PATH = process.env.TASKDATA || DEFAULT_TASKDATA_PATH;
const TASKRC_PATH = process.env.TASKRC || DEFAULT_TASKRC_PATH;

const SETTINGS_DB_PATH = process.env.SETTINGS_DB || path.join(TASKDATA_PATH, 'taskwarrior-web.sqlite');

function getDefaultTaskrc() {
    return [
        '# Taskwarrior configuration',
        '# This file is managed by taskwarrior-web.',
        `data.location=${TASKDATA_PATH}`,
        '',
        '# TaskChampion sync settings (set these to enable sync)',
        '# sync.server.url=http://taskchampion-sync:8080',
        '# sync.server.client_id=your-client-id',
        '# sync.encryption_secret=your-encryption-secret',
        '',
    ].join('\n');
}

async function ensureTaskrcExists() {
    await fs.mkdir(path.dirname(TASKRC_PATH), { recursive: true });

    try {
        await fs.access(TASKRC_PATH);
    } catch {
        await fs.writeFile(TASKRC_PATH, getDefaultTaskrc(), { encoding: 'utf8' });
    }
}

async function ensureSettingsDbDirExists() {
    await fs.mkdir(path.dirname(SETTINGS_DB_PATH), { recursive: true });
}

function openSettingsDb() {
    const db = new Database(SETTINGS_DB_PATH);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS filters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filter TEXT NOT NULL,
            "order" INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_filters_order ON filters("order", id);
    `);

    return db;
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let settingsDb;

async function ensureSettingsDb() {
    if (settingsDb) return settingsDb;
    await ensureSettingsDbDirExists();
    settingsDb = openSettingsDb();
    return settingsDb;
}

// Retrieve the full taskrc as plain text
app.get('/api/taskrc', async (_req, res) => {
    try {
        await ensureTaskrcExists();
        const content = await fs.readFile(TASKRC_PATH, { encoding: 'utf8' });
        res.type('text/plain').send(content);
    } catch (error) {
        res.status(500).type('text/plain').send(error.message);
    }
});

// Overwrite the full taskrc (plain text)
app.put('/api/taskrc', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
    try {
        const content = typeof req.body === 'string' ? req.body : '';

        await fs.mkdir(path.dirname(TASKRC_PATH), { recursive: true });

        const tmpPath = `${TASKRC_PATH}.tmp`;
        await fs.writeFile(tmpPath, content, { encoding: 'utf8' });
        await fs.rename(tmpPath, TASKRC_PATH);

        res.type('text/plain').send('OK');
    } catch (error) {
        res.status(500).type('text/plain').send(error.message);
    }
});

function splitLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

const completionCache = new Map();

const TASK_EXEC_TIMEOUT_MS = (() => {
    const raw = Number(process.env.TASK_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 60000;
})();

async function execTask(argsArray) {
    await ensureTaskrcExists();

    const safeArgs = Array.isArray(argsArray) ? argsArray.slice() : [];

    // The web UI already asks for confirmation; prevent Taskwarrior from
    // blocking on interactive prompts (e.g. `task <uuid> delete`).
    if (!safeArgs.some((arg) => String(arg).startsWith('rc.confirmation='))) {
        safeArgs.unshift('rc.confirmation=off');
    }

    const { stdout, stderr } = await execFileAsync('task', safeArgs, {
        timeout: TASK_EXEC_TIMEOUT_MS,
        env: {
            ...process.env,
            TASKRC: TASKRC_PATH,
            TASKDATA: TASKDATA_PATH,
        },
    });

    return { stdout, stderr };
}

async function cachedCompletionLines(cacheKey, argsArray, ttlMs = 3000) {
    const now = Date.now();
    const existing = completionCache.get(cacheKey);
    if (existing && existing.expiresAt > now) {
        return existing.value;
    }

    const { stdout } = await execTask(argsArray);
    const value = splitLines(stdout);

    completionCache.set(cacheKey, { value, expiresAt: now + ttlMs });
    return value;
}

// Settings: custom filters
app.get('/api/filters', async (_req, res) => {
    try {
        const db = await ensureSettingsDb();
        const filters = db.prepare('SELECT id, name, filter, "order" AS "order" FROM filters ORDER BY "order" ASC, id ASC').all();
        res.json({ success: true, filters });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.post('/api/filters', async (req, res) => {
    try {
        const db = await ensureSettingsDb();
        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : '';

        if (!name) {
            return res.status(400).json({ success: false, error: 'name is required' });
        }
        if (!filter) {
            return res.status(400).json({ success: false, error: 'filter is required' });
        }

        const maxOrderRow = db.prepare('SELECT COALESCE(MAX("order"), -1) AS maxOrder FROM filters').get();
        const nextOrder = Number(maxOrderRow?.maxOrder ?? -1) + 1;

        const createdAt = new Date().toISOString();
        const stmt = db.prepare('INSERT INTO filters (name, filter, "order", created_at) VALUES (?, ?, ?, ?)');
        const info = stmt.run(name, filter, nextOrder, createdAt);

        res.json({ success: true, filter: { id: info.lastInsertRowid, name, filter, order: nextOrder } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/filters/reorder', async (req, res) => {
    try {
        const db = await ensureSettingsDb();
        const ids = Array.isArray(req.body?.ids) ? req.body.ids : [];
        const parsedIds = ids.map((val) => Number(val)).filter((val) => Number.isFinite(val));

        if (parsedIds.length !== ids.length || parsedIds.length === 0) {
            return res.status(400).json({ success: false, error: 'ids must be a non-empty array of numbers' });
        }

        const unique = new Set(parsedIds);
        if (unique.size !== parsedIds.length) {
            return res.status(400).json({ success: false, error: 'ids must be unique' });
        }

        const existingIds = db.prepare('SELECT id FROM filters').all().map((row) => row.id);
        const existingSet = new Set(existingIds);
        for (const id of parsedIds) {
            if (!existingSet.has(id)) {
                return res.status(404).json({ success: false, error: `filter not found: ${id}` });
            }
        }

        const run = db.transaction(() => {
            const stmt = db.prepare('UPDATE filters SET "order" = ? WHERE id = ?');
            parsedIds.forEach((id, index) => {
                stmt.run(index, id);
            });
        });

        run();
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.put('/api/filters/:id', async (req, res) => {
    try {
        const db = await ensureSettingsDb();
        const idRaw = String(req.params.id || '');
        if (!/^\d+$/.test(idRaw)) {
            return res.status(400).json({ success: false, error: 'invalid id' });
        }
        const id = Number(idRaw);

        const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
        const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : '';
        const orderValue = req.body?.order;
        const hasOrder = orderValue !== undefined;
        const parsedOrder = hasOrder ? Number(orderValue) : null;

        if (name !== undefined && typeof req.body?.name === 'string' && name.length === 0) {
            return res.status(400).json({ success: false, error: 'name must not be empty' });
        }
        if (filter !== undefined && typeof req.body?.filter === 'string' && filter.length === 0) {
            return res.status(400).json({ success: false, error: 'filter must not be empty' });
        }
        if (hasOrder && !Number.isFinite(parsedOrder)) {
            return res.status(400).json({ success: false, error: 'order must be a number' });
        }

        const existing = db.prepare('SELECT id, name, filter, "order" AS "order" FROM filters WHERE id = ?').get(id);
        if (!existing) {
            return res.status(404).json({ success: false, error: 'filter not found' });
        }

        const nextName = name || existing.name;
        const nextFilter = filter || existing.filter;
        const nextOrder = hasOrder ? parsedOrder : existing.order;

        db.prepare('UPDATE filters SET name = ?, filter = ?, "order" = ? WHERE id = ?').run(nextName, nextFilter, nextOrder, id);

        res.json({ success: true, filter: { id, name: nextName, filter: nextFilter, order: nextOrder } });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

app.delete('/api/filters/:id', async (req, res) => {
    try {
        const db = await ensureSettingsDb();
        const idRaw = String(req.params.id || '');
        if (!/^\d+$/.test(idRaw)) {
            return res.status(400).json({ success: false, error: 'invalid id' });
        }
        const id = Number(idRaw);

        const info = db.prepare('DELETE FROM filters WHERE id = ?').run(id);
        if (info.changes === 0) {
            return res.status(404).json({ success: false, error: 'filter not found' });
        }

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Lightweight completion endpoint.
// Accepts the current token under cursor (e.g. "proj:", "project:ho", "+ur", "rc.co").
app.get('/api/complete', async (req, res) => {
    try {
        const token = typeof req.query.token === 'string' ? req.query.token : '';
        const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 20));

        const staticStatuses = ['pending', 'completed', 'deleted', 'waiting'];

        const abbrevLines = await cachedCompletionLines('abbreviation.minimum', ['rc.hooks=0', '_get', 'rc.abbreviation.minimum'], 15000);
        const abbrevMinParsed = Number(abbrevLines[0]);
        const abbrevMin = Number.isFinite(abbrevMinParsed) && abbrevMinParsed >= 1 ? abbrevMinParsed : 2;

        const rcToken = token.startsWith('rc.') ? token : '';

        let suggestions = [];

        const projectMatch = token.match(/^(pro|proj|proje|projec|project):(.*)$/);
        if (projectMatch) {
            const enteredValue = projectMatch[2] || '';
            const typedAttr = projectMatch[1];

            if (typedAttr.length < abbrevMin && typedAttr !== 'project') {
                suggestions = [];
            } else {
                const projects = await cachedCompletionLines('projects', ['rc.hooks=0', '_projects']);
                suggestions = projects
                    .filter((value) => value.startsWith(enteredValue))
                    .map((value) => `project:${value}`);
            }
        }

        const statusMatch = token.match(/^status:(.*)$/);
        if (suggestions.length === 0 && statusMatch) {
            const enteredValue = statusMatch[1] || '';
            suggestions = staticStatuses
                .filter((value) => value.startsWith(enteredValue))
                .map((value) => `status:${value}`);
        }

        const priorityMatch = token.match(/^(pri|prior|priori|priorit|priority):(.*)$/);
        if (suggestions.length === 0 && priorityMatch) {
            const enteredValue = priorityMatch[2] || '';
            const typedAttr = priorityMatch[1];

            if (typedAttr.length >= abbrevMin || typedAttr === 'priority') {
                const priorities = ['H', 'M', 'L'];
                suggestions = priorities
                    .filter((value) => value.startsWith(enteredValue.toUpperCase()))
                    .map((value) => `priority:${value}`);
            }
        }

        const dateKeywords = ['today', 'tomorrow', 'eom', 'eoy', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
        const dateValueAttrs = ['due', 'wait', 'until', 'scheduled', 'start', 'end'];

        const isAttrAbbrev = (typedRaw, fullRaw) => {
            const typed = String(typedRaw || '').toLowerCase();
            const full = String(fullRaw || '').toLowerCase();
            if (!typed) return false;
            if (typed === full) return true;
            return typed.length >= abbrevMin && full.startsWith(typed);
        };

        // Date-like completions (e.g. `due:to` -> `due:tomorrow`).
        const attrValueMatch = token.match(/^([a-zA-Z_.]+):(.*)$/);
        if (suggestions.length === 0 && attrValueMatch) {
            const typedAttr = attrValueMatch[1];
            const enteredValueRaw = attrValueMatch[2] || '';
            const enteredValue = enteredValueRaw.toLowerCase();

            const resolvedAttr = dateValueAttrs.find((attr) => isAttrAbbrev(typedAttr, attr));
            if (resolvedAttr) {
                suggestions = dateKeywords
                    .filter((value) => value.startsWith(enteredValue))
                    .map((value) => `${resolvedAttr}:${value}`);
            }
        }

        const tagMatch = token.match(/^([+-])(.*)$/);
        if (suggestions.length === 0 && tagMatch) {
            const sign = tagMatch[1];
            const enteredValue = tagMatch[2] || '';
            const tags = await cachedCompletionLines('tags', ['rc.hooks=0', '_tags']);
            suggestions = tags
                .filter((value) => value.toLowerCase().startsWith(enteredValue.toLowerCase()))
                .map((value) => `${sign}${value}`);
        }

        const rcColonToken = token === 'rc:' ? token : '';
        if (suggestions.length === 0 && (rcToken || rcColonToken)) {
            const enteredValue = rcToken ? rcToken.slice('rc.'.length) : '';
            const configKeys = await cachedCompletionLines('config', ['rc.hooks=0', '_config'], 15000);
            const candidates = configKeys
                .filter((value) => value.startsWith(enteredValue))
                .map((value) => `rc.${value}:`);
            suggestions = candidates;
        }

        if (suggestions.length === 0) {
            const cols = await cachedCompletionLines('columns', ['rc.hooks=0', '_columns'], 15000);
            const normalized = token.replace(/[^a-zA-Z_.]/g, '');
            const prefix = normalized.length > 0 ? normalized : '';

            const candidates = cols
                .filter((value) => value.startsWith(prefix))
                .map((value) => `${value}:`);

            if ('rc'.startsWith(prefix)) {
                candidates.unshift('rc.');
            }

            suggestions = candidates;
        }

        // If we still have no suggestions (e.g. token is a word without a ':'),
        // offer commands and aliases to support report/custom command inputs.
        if (suggestions.length === 0) {
            const commands = await cachedCompletionLines('commands', ['rc.hooks=0', '_commands'], 15000);
            const aliases = await cachedCompletionLines('aliases', ['rc.hooks=0', '_aliases'], 15000);

            const prefix = token.trim();
            const candidates = [...commands, ...aliases]
                .filter((value) => value.startsWith(prefix));

            suggestions = candidates;
        }

        if (suggestions.length === 0 && /^\d+$/.test(token.trim())) {
            const ids = await cachedCompletionLines('ids', ['rc.hooks=0', '_ids'], 2000);
            suggestions = ids;
        }

        suggestions = suggestions.slice(0, limit);

        const values = suggestions.map((suggestion) => {
            const statusValue = suggestion.match(/^status:(.+)$/);
            if (statusValue) return statusValue[1];

            const priorityValue = suggestion.match(/^priority:(.+)$/);
            if (priorityValue) return priorityValue[1];

            const projectValue = suggestion.match(/^project:(.+)$/);
            if (projectValue) return projectValue[1];

            return suggestion;
        });

        res.json({
            success: true,
            token,
            suggestions,
            values,
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.stderr || error.message,
        });
    }
});

// Single endpoint to execute taskwarrior commands
app.post('/api/task', async (req, res) => {
    try {
        const { args } = req.body;

        if (!args || (!Array.isArray(args) && typeof args !== 'string')) {
            return res.status(400).json({
                success: false,
                error: 'args parameter is required (array or string)'
            });
        }

         const tokenizeArgs = (text) => {
             const src = String(text || '');
             const tokens = [];
             let current = '';
             let quote = null;
             let escaping = false;

             for (let i = 0; i < src.length; i++) {
                 const ch = src[i];

                 if (escaping) {
                     current += ch;
                     escaping = false;
                     continue;
                 }

                 if (ch === '\\') {
                     escaping = true;
                     continue;
                 }

                 if (quote) {
                     if (ch === quote) {
                         quote = null;
                     } else {
                         current += ch;
                     }
                     continue;
                 }

                 if (ch === '"' || ch === "'") {
                     quote = ch;
                     continue;
                 }

                 if (/\s/.test(ch)) {
                     if (current.length > 0) {
                         tokens.push(current);
                         current = '';
                     }
                     continue;
                 }

                 current += ch;
             }

             if (escaping) {
                 current += '\\';
             }

             if (current.length > 0) {
                 tokens.push(current);
             }

             return tokens;
         };

         // Convert args to array if it's a string
         let argsArray;
         if (Array.isArray(args)) {
             argsArray = args;
         } else {
             argsArray = tokenizeArgs(args);
         }

        // Execute taskwarrior command using execFile for security
        const { stdout, stderr } = await execTask(argsArray);

        res.json({
            success: true,
            output: stdout,
            error: stderr
        });
    } catch (error) {
        res.json({
            success: false,
            output: error.stdout || '',
            error: error.stderr || error.message
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Taskwarrior Web Server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
    console.log(`TASKRC: ${TASKRC_PATH}`);
});
