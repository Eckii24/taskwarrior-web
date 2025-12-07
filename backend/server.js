const express = require('express');
const cors = require('cors');
const { execFile } = require('child_process');
const path = require('path');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

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
        
        // Execute taskwarrior command using execFile for security
        const { stdout, stderr } = await execFileAsync('task', argsArray);
        
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
});
