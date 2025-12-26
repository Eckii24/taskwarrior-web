const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');
const Database = require('better-sqlite3');
const { parse: parseArgs } = require('shell-quote');

// Import custom modules
const { loadConfig } = require('./config');
const { schemas, validateBody, validateQuery, validateTaskArgs } = require('./validation');
const { createLogger, requestLogger, errorLogger } = require('./logger');
const { AppError, errorHandler, asyncHandler, notFoundHandler } = require('./errorHandler');

// Load and validate configuration
const config = loadConfig();

// Initialize logger
const logger = createLogger(config.LOG_LEVEL);

const execFileAsync = promisify(execFile);
const app = express();

// Use validated configuration paths
const PORT = config.PORT;
const TASKDATA_PATH = config.TASKDATA_PATH;
const TASKRC_PATH = config.TASKRC_PATH;
const SETTINGS_DB_PATH = config.SETTINGS_DB_PATH;

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

// Security & Middleware Configuration

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"], // Vue needs inline scripts
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:'],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            mediaSrc: ["'self'"],
            frameSrc: ["'none'"],
        },
    },
    xFrameOptions: { action: 'deny' },
    hsts: {
        maxAge: 31536000,
        includeSubDomains: true,
        preload: true
    }
}));

// CORS configuration - restrict origins
const allowedOrigins = config.ALLOWED_ORIGINS.split(',').map(o => o.trim());
app.use(cors({
    origin: (origin, callback) => {
        // Allow requests with no origin (like mobile apps or curl)
        if (!origin) return callback(null, true);
        
        if (allowedOrigins.indexOf(origin) !== -1 || allowedOrigins.includes('*')) {
            callback(null, true);
        } else {
            callback(new Error('Not allowed by CORS'));
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Rate limiting
const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // limit each IP to 100 requests per windowMs
    message: { success: false, error: 'Too many requests, please try again later' },
    standardHeaders: true,
    legacyHeaders: false,
});

const writeLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 50,
    message: { success: false, error: 'Too many modifications, please try again later' },
});

const configLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 10,
    message: { success: false, error: 'Too many configuration changes, please try again later' },
});

// Body parsing
app.use(express.json());

// Request logging
app.use(requestLogger(logger));

// Static files
app.use(express.static(path.join(__dirname, '../public')));

let settingsDb;

async function ensureSettingsDb() {
    if (settingsDb) return settingsDb;
    await ensureSettingsDbDirExists();
    settingsDb = openSettingsDb();
    return settingsDb;
}

// Retrieve the full taskrc as plain text
app.get('/api/taskrc', asyncHandler(async (req, res) => {
    await ensureTaskrcExists();
    const content = await fs.readFile(TASKRC_PATH, { encoding: 'utf8' });
    res.type('text/plain').send(content);
}));

// Overwrite the full taskrc (plain text)
app.put('/api/taskrc', 
    configLimiter,
    express.text({ type: '*/*', limit: '256kb' }), 
    asyncHandler(async (req, res) => {
        const content = typeof req.body === 'string' ? req.body : '';
        
        // Validate taskrc content
        const { error } = schemas.taskrcContent.validate(content);
        if (error) {
            throw new AppError(error.message, 400);
        }
        
        await fs.mkdir(path.dirname(TASKRC_PATH), { recursive: true });
        
        const tmpPath = `${TASKRC_PATH}.tmp`;
        await fs.writeFile(tmpPath, content, { encoding: 'utf8', mode: 0o600 });
        // Explicitly set permissions in case file already existed
        await fs.chmod(tmpPath, 0o600);
        await fs.rename(tmpPath, TASKRC_PATH);
        // Ensure final file has correct permissions
        await fs.chmod(TASKRC_PATH, 0o600);
        
        logger.info('Taskrc updated', { path: TASKRC_PATH });
        res.type('text/plain').send('OK');
    })
);

