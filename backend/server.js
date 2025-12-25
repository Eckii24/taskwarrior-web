const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');
const fs = require('fs/promises');
const os = require('os');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

const DEFAULT_TASKDATA_PATH = path.join(process.env.HOME || os.homedir(), '.task');
const DEFAULT_TASKRC_PATH = path.join(DEFAULT_TASKDATA_PATH, 'taskrc');

const TASKDATA_PATH = process.env.TASKDATA || DEFAULT_TASKDATA_PATH;
const TASKRC_PATH = process.env.TASKRC || DEFAULT_TASKRC_PATH;

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

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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

        // Convert args to array if it's a string
        let argsArray;
        if (Array.isArray(args)) {
            argsArray = args;
        } else {
            // Simple whitespace split - taskwarrior handles complex parsing
            argsArray = args.split(/\s+/).filter(arg => arg.length > 0);
        }

        // Ensure the config exists so Taskwarrior doesn't fall back to interactive prompts.
        await ensureTaskrcExists();

        // Execute taskwarrior command using execFile for security
        const { stdout, stderr } = await execFileAsync('task', argsArray, {
            env: {
                ...process.env,
                TASKRC: TASKRC_PATH,
                TASKDATA: TASKDATA_PATH,
            },
        });

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
