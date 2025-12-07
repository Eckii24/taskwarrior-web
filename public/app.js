// API base URL
const API_BASE = '/api';

// Current tasks data
let currentTasks = [];

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    // Add event listeners for Enter key
    document.getElementById('addTaskInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') addTask();
    });
    
    document.getElementById('reportInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') loadTasks();
    });
    
    document.getElementById('customCommandInput').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') executeCustomCommand();
    });
});

// Show message to user
function showMessage(message, type = 'success') {
    const messageDiv = document.getElementById('outputMessage');
    messageDiv.textContent = message;
    messageDiv.className = `message ${type}`;
    
    setTimeout(() => {
        messageDiv.className = 'message';
    }, 5000);
}

// Set report command
function setReport(report) {
    document.getElementById('reportInput').value = report;
    loadTasks();
}

// Load tasks using custom report
async function loadTasks() {
    const reportInput = document.getElementById('reportInput').value.trim();
    const command = reportInput || 'list';
    
    try {
        const response = await fetch(`${API_BASE}/tasks/list`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ command })
        });
        
        const data = await response.json();
        
        if (data.success) {
            currentTasks = data.tasks || [];
            displayTasks(currentTasks);
            showMessage(`Loaded ${currentTasks.length} task(s) using report: ${command}`, 'success');
        } else {
            showMessage(`Error: ${data.error}`, 'error');
            document.getElementById('tasksContainer').innerHTML = `
                <div class="raw-output">
                    <details>
                        <summary>Raw Output</summary>
                        <pre>${data.output || data.error}</pre>
                    </details>
                </div>
            `;
        }
    } catch (error) {
        showMessage(`Error loading tasks: ${error.message}`, 'error');
    }
}

// Display tasks in table
function displayTasks(tasks) {
    const container = document.getElementById('tasksContainer');
    
    if (!tasks || tasks.length === 0) {
        container.innerHTML = '<p class="loading">No tasks found</p>';
        return;
    }
    
    let html = '<table><thead><tr>';
    html += '<th>ID</th>';
    html += '<th>Description</th>';
    html += '<th>Status</th>';
    html += '<th>Project</th>';
    html += '<th>Tags</th>';
    html += '<th>Due</th>';
    html += '<th>Actions</th>';
    html += '</tr></thead><tbody>';
    
    tasks.forEach(task => {
        const status = task.status || 'pending';
        const statusClass = status === 'completed' ? 'status-completed' : 'status-pending';
        const tags = task.tags ? task.tags.join(', ') : '';
        const due = task.due ? new Date(task.due).toLocaleDateString() : '';
        
        html += '<tr>';
        html += `<td class="task-id">${task.id || task.uuid}</td>`;
        html += `<td class="task-description">${escapeHtml(task.description || '')}</td>`;
        html += `<td><span class="task-status ${statusClass}">${status}</span></td>`;
        html += `<td>${escapeHtml(task.project || '')}</td>`;
        html += `<td>${escapeHtml(tags)}</td>`;
        html += `<td>${due}</td>`;
        html += `<td class="task-actions">`;
        
        if (status === 'pending') {
            html += `<button class="btn btn-success" onclick="markDone(${task.id})">Done</button>`;
            html += `<button class="btn btn-primary" onclick="editTask(${task.id})">Edit</button>`;
        }
        
        html += `<button class="btn btn-danger" onclick="deleteTask(${task.id})">Delete</button>`;
        html += '</td>';
        html += '</tr>';
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

// Add task
async function addTask() {
    const input = document.getElementById('addTaskInput');
    const taskDescription = input.value.trim();
    
    if (!taskDescription) {
        showMessage('Please enter a task description', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/tasks/add`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ taskDescription })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Task added successfully!', 'success');
            input.value = '';
            loadTasks(); // Reload tasks
        } else {
            showMessage(`Error: ${data.error || data.output}`, 'error');
        }
    } catch (error) {
        showMessage(`Error adding task: ${error.message}`, 'error');
    }
}

// Edit task - prompt for modifications using CLI syntax
function editTask(taskId) {
    const modifications = prompt(
        `Edit task ${taskId} using taskwarrior CLI syntax:\n\n` +
        `Examples:\n` +
        `- priority:H\n` +
        `- project:work due:tomorrow\n` +
        `- +urgent\n` +
        `- New description text\n\n` +
        `Enter modifications:`
    );
    
    if (modifications === null || modifications.trim() === '') {
        return;
    }
    
    modifyTask(taskId, modifications.trim());
}

// Modify task
async function modifyTask(taskId, modifications) {
    try {
        const response = await fetch(`${API_BASE}/tasks/modify`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ taskId, modifications })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage(`Task ${taskId} modified successfully!`, 'success');
            loadTasks(); // Reload tasks
        } else {
            showMessage(`Error: ${data.error || data.output}`, 'error');
        }
    } catch (error) {
        showMessage(`Error modifying task: ${error.message}`, 'error');
    }
}

// Mark task as done
async function markDone(taskId) {
    try {
        const response = await fetch(`${API_BASE}/tasks/done`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ taskId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage(`Task ${taskId} marked as done!`, 'success');
            loadTasks(); // Reload tasks
        } else {
            showMessage(`Error: ${data.error || data.output}`, 'error');
        }
    } catch (error) {
        showMessage(`Error marking task as done: ${error.message}`, 'error');
    }
}

// Delete task
async function deleteTask(taskId) {
    if (!confirm(`Are you sure you want to delete task ${taskId}?`)) {
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/tasks/delete`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ taskId })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage(`Task ${taskId} deleted successfully!`, 'success');
            loadTasks(); // Reload tasks
        } else {
            showMessage(`Error: ${data.error || data.output}`, 'error');
        }
    } catch (error) {
        showMessage(`Error deleting task: ${error.message}`, 'error');
    }
}

// Execute custom command
async function executeCustomCommand() {
    const input = document.getElementById('customCommandInput');
    const command = input.value.trim();
    
    if (!command) {
        showMessage('Please enter a command', 'error');
        return;
    }
    
    try {
        const response = await fetch(`${API_BASE}/tasks/execute`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ command })
        });
        
        const data = await response.json();
        
        if (data.success) {
            showMessage('Command executed successfully!', 'success');
            input.value = '';
            
            // Show raw output
            const container = document.getElementById('tasksContainer');
            container.innerHTML = `
                <div class="raw-output">
                    <h3>Command Output:</h3>
                    <pre>${escapeHtml(data.output)}</pre>
                </div>
            `;
            
            // Optionally reload tasks
            setTimeout(() => loadTasks(), 1000);
        } else {
            showMessage(`Error: ${data.error}`, 'error');
            
            // Show error output
            const container = document.getElementById('tasksContainer');
            container.innerHTML = `
                <div class="raw-output">
                    <h3>Error Output:</h3>
                    <pre>${escapeHtml(data.output || data.error)}</pre>
                </div>
            `;
        }
    } catch (error) {
        showMessage(`Error executing command: ${error.message}`, 'error');
    }
}
