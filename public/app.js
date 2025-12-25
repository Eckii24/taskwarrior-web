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

    async complete(token, limit = 20) {
        try {
            const url = new URL(`${this.baseUrl}/complete`, window.location.origin);
            url.searchParams.set('token', token);
            url.searchParams.set('limit', String(limit));

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: {
                    'Accept': 'application/json',
                },
            });

            return await response.json();
        } catch (error) {
            return {
                success: false,
                error: error.message,
                suggestions: [],
            };
        }
    }
}

function getTokenAtCursor(text, cursorIndex) {
    const safeText = String(text || '');
    const idx = Math.max(0, Math.min(cursorIndex ?? safeText.length, safeText.length));

    const before = safeText.slice(0, idx);
    const after = safeText.slice(idx);

    // Avoid autocompleting in the middle of a quoted token.
    const quoteCount = (before.match(/"/g) || []).length + (before.match(/'/g) || []).length;
    if (quoteCount % 2 === 1) {
        return { token: '', start: idx, end: idx };
    }

    const beforeMatch = before.match(/(?:^|\s)(\S*)$/);
    const beforeToken = beforeMatch ? beforeMatch[1] : '';

    const afterMatch = after.match(/^(\S*)/);
    const afterToken = afterMatch ? afterMatch[1] : '';

    const token = `${beforeToken}${afterToken}`;
    const start = idx - beforeToken.length;
    const end = idx + afterToken.length;

    return { token, start, end };
}

function replaceRange(text, start, end, replacement) {
    const safeText = String(text || '');
    const s = Math.max(0, Math.min(start, safeText.length));
    const e = Math.max(s, Math.min(end, safeText.length));
    return safeText.slice(0, s) + replacement + safeText.slice(e);
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
                type: 'success',
                dismissMode: 'auto'
            },
            messageTimeoutId: null,
            emptyMessage: 'Click "Show Tasks" to load tasks...',
             completion: {
                field: null,
                token: '',
                start: 0,
                end: 0,
                suggestions: [],
                selectedIndex: 0,
                visible: false,
            },
        };
    },
    computed: {
        taskrcDirty() {
            return this.taskrcText !== this.loadedTaskrcText;
        }
    },
    methods: {
        resetCompletion() {
            this.completion = {
                field: null,
                token: '',
                start: 0,
                end: 0,
                suggestions: [],
                selectedIndex: 0,
                visible: false,
            };
        },

        async updateCompletion(field, tokenInfo) {
            const token = tokenInfo.token || '';
            if (!token.trim()) {
                this.resetCompletion();
                return [];
            }

            const result = await apiClient.complete(token);
            const suggestions = result && result.success && Array.isArray(result.suggestions)
                ? result.suggestions
                : [];

            if (suggestions.length === 0) {
                this.resetCompletion();
                return [];
            }

            const keepVisible = this.completion.visible && this.completion.field === field;

            this.completion = {
                field,
                token,
                start: tokenInfo.start,
                end: tokenInfo.end,
                suggestions,
                selectedIndex: 0,
                visible: keepVisible,
            };

            return suggestions;
        },

        applyCompletionSuggestion(inputEl, field, suggestion) {
            const current = String(this[field] || '');
            const { start, end } = this.completion;
            const nextValue = replaceRange(current, start, end, suggestion);

            this[field] = nextValue;

            this.$nextTick(() => {
                const cursor = start + suggestion.length;
                inputEl.setSelectionRange(cursor, cursor);
            });
        },

        async handleCompletionKeydown(event, field, actionName) {
            const inputEl = event.target;
            if (!inputEl || typeof inputEl.selectionStart !== 'number') {
                return;
            }

            // Must happen synchronously, otherwise the browser will move focus.
            if (event.key === 'Tab') {
                event.preventDefault();
            }

            const isActive = this.completion.visible && this.completion.field === field;

            if (event.key === 'Escape' && isActive) {
                event.preventDefault();
                this.resetCompletion();
                return;
            }

            // If the completion list is not active for this field, Enter should trigger
            // the field's primary action (add/show/execute).
            if (event.key === 'Enter' && !isActive) {
                if (typeof actionName === 'string' && typeof this[actionName] === 'function') {
                    event.preventDefault();
                    await this[actionName]();
                }
                return;
            }

            const completionKeys = ['Tab', 'ArrowDown', 'ArrowUp', 'Enter'];
            if (!completionKeys.includes(event.key)) {
                return;
            }

            const text = String(this[field] || '');
            const cursor = inputEl.selectionStart;
            const tokenInfo = getTokenAtCursor(text, cursor);

            const tokenChanged = this.completion.field !== field || this.completion.token !== tokenInfo.token || this.completion.start !== tokenInfo.start || this.completion.end !== tokenInfo.end;

            if (tokenChanged || !isActive) {
                await this.updateCompletion(field, tokenInfo);
            }

            if (this.completion.suggestions.length === 0) {
                return;
            }

            // If there is exactly one option and user hits Tab, apply it.
            if (this.completion.suggestions.length === 1 && event.key === 'Tab') {
                this.applyCompletionSuggestion(inputEl, field, this.completion.suggestions[0]);
                this.resetCompletion();
                return;
            }

            // Navigation within list.
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.completion.visible = true;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const count = this.completion.suggestions.length;
                this.completion.selectedIndex = (this.completion.selectedIndex + delta + count) % count;
                return;
            }

            // Tab with multiple suggestions: show list (don't autocomplete).
            if (event.key === 'Tab' && !isActive) {
                this.completion.visible = true;
                return;
            }

            // If the list is open, Tab/Enter accept the highlighted suggestion.
            if ((event.key === 'Enter' || event.key === 'Tab') && this.completion.visible) {
                const suggestion = this.completion.suggestions[this.completion.selectedIndex];
                if (suggestion) {
                    event.preventDefault();
                    this.applyCompletionSuggestion(inputEl, field, suggestion);
                    this.resetCompletion();
                }
            }
        },

        async handleCompletionInput(event, field) {
            const inputEl = event.target;
            if (!inputEl || typeof inputEl.selectionStart !== 'number') {
                this.resetCompletion();
                return;
            }

            // If the completion list is open for this field, keep it in sync.
            if (this.completion.visible && this.completion.field === field) {
                const text = String(this[field] || '');
                const cursor = inputEl.selectionStart;
                const tokenInfo = getTokenAtCursor(text, cursor);
                await this.updateCompletion(field, tokenInfo);
            }
        },

        handleCompletionBlur(field) {
            if (this.completion.field === field) {
                this.resetCompletion();
            }
        },

        showMessage(text, type = 'success', dismissMode) {
            const resolvedDismissMode = dismissMode ?? (type === 'error' ? 'manual' : 'auto');

            if (this.messageTimeoutId) {
                clearTimeout(this.messageTimeoutId);
                this.messageTimeoutId = null;
            }

            this.message = { text, type, dismissMode: resolvedDismissMode };

            if (resolvedDismissMode === 'auto') {
                this.messageTimeoutId = setTimeout(() => {
                    this.dismissMessage();
                }, 5000);
            }
        },

        dismissMessage() {
            if (this.messageTimeoutId) {
                clearTimeout(this.messageTimeoutId);
                this.messageTimeoutId = null;
            }

            this.message = { text: '', type: 'success', dismissMode: 'auto' };
        },

        async setTab(tab) {
            this.activeTab = tab;
            this.resetCompletion();
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
            this.resetCompletion();

            try {
                const filter = this.reportInput.trim() || 'list';
                this.tasks = await queryService.getTasks(filter);
                this.emptyMessage = this.tasks.length === 0 ? 'No tasks found' : '';
            } catch (error) {
                this.showMessage(`Error loading tasks: ${error.message}`, 'error');
            }
        },

        async addTask() {
            this.resetCompletion();

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
            this.resetCompletion();

            const command = this.customCommandInput.trim();
            if (!command) {
                this.showMessage('Please enter a command', 'error');
                return;
            }

            try {
                const result = await commandService.executeCustom(command);

                if (result.success) {
                    const output = (result.output || '').trim();
                    const errorOutput = (result.error || '').trim();

                    const parts = [];
                    if (output) parts.push(output);
                    if (errorOutput) parts.push(errorOutput);

                    const text = parts.length > 0 ? parts.join('\n') : 'OK';
                    this.showMessage(text, 'info', 'manual');
                    this.customCommandInput = '';

                    // Advanced commands should not implicitly refresh the task list.
                } else {
                    const output = (result.output || '').trim();
                    const errorOutput = (result.error || '').trim();

                    const parts = [];
                    if (errorOutput) parts.push(errorOutput);
                    if (output) parts.push(output);

                    const text = parts.length > 0 ? parts.join('\n') : 'Unknown error';
                    this.showMessage(text, 'error');
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
