const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const Database = require('better-sqlite3');

const execFileAsync = promisify(execFile);
const PORT = process.env.PORT || 3000;

const HOME_DIR = process.env.HOME || os.homedir();

// Taskwarrior defaults:
// - config: ~/.taskrc
// - data: ~/.task
const DEFAULT_TASKDATA_PATH = path.join(HOME_DIR, '.task');
const DEFAULT_TASKRC_PATH = path.join(HOME_DIR, '.taskrc');

const TASKDATA_PATH_DEFAULT = process.env.TASKDATA || DEFAULT_TASKDATA_PATH;
const TASKRC_PATH_DEFAULT = process.env.TASKRC || DEFAULT_TASKRC_PATH;

const SETTINGS_DB_PATH_DEFAULT = process.env.SETTINGS_DB || path.join(TASKDATA_PATH_DEFAULT, 'taskwarrior-web.sqlite');

const TASK_EXEC_TIMEOUT_MS = (() => {
    const raw = Number(process.env.TASK_TIMEOUT_MS);
    if (Number.isFinite(raw) && raw > 0) return raw;
    return 60000;
})();

function tokenizeShellArgs(text) {
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
}

function getDefaultTaskrc(taskdataPath) {
    return [
        '# Taskwarrior configuration',
        '# This file is managed by taskwarrior-web.',
        `data.location=${taskdataPath}`,
        '',
        '# Default reports used by taskwarrior-web',
        'report.next.description=Next (pending, page limited)',
        'report.next.filter=status:pending limit:page',
        '',
        'report.inbox.description=Inbox (pending tasks without project)',
        'report.inbox.filter=status:pending project:',
        '',
        'report.today.description=Today (pending, due today)',
        'report.today.filter=due:today status:pending',
        '',
        'report.all.description=All tasks',
        'report.all.filter=',
        '',
        '# TaskChampion sync settings (set these to enable sync)',
        '# sync.server.url=http://taskchampion-sync:8080',
        '# sync.server.client_id=your-client-id',
        '# sync.encryption_secret=your-encryption-secret',
        '',
    ].join('\n');
}

async function ensureTaskrcExists(taskrcPath, taskdataPath) {
    await fs.mkdir(path.dirname(taskrcPath), { recursive: true });

    try {
        await fs.access(taskrcPath);
    } catch {
        await fs.writeFile(taskrcPath, getDefaultTaskrc(taskdataPath), { encoding: 'utf8' });
    }
}

async function ensureSettingsDbDirExists(settingsDbPath) {
    await fs.mkdir(path.dirname(settingsDbPath), { recursive: true });
}

