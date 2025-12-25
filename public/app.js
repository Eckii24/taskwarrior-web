// CQRS - Command Query Responsibility Segregation

// Query Service - Read operations
class TaskQueryService {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async getTasks(filter = 'status:pending') {
        const reportMap = {
            'list': 'status:pending',
            'pending': 'status:pending',
            'all': '',
            'completed': 'status:completed',
            'next': 'status:pending limit:page',
        };

        const actualFilter = reportMap[filter] || filter;
        const args = actualFilter ? `${actualFilter} export` : 'export';
        
        const result = await this.apiClient.execute(args);
        
        if (result.success && result.output) {
            try {
                return JSON.parse(result.output);
            } catch (e) {
                return [];
            }
        }
        return [];
    }
}

// Command Service - Write operations
class TaskCommandService {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async addTask(description) {
        return await this.apiClient.execute(`add ${description}`);
    }

    async modifyTask(taskId, modifications) {
        return await this.apiClient.execute(`${taskId} modify ${modifications}`);
    }

    async completeTask(taskId) {
        return await this.apiClient.execute(`${taskId} done`);
    }

    async deleteTask(taskId) {
        return await this.apiClient.execute(`${taskId} delete`);
    }

    async executeCustom(command) {
        return await this.apiClient.execute(command);
    }
}

// API Client - Single endpoint communication
class TaskApiClient {
    constructor(baseUrl = '/api') {
        this.baseUrl = baseUrl;
    }

    async execute(args) {
        try {
            const response = await fetch(`${this.baseUrl}/task`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ args })
            });

            return await response.json();
        } catch (error) {
            return {
                success: false,
                error: error.message
            };
        }
    }
}

// Initialize services
const apiClient = new TaskApiClient();
const queryService = new TaskQueryService(apiClient);
const commandService = new TaskCommandService(apiClient);

// Vue Application
const { createApp } = Vue;

createApp({
    data() {
        return {
            activeTab: 'tasks',
            addTaskInput: '',
            reportInput: 'list',
            customCommandInput: '',
            tasks: [],
            taskrcText: '',
            loadedTaskrcText: '',
            message: {
                text: '',
                type: 'success'
            },
            emptyMessage: 'Click "Show Tasks" to load tasks...'
        };
    },
    computed: {
        taskrcDirty() {
            return this.taskrcText !== this.loadedTaskrcText;
        }
    },
    methods: {
        showMessage(text, type = 'success') {
            this.message = { text, type };
            setTimeout(() => {
                this.message = { text: '', type: 'success' };
            }, 5000);
        },

        async setTab(tab) {
            this.activeTab = tab;
            if (tab === 'config' && this.taskrcText === '' && this.loadedTaskrcText === '') {
                this.showMessage('Loading configuration...', 'success');
                try {
                    await this.loadTaskrc();
                    this.showMessage('Configuration loaded.', 'success');
                } catch (error) {
                    const message = error && error.message ? error.message : String(error);
                    this.showMessage(`Error loading configuration: ${message}`, 'error');
                }
            }
        },

        setReport(report) {
            this.reportInput = report;
            this.loadTasks();
        },

        async loadTasks() {
            try {
                const filter = this.reportInput.trim() || 'list';
                this.tasks = await queryService.getTasks(filter);
                this.emptyMessage = this.tasks.length === 0 ? 'No tasks found' : '';
                this.showMessage(`Loaded ${this.tasks.length} task(s)`, 'success');
            } catch (error) {
                this.showMessage(`Error loading tasks: ${error.message}`, 'error');
            }
        },

        async addTask() {
            if (!this.addTaskInput.trim()) {
                this.showMessage('Please enter a task description', 'error');
                return;
            }

            try {
                const result = await commandService.addTask(this.addTaskInput);
                
                if (result.success) {
                    this.showMessage('Task added successfully!', 'success');
                    this.addTaskInput = '';
                    await this.loadTasks();
                } else {
                    this.showMessage(`Error: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showMessage(`Error adding task: ${error.message}`, 'error');
            }
        },

        async editTask(taskId) {
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

            try {
                const result = await commandService.modifyTask(taskId, modifications.trim());
                
                if (result.success) {
                    this.showMessage(`Task ${taskId} modified successfully!`, 'success');
                    await this.loadTasks();
                } else {
                    this.showMessage(`Error: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showMessage(`Error modifying task: ${error.message}`, 'error');
            }
        },

        async markDone(taskId) {
            try {
                const result = await commandService.completeTask(taskId);
                
                if (result.success) {
                    this.showMessage(`Task ${taskId} marked as done!`, 'success');
                    await this.loadTasks();
                } else {
                    this.showMessage(`Error: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showMessage(`Error marking task as done: ${error.message}`, 'error');
            }
        },

        async deleteTask(taskId) {
            if (!confirm(`Are you sure you want to delete task ${taskId}?`)) {
                return;
            }

            try {
                const result = await commandService.deleteTask(taskId);
                
                if (result.success) {
                    this.showMessage(`Task ${taskId} deleted successfully!`, 'success');
                    await this.loadTasks();
                } else {
                    this.showMessage(`Error: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showMessage(`Error deleting task: ${error.message}`, 'error');
            }
        },

        async executeCustomCommand() {
            if (!this.customCommandInput.trim()) {
                this.showMessage('Please enter a command', 'error');
                return;
            }

            try {
                const result = await commandService.executeCustom(this.customCommandInput);
                
                if (result.success) {
                    this.showMessage('Command executed successfully!', 'success');
                    this.customCommandInput = '';
                    
                    // Reload tasks immediately
                    await this.loadTasks();
                } else {
                    this.showMessage(`Error: ${result.error}`, 'error');
                }
            } catch (error) {
                this.showMessage(`Error executing command: ${error.message}`, 'error');
            }
        },

        getStatusClass(status) {
            return status === 'completed' ? 'status-completed' : 'status-pending';
        },

        formatTags(tags) {
            return tags ? tags.join(', ') : '';
        },

        formatDate(dateStr) {
            if (!dateStr) return '';
            try {
                return new Date(dateStr).toLocaleDateString();
            } catch {
                return '';
            }
        },

        async loadTaskrc() {
            try {
                const response = await fetch('/api/taskrc');
                if (!response.ok) {
                    throw new Error(await response.text());
                }

                const text = await response.text();
                this.taskrcText = text;
                this.loadedTaskrcText = text;
                this.showMessage('Loaded taskrc', 'success');
            } catch (error) {
                this.showMessage(`Error loading taskrc: ${error.message}`, 'error');
            }
        },

        async saveTaskrc() {
            try {
                const response = await fetch('/api/taskrc', {
                    method: 'PUT',
                    headers: {
                        'Content-Type': 'text/plain; charset=utf-8',
                    },
                    body: this.taskrcText
                });

                if (!response.ok) {
                    throw new Error(await response.text());
                }

                this.loadedTaskrcText = this.taskrcText;
                this.showMessage('Saved taskrc', 'success');
            } catch (error) {
                this.showMessage(`Error saving taskrc: ${error.message}`, 'error');
            }
        }
    }
}).mount('#app');
