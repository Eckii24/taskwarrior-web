const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { exec } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '../public')));

// Helper function to execute taskwarrior commands
async function executeTaskCommand(command) {
    try {
        const { stdout, stderr } = await execAsync(`task ${command}`);
        return { success: true, output: stdout, error: stderr };
    } catch (error) {
        return { success: false, output: error.stdout || '', error: error.stderr || error.message };
    }
}

// API Endpoints

// Get tasks - supports custom report commands
app.post('/api/tasks/list', async (req, res) => {
    try {
        const { command = 'status:pending' } = req.body;
        // Allow custom report commands/filters like 'status:pending', 'project:work', etc.
        // Export command uses filter syntax, not report names
        let filter = command;
        
        // Map common report names to filters
        const reportMap = {
            'list': 'status:pending',
            'pending': 'status:pending',
            'all': '',
            'completed': 'status:completed',
            'next': 'status:pending limit:page',
        };
        
        if (reportMap[command]) {
            filter = reportMap[command];
        }
        
        const result = await executeTaskCommand(`${filter} export`);
        
        if (result.success || result.output) {
            try {
                const tasks = JSON.parse(result.output || '[]');
                res.json({ success: true, tasks, raw: result.output });
            } catch (parseError) {
                // If JSON parsing fails, return raw output
                res.json({ success: true, tasks: [], raw: result.output });
            }
        } else {
            res.status(500).json({ success: false, error: result.error, output: result.output });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Add a new task
app.post('/api/tasks/add', async (req, res) => {
    try {
        const { taskDescription } = req.body;
        
        if (!taskDescription) {
            return res.status(400).json({ success: false, error: 'Task description is required' });
        }
        
        // Execute task add command with the full CLI syntax
        const result = await executeTaskCommand(`add ${taskDescription}`);
        
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Edit/modify a task
app.post('/api/tasks/modify', async (req, res) => {
    try {
        const { taskId, modifications } = req.body;
        
        if (!taskId || !modifications) {
            return res.status(400).json({ success: false, error: 'Task ID and modifications are required' });
        }
        
        // Execute task modify command with CLI syntax
        const result = await executeTaskCommand(`${taskId} modify ${modifications}`);
        
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Execute custom taskwarrior command
app.post('/api/tasks/execute', async (req, res) => {
    try {
        const { command } = req.body;
        
        if (!command) {
            return res.status(400).json({ success: false, error: 'Command is required' });
        }
        
        // Execute any taskwarrior command directly
        const result = await executeTaskCommand(command);
        
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Mark task as done
app.post('/api/tasks/done', async (req, res) => {
    try {
        const { taskId } = req.body;
        
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Task ID is required' });
        }
        
        const result = await executeTaskCommand(`${taskId} done`);
        
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Delete a task
app.post('/api/tasks/delete', async (req, res) => {
    try {
        const { taskId } = req.body;
        
        if (!taskId) {
            return res.status(400).json({ success: false, error: 'Task ID is required' });
        }
        
        const result = await executeTaskCommand(`${taskId} delete`);
        
        res.json({
            success: result.success,
            output: result.output,
            error: result.error
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get task attributes for autocompletion
app.get('/api/tasks/attributes', async (req, res) => {
    try {
        const result = await executeTaskCommand('_columns');
        
        res.json({
            success: result.success,
            attributes: result.output.split('\n').filter(a => a.trim()),
            output: result.output
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Get task reports
app.get('/api/tasks/reports', async (req, res) => {
    try {
        const result = await executeTaskCommand('reports');
        
        res.json({
            success: result.success,
            output: result.output
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`Taskwarrior Web Server running on port ${PORT}`);
    console.log(`Frontend: http://localhost:${PORT}`);
    console.log(`API: http://localhost:${PORT}/api`);
});