function ensureSqliteColumnExists(db, table, column, columnDefSql) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all();
    const exists = columns.some((col) => String(col?.name || '') === column);
    if (exists) return;

    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefSql}`);
}

function openSettingsDb(settingsDbPath) {
    const db = new Database(settingsDbPath);
    db.pragma('journal_mode = WAL');

    db.exec(`
        CREATE TABLE IF NOT EXISTS filters (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            filter TEXT NOT NULL,
            icon TEXT,
            "order" INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_filters_order ON filters("order", id);

        CREATE TABLE IF NOT EXISTS builtin_filters (
            key TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            filter TEXT NOT NULL,
            visible INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS app_settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
    `);

    // Lightweight migrations for existing installs.
    ensureSqliteColumnExists(db, 'filters', 'icon', 'icon TEXT');
    ensureSqliteColumnExists(db, 'filters', 'group_by', 'group_by TEXT');
    ensureSqliteColumnExists(db, 'builtin_filters', 'group_by', 'group_by TEXT');

    const now = new Date().toISOString();
    const seedBuiltin = db.prepare(`
        INSERT INTO builtin_filters (key, name, filter, visible, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(key) DO NOTHING
    `);

    seedBuiltin.run('today', 'Today', 'due:today status:pending', 1, now, now);
    seedBuiltin.run('inbox', 'Inbox', 'status:pending project:', 1, now, now);
    seedBuiltin.run('next', 'Next', 'status:pending limit:page', 1, now, now);
    seedBuiltin.run('all', 'All', '', 1, now, now);

    return db;
}

function createApp({
    taskdataPath = TASKDATA_PATH_DEFAULT,
    taskrcPath = TASKRC_PATH_DEFAULT,
    settingsDbPath = SETTINGS_DB_PATH_DEFAULT,
    execTaskOverride,
} = {}) {
    const app = express();

    // Middleware
    app.use(cors());
    app.use(express.json());
    app.use(express.static(path.join(__dirname, '../public')));

    let settingsDb;

     async function ensureSettingsDb() {
         if (settingsDb) return settingsDb;
         await ensureSettingsDbDirExists(settingsDbPath);
         settingsDb = openSettingsDb(settingsDbPath);
         return settingsDb;
     }

     // kept for backward compatibility; settings are now in taskrc/reports
     function settingsApiDisabled() {
         return {
             success: false,
             error: 'settings API removed; configure Taskwarrior directly',
         };
     }


    async function execTask(argsArray) {
        await ensureTaskrcExists(taskrcPath, taskdataPath);

        const safeArgs = Array.isArray(argsArray) ? argsArray.slice() : [];

        if (!safeArgs.some((arg) => String(arg).startsWith('rc.confirmation='))) {
            safeArgs.unshift('rc.confirmation=off');
        }

        if (typeof execTaskOverride === 'function') {
            return await execTaskOverride(safeArgs);
        }

        const { stdout, stderr } = await execFileAsync('task', safeArgs, {
            timeout: TASK_EXEC_TIMEOUT_MS,
            env: {
                ...process.env,
                TASKRC: taskrcPath,
                TASKDATA: taskdataPath,
            },
        });

        return { stdout, stderr };
    }

    // Retrieve the full taskrc as plain text
    app.get('/api/taskrc', async (_req, res) => {
        try {
            await ensureTaskrcExists(taskrcPath, taskdataPath);
            const content = await fs.readFile(taskrcPath, { encoding: 'utf8' });
            res.set('Cache-Control', 'no-store');
            res.type('text/plain').send(content);
        } catch (error) {
            res.status(500).type('text/plain').send(error.message);
        }
    });

    // Overwrite the full taskrc (plain text)
    app.put('/api/taskrc', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
        try {
            const content = typeof req.body === 'string' ? req.body : '';

            await fs.mkdir(path.dirname(taskrcPath), { recursive: true });

            const tmpPath = `${taskrcPath}.tmp`;
            await fs.writeFile(tmpPath, content, { encoding: 'utf8' });
            await fs.rename(tmpPath, taskrcPath);

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

    function parseReportNamesFromConfigLines(lines) {
        const list = Array.isArray(lines) ? lines : [];
        const names = new Set();

        for (const rawLine of list) {
            const line = String(rawLine || '').trim();
            if (!line.startsWith('report.')) continue;

            // Taskwarrior's `_config` output differs across versions:
            // - some print `report.<name>.<field>=...`
            // - others print `report.<name>.<field>`
            // We accept both so report discovery works reliably.
            const match = line.match(/^report\.([^.]+)\.[^=]+(?:=|$)/);
            if (!match) continue;

            const name = String(match[1] || '').trim();
            if (!name) continue;
            names.add(name);
        }

        return Array.from(names).sort((a, b) => a.localeCompare(b));
    }

    const completionCache = new Map();

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

    function parsePositiveIntParam(rawValue) {
        const raw = String(rawValue || '');
        if (!/^\d+$/.test(raw)) return null;
        const numberValue = Number(raw);
        if (!Number.isSafeInteger(numberValue)) return null;
        return numberValue;
    }

    const STATIC_STATUSES = ['pending', 'completed', 'deleted', 'waiting'];
    const DATE_KEYWORDS = ['today', 'tomorrow', 'eom', 'eoy', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
    const DATE_VALUE_ATTRS = ['due', 'wait', 'until', 'scheduled', 'start', 'end'];

    async function getAbbreviationMinimum() {
        const abbrevLines = await cachedCompletionLines('abbreviation.minimum', ['rc.hooks=0', '_get', 'rc.abbreviation.minimum'], 15000);
        const abbrevMinParsed = Number(abbrevLines[0]);
        if (Number.isFinite(abbrevMinParsed) && abbrevMinParsed >= 1) return abbrevMinParsed;
        return 2;
    }

    function createAttrAbbrevChecker(abbrevMin) {
        return (typedRaw, fullRaw) => {
            const typed = String(typedRaw || '').toLowerCase();
            const full = String(fullRaw || '').toLowerCase();
            if (!typed) return false;
            if (typed === full) return true;
            return typed.length >= abbrevMin && full.startsWith(typed);
        };
    }

    async function getCompletionSuggestions(token) {
        const abbrevMin = await getAbbreviationMinimum();
        const isAttrAbbrev = createAttrAbbrevChecker(abbrevMin);

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
            suggestions = STATIC_STATUSES
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

        const attrValueMatch = token.match(/^([a-zA-Z_.]+):(.*)$/);
        if (suggestions.length === 0 && attrValueMatch) {
            const typedAttr = attrValueMatch[1];
            const enteredValueRaw = attrValueMatch[2] || '';
            const enteredValue = enteredValueRaw.toLowerCase();

            const resolvedAttr = DATE_VALUE_ATTRS.find((attr) => isAttrAbbrev(typedAttr, attr));
            if (resolvedAttr) {
                suggestions = DATE_KEYWORDS
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

        const rcToken = token.startsWith('rc.') ? token : '';
        const rcColonToken = token === 'rc:' ? token : '';
        if (suggestions.length === 0 && (rcToken || rcColonToken)) {
            const enteredValue = rcToken ? rcToken.slice('rc.'.length) : '';
            const configKeys = await cachedCompletionLines('config', ['rc.hooks=0', '_config'], 15000);
            suggestions = configKeys
                .filter((value) => value.startsWith(enteredValue))
                .map((value) => `rc.${value}:`);
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

        if (suggestions.length === 0) {
            const commands = await cachedCompletionLines('commands', ['rc.hooks=0', '_commands'], 15000);
            const aliases = await cachedCompletionLines('aliases', ['rc.hooks=0', '_aliases'], 15000);

            const prefix = token.trim();
            suggestions = [...commands, ...aliases]
                .filter((value) => value.startsWith(prefix));
        }

        if (suggestions.length === 0 && /^\d+$/.test(token.trim())) {
            suggestions = await cachedCompletionLines('ids', ['rc.hooks=0', '_ids'], 2000);
        }

        return suggestions;
    }

    function completionValuesFromSuggestions(suggestions) {
        return suggestions.map((suggestion) => {
            const statusValue = suggestion.match(/^status:(.+)$/);
            if (statusValue) return statusValue[1];

            const priorityValue = suggestion.match(/^priority:(.+)$/);
            if (priorityValue) return priorityValue[1];

            const projectValue = suggestion.match(/^project:(.+)$/);
            if (projectValue) return projectValue[1];

            return suggestion;
        });
    }

     // Settings: app-level preferences (stored in settings DB).
     app.get('/api/settings', async (_req, res) => {
         try {
             const db = await ensureSettingsDb();
             const rows = db.prepare('SELECT key, value FROM app_settings').all();
             const settings = {};
             for (const entry of rows) {
                 if (!entry?.key) continue;
                 settings[String(entry.key)] = entry.value;
             }

             const rescheduleField = String(settings.reschedule_field || 'due').trim() || 'due';
             res.json({
                 success: true,
                 settings: {
                     reschedule_field: rescheduleField,
                 },
             });
         } catch (error) {
             res.status(500).json({ success: false, error: error.message });
         }
     });

     app.put('/api/settings', async (req, res) => {
         try {
             const db = await ensureSettingsDb();
             const rescheduleFieldRaw = req.body?.reschedule_field;
             const rescheduleField = typeof rescheduleFieldRaw === 'string' ? String(rescheduleFieldRaw).trim() : '';
             if (!rescheduleField) {
                 return res.status(400).json({ success: false, error: 'reschedule_field must not be empty' });
             }

             db.prepare('INSERT INTO app_settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
                 .run('reschedule_field', rescheduleField);

             res.json({
                 success: true,
                 settings: {
                     reschedule_field: rescheduleField,
                 },
             });
         } catch (error) {
             res.status(500).json({ success: false, error: error.message });
         }
     });


     // Settings: custom filters
     app.get('/api/filters', async (_req, res) => {
        try {
            const db = await ensureSettingsDb();
            const filters = db.prepare('SELECT id, name, filter, icon, "order" AS "order", group_by FROM filters ORDER BY "order" ASC, id ASC').all();
            res.json({ success: true, filters });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // Settings: built-in filters (Next/All/Today)
    app.get('/api/builtin-filters', async (_req, res) => {
        try {
            const db = await ensureSettingsDb();
            const filters = db.prepare('SELECT key, name, filter, visible, group_by FROM builtin_filters ORDER BY key ASC').all();
            res.json({ success: true, filters });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.put('/api/builtin-filters/:key', async (req, res) => {
        try {
            const db = await ensureSettingsDb();
            const key = String(req.params.key || '').trim();
            if (!key) {
                return res.status(400).json({ success: false, error: 'key is required' });
            }

            const existing = db.prepare('SELECT key, name, filter, visible, group_by FROM builtin_filters WHERE key = ?').get(key);
            if (!existing) {
                return res.status(404).json({ success: false, error: 'builtin filter not found' });
            }

            const hasName = typeof req.body?.name === 'string';
            const hasFilter = typeof req.body?.filter === 'string';
            const hasVisible = req.body?.visible !== undefined;
            const hasGroupBy = typeof req.body?.group_by === 'string';

            const name = hasName ? String(req.body.name).trim() : existing.name;
            const filter = hasFilter ? String(req.body.filter).trim() : existing.filter;
            const groupBy = hasGroupBy ? (String(req.body.group_by).trim() || null) : existing.group_by;

            let visible = existing.visible;
            if (hasVisible) {
                const rawVisible = req.body.visible;
                visible = rawVisible ? 1 : 0;
            }

            if (hasName && !name) {
                return res.status(400).json({ success: false, error: 'name must not be empty' });
            }
            if (hasFilter && filter === '') {
                // Allow empty string filters (e.g. All)
            }

            const updatedAt = new Date().toISOString();
            db.prepare('UPDATE builtin_filters SET name = ?, filter = ?, visible = ?, group_by = ?, updated_at = ? WHERE key = ?')
                .run(name, filter, visible, groupBy, updatedAt, key);

            res.json({ success: true, filter: { key, name, filter, visible, group_by: groupBy } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

        app.post('/api/filters', async (req, res) => {
        try {
            const db = await ensureSettingsDb();
            const name = typeof req.body?.name === 'string' ? req.body.name.trim() : '';
            const filter = typeof req.body?.filter === 'string' ? req.body.filter.trim() : '';

            let icon = null;
            if (req.body?.icon !== undefined && req.body?.icon !== null) {
                if (typeof req.body.icon !== 'string') {
                    return res.status(400).json({ success: false, error: 'icon must be a string' });
                }
                icon = req.body.icon.trim();
                if (!icon) icon = null;
                if (icon && icon.length > 16) {
                    return res.status(400).json({ success: false, error: 'icon is too long' });
                }
            }

            const groupBy = typeof req.body?.group_by === 'string' ? (req.body.group_by.trim() || null) : null;

            if (!name) {
                return res.status(400).json({ success: false, error: 'name is required' });
            }
            if (!filter) {
                return res.status(400).json({ success: false, error: 'filter is required' });
            }

            const maxOrderRow = db.prepare('SELECT COALESCE(MAX("order"), -1) AS maxOrder FROM filters').get();
            const nextOrder = Number(maxOrderRow?.maxOrder ?? -1) + 1;

            const createdAt = new Date().toISOString();
            const stmt = db.prepare('INSERT INTO filters (name, filter, icon, "order", group_by, created_at) VALUES (?, ?, ?, ?, ?, ?)');
            const info = stmt.run(name, filter, icon, nextOrder, groupBy, createdAt);

            res.json({ success: true, filter: { id: info.lastInsertRowid, name, filter, icon, order: nextOrder, group_by: groupBy } });
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
            const id = parsePositiveIntParam(req.params.id);
            if (id === null) {
                return res.status(400).json({ success: false, error: 'invalid id' });
            }

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

            const existing = db.prepare('SELECT id, name, filter, icon, "order" AS "order", group_by FROM filters WHERE id = ?').get(id);
            if (!existing) {
                return res.status(404).json({ success: false, error: 'filter not found' });
            }

            const hasIcon = req.body?.icon !== undefined;
            let icon = existing.icon;
            if (hasIcon) {
                if (req.body.icon === null) {
                    icon = null;
                } else if (typeof req.body.icon !== 'string') {
                    return res.status(400).json({ success: false, error: 'icon must be a string' });
                } else {
                    const trimmed = req.body.icon.trim();
                    icon = trimmed ? trimmed : null;
                    if (icon && icon.length > 16) {
                        return res.status(400).json({ success: false, error: 'icon is too long' });
                    }
                }
            }

            const hasGroupBy = typeof req.body?.group_by === 'string';
            const groupBy = hasGroupBy ? (req.body.group_by.trim() || null) : existing.group_by;

            const nextName = name || existing.name;
            const nextFilter = filter || existing.filter;
            const nextOrder = hasOrder ? parsedOrder : existing.order;

            db.prepare('UPDATE filters SET name = ?, filter = ?, icon = ?, "order" = ?, group_by = ? WHERE id = ?').run(nextName, nextFilter, icon, nextOrder, groupBy, id);

            res.json({ success: true, filter: { id, name: nextName, filter: nextFilter, icon, order: nextOrder, group_by: groupBy } });
        } catch (error) {
            res.status(500).json({ success: false, error: error.message });
        }
    });

    app.delete('/api/filters/:id', async (req, res) => {
        try {
            const db = await ensureSettingsDb();
            const id = parsePositiveIntParam(req.params.id);
            if (id === null) {
                return res.status(400).json({ success: false, error: 'invalid id' });
            }

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

            let suggestions = await getCompletionSuggestions(token);
            suggestions = suggestions.slice(0, limit);

            res.json({
                success: true,
                token,
                suggestions,
                values: completionValuesFromSuggestions(suggestions),
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                error: error.stderr || error.message,
            });
        }
    });

    app.get('/api/reports', async (_req, res) => {
        try {
            const lines = await cachedCompletionLines('reports', ['rc.hooks=0', '_config'], 15000);
            const reports = parseReportNamesFromConfigLines(lines);
            res.json({ success: true, reports });
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
            const { args, annotation } = req.body;

            if (!args || (!Array.isArray(args) && typeof args !== 'string')) {
                return res.status(400).json({
                    success: false,
                    error: 'args parameter is required (array or string)',
                });
            }

            const argsArray = Array.isArray(args) ? args : tokenizeShellArgs(args);

            // Execute taskwarrior command using execFile for security
            const { stdout, stderr } = await execTask(argsArray);

            // If annotation is provided and this is an 'add' command, annotate the newly created task
            if (annotation && typeof annotation === 'string' && annotation.trim()) {
                const annotationText = annotation.trim();
                
                // Check if this is an 'add' command (first non-rc arg should be 'add')
                const firstNonRcArg = argsArray.find(arg => !String(arg).startsWith('rc.'));
                const isAddCommand = firstNonRcArg === 'add';
                
                if (isAddCommand) {
                    // Extract the task ID from stdout (taskwarrior outputs "Created task <id>.")
                    const match = stdout.match(/Created task (\d+)\./);
                    if (match) {
                        const taskId = match[1];
                        
                        // Add annotation to the newly created task
                        // Use single quotes and escape any embedded single quotes
                        const escapedAnnotation = annotationText.replace(/'/g, "\\'");
                        const annotateArgs = [taskId, 'annotate', `'${escapedAnnotation}'`];
                        
                        try {
                            await execTask(annotateArgs);
                        } catch (annotateError) {
                            // If annotation fails, we still return success for task creation
                            // but include a warning in stderr
                            const warningMsg = `Task created but annotation failed: ${annotateError.message}`;
                            return res.json({
                                success: true,
                                output: stdout,
                                error: stderr ? `${stderr}\n${warningMsg}` : warningMsg,
                            });
                        }
                    }
                }
            }

            res.json({
                success: true,
                output: stdout,
                error: stderr,
            });
        } catch (error) {
            res.json({
                success: false,
                output: error.stdout || '',
                error: error.stderr || error.message,
            });
        }
    });

    return app;
}

if (require.main === module) {
    const app = createApp();
    app.listen(PORT, () => {
        console.log(`Taskwarrior Web Server running on port ${PORT}`);
        console.log(`Frontend: http://localhost:${PORT}`);
        console.log(`API: http://localhost:${PORT}/api`);
        console.log(`TASKRC: ${TASKRC_PATH_DEFAULT}`);
    });
}

module.exports = {
    createApp,
};