function splitLines(text) {
    return String(text || '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
}

const completionCache = new Map();

async function execTask(argsArray) {
    await ensureTaskrcExists();

    const { stdout, stderr } = await execFileAsync('task', argsArray, {
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
app.get('/api/filters', asyncHandler(async (req, res) => {
    const db = await ensureSettingsDb();
    const filters = db.prepare('SELECT id, name, filter, "order" AS "order" FROM filters ORDER BY "order" ASC, id ASC').all();
    res.json({ success: true, filters });
}));

app.post('/api/filters', 
    writeLimiter,
    validateBody(schemas.createFilter),
    asyncHandler(async (req, res) => {
        const db = await ensureSettingsDb();
        const { name, filter } = req.body;
        
        const maxOrderRow = db.prepare('SELECT COALESCE(MAX("order"), -1) AS maxOrder FROM filters').get();
        const nextOrder = Number(maxOrderRow?.maxOrder ?? -1) + 1;
        
        const createdAt = new Date().toISOString();
        const stmt = db.prepare('INSERT INTO filters (name, filter, "order", created_at) VALUES (?, ?, ?, ?)');
        const info = stmt.run(name, filter, nextOrder, createdAt);
        
        logger.info('Filter created', { id: info.lastInsertRowid, name });
        res.json({ success: true, filter: { id: info.lastInsertRowid, name, filter, order: nextOrder } });
    })
);

app.put('/api/filters/reorder', 
    writeLimiter,
    validateBody(schemas.reorderFilters),
    asyncHandler(async (req, res) => {
        const db = await ensureSettingsDb();
        const ids = req.body.ids;
        const parsedIds = ids.map((val) => Number(val)).filter((val) => Number.isFinite(val));
        
        
        const unique = new Set(parsedIds);
        if (unique.size !== parsedIds.length) {
            throw new AppError('ids must be unique', 400);
        }
        
        const existingIds = db.prepare('SELECT id FROM filters').all().map((row) => row.id);
        const existingSet = new Set(existingIds);
        for (const id of parsedIds) {
            if (!existingSet.has(id)) {
                throw new AppError(`filter not found: ${id}`, 404);
            }
        }
        
        const run = db.transaction(() => {
            const stmt = db.prepare('UPDATE filters SET "order" = ? WHERE id = ?');
            parsedIds.forEach((id, index) => {
                stmt.run(index, id);
            });
        });
        
        run();
        logger.info('Filters reordered', { count: parsedIds.length });
        res.json({ success: true });
    })
);

app.put('/api/filters/:id', 
    writeLimiter,
    validateBody(schemas.updateFilter),
    asyncHandler(async (req, res) => {
        const db = await ensureSettingsDb();
        const idRaw = String(req.params.id || '');
        if (!/^\d+$/.test(idRaw)) {
            throw new AppError('invalid id', 400);
        }
        const id = Number(idRaw);
        
        const existing = db.prepare('SELECT id, name, filter, "order" AS "order" FROM filters WHERE id = ?').get(id);
        if (!existing) {
            throw new AppError('filter not found', 404);
        }
        
        const nextName = req.body.name || existing.name;
        const nextFilter = req.body.filter || existing.filter;
        const nextOrder = req.body.order !== undefined ? req.body.order : existing.order;
        
        db.prepare('UPDATE filters SET name = ?, filter = ?, "order" = ? WHERE id = ?').run(nextName, nextFilter, nextOrder, id);
        
        logger.info('Filter updated', { id, name: nextName });
        res.json({ success: true, filter: { id, name: nextName, filter: nextFilter, order: nextOrder } });
    })
);

app.delete('/api/filters/:id', 
    writeLimiter,
    asyncHandler(async (req, res) => {
        const db = await ensureSettingsDb();
        const idRaw = String(req.params.id || '');
        if (!/^\d+$/.test(idRaw)) {
            throw new AppError('invalid id', 400);
        }
        const id = Number(idRaw);
        
        const info = db.prepare('DELETE FROM filters WHERE id = ?').run(id);
        if (info.changes === 0) {
            throw new AppError('filter not found', 404);
        }
        
        logger.info('Filter deleted', { id });
        res.json({ success: true });
    })
);

// Lightweight completion endpoint.
// Accepts the current token under cursor (e.g. "proj:", "project:ho", "+ur", "rc.co").
app.get('/api/complete', 
    apiLimiter,
    validateQuery(schemas.completeQuery),
    asyncHandler(async (req, res) => {
        const token = req.query.token;
        const limit = req.query.limit;

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
    })
);

// Single endpoint to execute taskwarrior commands
app.post('/api/task', 
    apiLimiter,
    validateBody(schemas.executeTask),
    asyncHandler(async (req, res) => {
        const { args } = req.body;
        
        // Convert args to array if it's a string
        let argsArray;
        if (Array.isArray(args)) {
            argsArray = args;
        } else {
            // Use shell-quote to properly parse arguments
            const parsed = parseArgs(args);
            // Only allow string results, reject any objects/special constructs
            argsArray = parsed.filter(arg => typeof arg === 'string' && arg.length > 0);
            
            // Verify all parsed elements were strings
            if (argsArray.length !== parsed.filter(arg => arg !== undefined && arg !== null).length) {
                throw new AppError('Arguments contain special shell constructs', 400);
            }
        }
        
        // Validate args don't contain shell metacharacters
        validateTaskArgs(argsArray);
        
        logger.info('Executing task command', { args: argsArray.join(' ').substring(0, 100) });
        
        // Execute taskwarrior command using execFile for security
        const { stdout, stderr } = await execTask(argsArray);
        
        res.json({
            success: true,
            output: stdout,
            error: stderr
        });
    })
);

// Error handling middleware (must be after all routes)
app.use(errorLogger(logger));
app.use(errorHandler(logger));

// Start server
app.listen(PORT, () => {
    console.log(`Taskwarrior Web Server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
    console.log(`TASKRC: ${TASKRC_PATH}`);
});
