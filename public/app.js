// CQRS - Command Query Responsibility Segregation

class TaskApiClient {
    constructor(baseUrl = '/api') {
        this.baseUrl = baseUrl;
    }

    async execute(args) {
        try {
            const response = await fetch(`${this.baseUrl}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ args }),
            });
            return await response.json();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async complete(token, limit = 20) {
        try {
            const url = new URL(`${this.baseUrl}/complete`, window.location.origin);
            url.searchParams.set('token', token);
            url.searchParams.set('limit', String(limit));

            const response = await fetch(url.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });

            return await response.json();
        } catch (error) {
            return { success: false, error: error.message, suggestions: [] };
        }
    }

    async getFilters() {
        const response = await fetch(`${this.baseUrl}/filters`);
        return await response.json();
    }

    async createFilter(payload) {
        const response = await fetch(`${this.baseUrl}/filters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await response.json();
    }

    async updateFilter(id, payload) {
        const response = await fetch(`${this.baseUrl}/filters/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await response.json();
    }

    async deleteFilter(id) {
        const response = await fetch(`${this.baseUrl}/filters/${id}`, { method: 'DELETE' });
        return await response.json();
    }

    async reorderFilters(ids) {
        const response = await fetch(`${this.baseUrl}/filters/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        return await response.json();
    }
}

class TaskQueryService {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    sortByUrgency(tasks) {
        const list = Array.isArray(tasks) ? tasks.slice() : [];

        const urgencyFor = (task) => {
            const status = String(task?.status || '').toLowerCase();
            if (status === 'completed' || status === 'deleted') return 0;

            const num = typeof task?.urgency === 'number' ? task.urgency : Number(task?.urgency);
            return Number.isFinite(num) ? num : 0;
        };

        list.sort((a, b) => urgencyFor(b) - urgencyFor(a));
        return list;
    }

    async getTasks(filterOrReport) {
        const reportMap = {
            list: 'status:pending',
            pending: 'status:pending',
            all: '',
            completed: 'status:completed',
            next: 'status:pending limit:page',
        };

        const normalized = String(filterOrReport || '').trim() || 'next';
        const actualFilter = reportMap[normalized] !== undefined ? reportMap[normalized] : normalized;
        const args = actualFilter ? `${actualFilter} export` : 'export';

        const result = await this.apiClient.execute(args);
        if (result.success && result.output) {
            try {
                const tasks = JSON.parse(result.output);
                return this.sortByUrgency(tasks);
            } catch {
                return [];
            }
        }
        return [];
    }
}

class TaskCommandService {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async addTask(description) {
        return await this.apiClient.execute(`add ${description}`);
    }

    async modifyTask(taskUuid, modifications) {
        return await this.apiClient.execute(`${taskUuid} modify ${modifications}`);
    }

    async completeTask(taskUuid) {
        return await this.apiClient.execute(`${taskUuid} done`);
    }

    async markPending(taskUuid) {
        return await this.apiClient.execute(`${taskUuid} mod status:pending`);
    }

    async deleteTask(taskUuid) {
        return await this.apiClient.execute(`${taskUuid} delete`);
    }

    async showTask(taskUuid) {
        return await this.apiClient.execute(`${taskUuid}`);
    }

    async executeCustom(command) {
        return await this.apiClient.execute(command);
    }
}

function getTokenAtCursor(text, cursorIndex) {
    const safeText = String(text || '');
    const idx = Math.max(0, Math.min(cursorIndex ?? safeText.length, safeText.length));

    const before = safeText.slice(0, idx);
    const after = safeText.slice(idx);

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

const apiClient = new TaskApiClient();
const queryService = new TaskQueryService(apiClient);
const commandService = new TaskCommandService(apiClient);

const { createApp } = Vue;

createApp({
    data() {
        return {
            drawerOpen: false,
            showTaskrc: false,
            taskrcText: '',
            loadedTaskrcText: '',

            filters: [],
            draggedFilterId: null,

            selectedView: { type: 'builtin', key: 'next' },
            tasks: [],
            emptyMessage: 'Loading…',
            mainMode: 'tasks',
            mainOutput: '',

            busyTaskUuids: {},

            modal: {
                open: false,
                type: null, // add/edit/show/exec/search/filter
                value: '',
                output: '',
                taskId: null,
                filterId: null,
                filterName: '',
                filterValue: '',
                // New structured fields for add/edit
                description: '',
                project: '',
                tags: '',
                priority: '',
                due: '',
                showTaskDetails: false,
                taskDetailsOutput: '',
                // Original values for edit comparison
                originalDescription: '',
                originalProject: '',
                originalTags: '',
                originalPriority: '',
                originalDue: '',
                // Attribute dropdown state
                activeAttributeDropdown: null,
                attributeInputValue: '',
            },

            searchPendingOnly: true,
            lastSearch: {
                term: '',
                pendingOnly: true,
            },

            toast: {
                text: '',
                type: 'success',
            },
            toastTimeoutId: null,

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
        },
        currentTitle() {
            if (this.showTaskrc) return 'Settings';
            if (this.selectedView.type === 'search') return 'Search';
            if (this.selectedView.type === 'builtin') {
                return this.selectedView.key === 'next' ? 'Next' : 'All';
            }
            if (this.selectedView.type === 'filter') {
                const filter = this.filters.find((f) => f.id === this.selectedView.id);
                return filter ? filter.name : 'Filter';
            }
            return 'Taskwarrior';
        },
        modalTitle() {
            const map = {
                add: 'Add Task',
                edit: 'Edit Task',
                show: 'Task',

                exec: 'Execute',
                search: 'Search',
                filter: this.modal.filterId ? 'Edit Filter' : 'Add Filter',
            };
            return map[this.modal.type] || 'Command';
        },
    },
    async mounted() {
        window.addEventListener('keydown', this.onGlobalKeydown);
        await this.refreshFilters();
        await this.loadTasksForSelection();
    },
    beforeUnmount() {
        window.removeEventListener('keydown', this.onGlobalKeydown);
    },
    methods: {
        onGlobalKeydown(event) {
            if (event.key === 'Escape') {
                if (this.modal.open) this.closeModal();
                if (this.drawerOpen) this.toggleDrawer(false);
                this.resetCompletion();
            }
        },

        toggleDrawer(open) {
            this.drawerOpen = Boolean(open);
        },

        openSettings() {
            this.showTaskrc = true;
            this.mainMode = 'tasks';
            this.mainOutput = '';
            this.resetCompletion();
            this.toggleDrawer(false);

            if (this.taskrcText === '' && this.loadedTaskrcText === '') {
                this.loadTaskrc();
            }
        },

        showToast(text, type = 'success', durationMs = 2500) {
            if (this.toastTimeoutId) clearTimeout(this.toastTimeoutId);
            this.toast = { text, type };
            this.toastTimeoutId = setTimeout(() => {
                this.toast = { text: '', type: 'success' };
                this.toastTimeoutId = null;
            }, durationMs);
        },

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

        getFieldValue(field) {
            const parts = String(field).split('.');
            let obj = this;
            for (const part of parts) {
                if (!obj) return '';
                obj = obj[part];
            }
            return obj;
        },

        setFieldValue(field, value) {
            const parts = String(field).split('.');
            let obj = this;
            for (let i = 0; i < parts.length - 1; i++) {
                obj = obj[parts[i]];
            }
            obj[parts[parts.length - 1]] = value;
        },

        async updateCompletion(field, tokenInfo) {
            const token = tokenInfo.token || '';
            
            // Handle field-specific completions
            if (field === 'modal.project') {
                const result = await apiClient.complete(`project:${token}`);
                const suggestions = result && result.success && Array.isArray(result.suggestions) ? result.suggestions : [];
                const projectSuggestions = suggestions.map(s => s.replace(/^project:/, ''));
                
                if (projectSuggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                const keepVisible = this.completion.visible && this.completion.field === field;
                this.completion = {
                    field,
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions: projectSuggestions,
                    selectedIndex: 0,
                    visible: keepVisible,
                };
                return projectSuggestions;
            }
            
            if (field === 'modal.tags') {
                const result = await apiClient.complete(`+${token}`);
                const suggestions = result && result.success && Array.isArray(result.suggestions) ? result.suggestions : [];
                const tagSuggestions = suggestions.map(s => s.replace(/^\+/, ''));
                
                if (tagSuggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                const keepVisible = this.completion.visible && this.completion.field === field;
                this.completion = {
                    field,
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions: tagSuggestions,
                    selectedIndex: 0,
                    visible: keepVisible,
                };
                return tagSuggestions;
            }
            
            if (field === 'modal.priority') {
                const priorities = ['H', 'M', 'L'];
                const suggestions = priorities.filter(p => p.toLowerCase().startsWith(token.toLowerCase()));
                
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
            }
            
            if (field === 'modal.due') {
                const dueSuggestions = ['today', 'tomorrow', 'eom', 'eoy', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
                const suggestions = dueSuggestions.filter(d => d.startsWith(token.toLowerCase()));
                
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
            }
            
            // Default completion logic for other fields
            if (!token.trim()) {
                this.resetCompletion();
                return [];
            }

            const result = await apiClient.complete(token);
            const suggestions = result && result.success && Array.isArray(result.suggestions) ? result.suggestions : [];

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
            const current = String(this.getFieldValue(field) || '');
            const { start, end } = this.completion;
            const nextValue = replaceRange(current, start, end, suggestion);

            this.setFieldValue(field, nextValue);

            this.$nextTick(() => {
                const cursor = start + suggestion.length;
                inputEl.setSelectionRange(cursor, cursor);
            });
        },

        applyModalCompletion(field, suggestion) {
            const inputEl = this.$refs.modalInput;
            if (!inputEl) return;

            this.applyCompletionSuggestion(inputEl, field, suggestion);
            this.resetCompletion();
            this.$nextTick(() => inputEl.focus());
        },

        async handleCompletionKeydown(event, field, actionName) {
            const inputEl = event.target;
            if (!inputEl || typeof inputEl.selectionStart !== 'number') return;

            // Prevent the browser from moving focus on Tab.
            // This must be synchronous (before any await).
            if (event.key === 'Tab') {
                event.preventDefault();
                event.stopPropagation();
            }

            const isActive = this.completion.visible && this.completion.field === field;

            if (event.key === 'Escape' && isActive) {
                event.preventDefault();
                this.resetCompletion();
                return;
            }

            if (event.key === 'Enter' && !isActive) {
                if (typeof actionName === 'string' && typeof this[actionName] === 'function') {
                    event.preventDefault();
                    await this[actionName]();
                }
                return;
            }

            const completionKeys = ['Tab', 'ArrowDown', 'ArrowUp', 'Enter'];
            if (!completionKeys.includes(event.key)) return;

            const text = String(this.getFieldValue(field) || '');
            const cursor = inputEl.selectionStart;
            const tokenInfo = getTokenAtCursor(text, cursor);

            const tokenChanged =
                this.completion.field !== field ||
                this.completion.token !== tokenInfo.token ||
                this.completion.start !== tokenInfo.start ||
                this.completion.end !== tokenInfo.end;

            if (tokenChanged || !isActive) {
                await this.updateCompletion(field, tokenInfo);
            }

            if (this.completion.suggestions.length === 0) {
                if (event.key === 'Tab' && isActive) {
                    this.resetCompletion();
                }
                return;
            }


            if (this.completion.suggestions.length === 1 && event.key === 'Tab') {
                this.applyCompletionSuggestion(inputEl, field, this.completion.suggestions[0]);
                this.resetCompletion();
                return;
            }

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.completion.visible = true;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const count = this.completion.suggestions.length;
                this.completion.selectedIndex = (this.completion.selectedIndex + delta + count) % count;
                return;
            }

            if (event.key === 'Tab' && !isActive) {
                this.completion.visible = true;
                return;
            }

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

            if (this.completion.visible && this.completion.field === field) {
                const text = String(this.getFieldValue(field) || '');
                const cursor = inputEl.selectionStart;
                const tokenInfo = getTokenAtCursor(text, cursor);
                await this.updateCompletion(field, tokenInfo);
            }
        },

        handleCompletionBlur(field) {
            // Delay so mousedown on a suggestion can apply it.
            setTimeout(() => {
                if (this.completion.field === field) this.resetCompletion();
            }, 150);
        },

        async refreshFilters() {
            try {
                const result = await apiClient.getFilters();
                if (result.success && Array.isArray(result.filters)) {
                    this.filters = result.filters.slice().sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
                }
            } catch {
                // ignore
            }
        },

        selectBuiltin(key) {
            this.showTaskrc = false;
            this.selectedView = { type: 'builtin', key };
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.loadTasksForSelection();
        },

        selectSearch() {
            this.showTaskrc = false;
            this.selectedView = { type: 'search' };
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.openCommandModal('search');
        },

        selectCustomFilter(filter) {
            this.showTaskrc = false;
            this.selectedView = { type: 'filter', id: filter.id };
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.loadTasksForSelection();
        },

        async loadTasksForSelection() {
            this.emptyMessage = 'Loading…';
            this.mainMode = 'tasks';
            this.mainOutput = '';

            try {
                if (this.selectedView.type === 'search') {
                    this.tasks = [];
                    this.emptyMessage = 'Use Search to load tasks.';
                    return;
                }

                if (this.selectedView.type === 'builtin') {
                    const key = this.selectedView.key;
                    const query = key === 'next' ? 'next' : 'all';
                    this.tasks = await queryService.getTasks(query);
                    this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                    return;
                }

                if (this.selectedView.type === 'filter') {
                    const filter = this.filters.find((f) => f.id === this.selectedView.id);
                    if (!filter) {
                        this.tasks = [];
                        this.emptyMessage = 'Filter not found.';
                        return;
                    }
                    this.tasks = await queryService.getTasks(filter.filter);
                    this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                }
            } catch (error) {
                this.tasks = [];
                this.emptyMessage = 'Error loading tasks.';
                this.showToast(String(error?.message || error), 'error');
            }
        },

        async refreshCurrentPanel() {
            if (this.showTaskrc) return;

            if (this.selectedView.type === 'search') {
                const term = String(this.lastSearch.term || '').trim();
                if (!term) {
                    this.tasks = [];
                    this.emptyMessage = 'Use Search to load tasks.';
                    return;
                }

                const prefix = this.lastSearch.pendingOnly ? 'status:pending ' : '';
                this.mainMode = 'tasks';
                this.tasks = await queryService.getTasks(`${prefix}${term}`);
                this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                return;
            }

            await this.loadTasksForSelection();
        },

        openAddTask() {
            this.openCommandModal('add');
            this.toggleDrawer(false);
        },

        async runSync() {
            try {
                const result = await commandService.executeCustom('sync');
                if (result.success) {
                    const output = (result.output || '').trim();
                    const err = (result.error || '').trim();
                    const text = [output, err].filter(Boolean).join('\n') || 'OK';
                    this.showToast(text, 'success', 4500);
                } else {
                    this.showToast(result.error || 'Sync failed', 'error', 4500);
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error', 4500);
            }
        },

        openAddFilter() {
            this.modal = { open: true, type: 'filter', value: '', taskId: null, filterId: null, filterName: '', filterValue: '' };
            this.resetCompletion();
            this.$nextTick(() => {
                if (this.$refs.modalNameInput) this.$refs.modalNameInput.focus();
            });
        },

        openEditFilter(filter) {
            this.modal = {
                open: true,
                type: 'filter',
                value: '',
                taskId: null,
                filterId: filter.id,
                filterName: filter.name,
                filterValue: filter.filter,
            };
            this.resetCompletion();
            this.$nextTick(() => {
                if (this.$refs.modalNameInput) this.$refs.modalNameInput.focus();
            });
        },

        async deleteFilter(filter) {
            if (!confirm(`Delete filter "${filter.name}"?`)) return;

            try {
                const result = await apiClient.deleteFilter(filter.id);
                if (result.success) {
                    await this.refreshFilters();
                    if (this.selectedView.type === 'filter' && this.selectedView.id === filter.id) {
                        this.selectBuiltin('next');
                    }
                } else {
                    this.showToast(result.error || 'Failed to delete filter', 'error');
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error');
            }
        },

        onFilterDragStart(filter) {
            this.draggedFilterId = filter.id;
        },

        async onFilterDrop(targetFilter) {
            if (!this.draggedFilterId || this.draggedFilterId === targetFilter.id) return;

            const current = this.filters.slice();
            const fromIndex = current.findIndex((f) => f.id === this.draggedFilterId);
            const toIndex = current.findIndex((f) => f.id === targetFilter.id);
            if (fromIndex === -1 || toIndex === -1) return;

            const [moved] = current.splice(fromIndex, 1);
            current.splice(toIndex, 0, moved);

            this.filters = current;
            this.draggedFilterId = null;

            try {
                const ids = current.map((f) => f.id);
                const result = await apiClient.reorderFilters(ids);
                if (!result.success) {
                    this.showToast(result.error || 'Failed to reorder', 'error');
                    await this.refreshFilters();
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error');
                await this.refreshFilters();
            }
        },

        openCommandModal(type) {
            this.modal = { open: true, type, value: '', output: '', taskId: null, filterId: null, filterName: '', filterValue: '' };
            if (type === 'exec') this.showTaskrc = false;
            this.resetCompletion();
            this.$nextTick(() => {
                const input = this.$refs.modalInput;
                if (input) input.focus();
            });
        },

        closeModal() {
            this.modal.open = false;
            this.modal.type = null;
            this.modal.value = '';
            this.modal.output = '';
            this.modal.taskId = null;
            this.modal.filterId = null;
            this.modal.filterName = '';
            this.modal.filterValue = '';
            this.modal.description = '';
            this.modal.project = '';
            this.modal.tags = '';
            this.modal.priority = '';
            this.modal.due = '';
            this.modal.showTaskDetails = false;
            this.modal.taskDetailsOutput = '';
            this.modal.originalDescription = '';
            this.modal.originalProject = '';
            this.modal.originalTags = '';
            this.modal.originalPriority = '';
            this.modal.originalDue = '';
            this.modal.activeAttributeDropdown = null;
            this.modal.attributeInputValue = '';
            this.resetCompletion();
        },

        toggleAttributeDropdown(attributeName) {
            if (this.modal.activeAttributeDropdown === attributeName) {
                this.modal.activeAttributeDropdown = null;
                this.modal.attributeInputValue = '';
                this.resetCompletion();
            } else {
                this.modal.activeAttributeDropdown = attributeName;
                this.modal.attributeInputValue = this.modal[attributeName] || '';
                this.resetCompletion();
                this.$nextTick(() => {
                    const input = this.$refs.attributeInput;
                    if (input) {
                        input.focus();
                        // Trigger initial completion
                        const event = { target: input };
                        this.handleAttributeInput(event);
                    }
                });
            }
        },

        clearAttribute(attributeName) {
            this.modal[attributeName] = '';
            if (this.modal.activeAttributeDropdown === attributeName) {
                this.modal.activeAttributeDropdown = null;
                this.modal.attributeInputValue = '';
                this.resetCompletion();
            }
        },

        getAttributePlaceholder(attributeName) {
            const placeholders = {
                due: 'e.g., tomorrow, eom, 2024-12-31',
                priority: 'H, M, L',
                project: 'Select or type project name',
                tags: 'Add tags (comma separated)'
            };
            return placeholders[attributeName] || '';
        },

        async handleAttributeKeydown(event) {
            const inputEl = event.target;
            if (!inputEl) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                this.modal.activeAttributeDropdown = null;
                this.modal.attributeInputValue = '';
                this.resetCompletion();
                return;
            }

            if (event.key === 'Enter') {
                event.preventDefault();
                if (this.completion.visible && this.completion.suggestions.length > 0) {
                    const suggestion = this.completion.suggestions[this.completion.selectedIndex];
                    if (suggestion) {
                        this.selectAttributeSuggestion(suggestion);
                    }
                } else {
                    // Apply the current value
                    this.modal[this.modal.activeAttributeDropdown] = this.modal.attributeInputValue;
                    this.modal.activeAttributeDropdown = null;
                    this.modal.attributeInputValue = '';
                    this.resetCompletion();
                }
                return;
            }

            const completionKeys = ['Tab', 'ArrowDown', 'ArrowUp'];
            if (!completionKeys.includes(event.key)) return;

            const text = String(this.modal.attributeInputValue || '');
            const cursor = inputEl.selectionStart;
            const tokenInfo = getTokenAtCursor(text, cursor);

            await this.updateAttributeCompletion(this.modal.activeAttributeDropdown, tokenInfo);

            if (this.completion.suggestions.length === 0) return;

            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                this.completion.visible = true;
                const delta = event.key === 'ArrowDown' ? 1 : -1;
                const count = this.completion.suggestions.length;
                this.completion.selectedIndex = (this.completion.selectedIndex + delta + count) % count;
                return;
            }

            if (event.key === 'Tab') {
                event.preventDefault();
                if (this.completion.suggestions.length === 1) {
                    this.selectAttributeSuggestion(this.completion.suggestions[0]);
                } else {
                    this.completion.visible = true;
                }
            }
        },

        async handleAttributeInput(event) {
            const inputEl = event.target;
            if (!inputEl || typeof inputEl.selectionStart !== 'number') {
                this.resetCompletion();
                return;
            }

            const text = String(this.modal.attributeInputValue || '');
            const cursor = inputEl.selectionStart;
            const tokenInfo = getTokenAtCursor(text, cursor);

            await this.updateAttributeCompletion(this.modal.activeAttributeDropdown, tokenInfo);
        },

        handleAttributeBlur() {
            // Small delay to allow clicking on suggestions
            setTimeout(() => {
                if (this.modal.activeAttributeDropdown && this.modal.attributeInputValue !== undefined) {
                    this.modal[this.modal.activeAttributeDropdown] = this.modal.attributeInputValue;
                    this.modal.activeAttributeDropdown = null;
                    this.modal.attributeInputValue = '';
                    this.resetCompletion();
                }
            }, 200);
        },

        selectAttributeSuggestion(suggestion) {
            if (!this.modal.activeAttributeDropdown) return;
            
            this.modal[this.modal.activeAttributeDropdown] = suggestion;
            this.modal.activeAttributeDropdown = null;
            this.modal.attributeInputValue = '';
            this.resetCompletion();
        },

        async updateAttributeCompletion(attributeName, tokenInfo) {
            const token = tokenInfo.token || '';
            
            if (attributeName === 'project') {
                const result = await apiClient.complete(`project:${token}`);
                const suggestions = result && result.success && Array.isArray(result.suggestions) ? result.suggestions : [];
                const projectSuggestions = suggestions.map(s => s.replace(/^project:/, ''));
                
                if (projectSuggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                this.completion = {
                    field: 'modal.attributeInputValue',
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions: projectSuggestions,
                    selectedIndex: 0,
                    visible: true,
                };
                return projectSuggestions;
            }
            
            if (attributeName === 'tags') {
                const result = await apiClient.complete(`+${token}`);
                const suggestions = result && result.success && Array.isArray(result.suggestions) ? result.suggestions : [];
                const tagSuggestions = suggestions.map(s => s.replace(/^\+/, ''));
                
                if (tagSuggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                this.completion = {
                    field: 'modal.attributeInputValue',
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions: tagSuggestions,
                    selectedIndex: 0,
                    visible: true,
                };
                return tagSuggestions;
            }
            
            if (attributeName === 'priority') {
                const priorities = ['H', 'M', 'L'];
                const suggestions = priorities.filter(p => p.toLowerCase().startsWith(token.toLowerCase()));
                
                if (suggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                this.completion = {
                    field: 'modal.attributeInputValue',
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions,
                    selectedIndex: 0,
                    visible: true,
                };
                return suggestions;
            }
            
            if (attributeName === 'due') {
                const dueSuggestions = ['today', 'tomorrow', 'eom', 'eoy', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
                const suggestions = dueSuggestions.filter(d => d.startsWith(token.toLowerCase()));
                
                if (suggestions.length === 0) {
                    this.resetCompletion();
                    return [];
                }
                
                this.completion = {
                    field: 'modal.attributeInputValue',
                    token,
                    start: tokenInfo.start,
                    end: tokenInfo.end,
                    suggestions,
                    selectedIndex: 0,
                    visible: true,
                };
                return suggestions;
            }

            this.resetCompletion();
            return [];
        },

        async submitModal() {
            const type = this.modal.type;

            if (type === 'add') {
                const description = String(this.modal.description || '').trim();
                if (!description) return;
                
                // Build task command from structured fields
                let taskCommand = description;
                
                if (this.modal.project) {
                    taskCommand += ` project:${this.modal.project}`;
                }
                
                if (this.modal.tags) {
                    const tags = this.modal.tags.split(',').map(t => t.trim()).filter(t => t);
                    tags.forEach(tag => {
                        taskCommand += ` +${tag}`;
                    });
                }
                
                if (this.modal.priority) {
                    taskCommand += ` priority:${this.modal.priority}`;
                }
                
                if (this.modal.due) {
                    taskCommand += ` due:${this.modal.due}`;
                }
                
                const result = await commandService.addTask(taskCommand);
                if (result.success) {
                    this.showToast('Added task', 'success');
                    this.closeModal();
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to add', 'error');
                }
                return;
            }

            if (type === 'edit') {
                const taskId = this.modal.taskId;
                if (!taskId) return;
                
                // Build modification command from structured fields
                const parts = [];
                
                // Only update description if it changed
                if (this.modal.description !== this.modal.originalDescription) {
                    if (this.modal.description) {
                        parts.push(this.modal.description);
                    }
                }
                
                if (this.modal.project !== this.modal.originalProject) {
                    if (this.modal.project) {
                        parts.push(`project:${this.modal.project}`);
                    } else {
                        parts.push('project:');
                    }
                }
                
                if (this.modal.priority !== this.modal.originalPriority) {
                    if (this.modal.priority) {
                        parts.push(`priority:${this.modal.priority}`);
                    } else {
                        parts.push('priority:');
                    }
                }
                
                if (this.modal.due !== this.modal.originalDue) {
                    if (this.modal.due) {
                        parts.push(`due:${this.modal.due}`);
                    } else {
                        parts.push('due:');
                    }
                }
                
                if (this.modal.tags !== this.modal.originalTags) {
                    // Remove old tags and add new ones
                    const oldTags = (this.modal.originalTags || '').split(',').map(t => t.trim()).filter(t => t);
                    const newTags = (this.modal.tags || '').split(',').map(t => t.trim()).filter(t => t);
                    
                    oldTags.forEach(tag => {
                        if (!newTags.includes(tag)) {
                            parts.push(`-${tag}`);
                        }
                    });
                    
                    newTags.forEach(tag => {
                        if (!oldTags.includes(tag)) {
                            parts.push(`+${tag}`);
                        }
                    });
                }
                
                if (parts.length === 0) {
                    this.closeModal();
                    return;
                }
                
                const modifications = parts.join(' ');
                const result = await commandService.modifyTask(taskId, modifications);
                if (result.success) {
                    this.showToast('Updated task', 'success');
                    this.closeModal();
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to update task', 'error');
                }
                return;
            }

            if (type === 'exec') {
                const command = String(this.modal.value || '').trim();
                if (!command) return;

                const result = await commandService.executeCustom(command);
                if (result.success) {
                    const output = (result.output || '').trim();
                    const err = (result.error || '').trim();
                    const parts = [];
                    if (output) parts.push(output);
                    if (err) parts.push(err);
                    this.mainOutput = parts.length ? parts.join('\n') : 'OK';
                    this.mainMode = 'output';
                    this.closeModal();
                } else {
                    this.showToast(result.error || 'Failed to execute', 'error');
                }
                return;
            }

            if (type === 'search') {
                const term = String(this.modal.value || '').trim();
                if (!term) return;

                this.lastSearch = {
                    term,
                    pendingOnly: Boolean(this.searchPendingOnly),
                };

                const prefix = this.searchPendingOnly ? 'status:pending ' : '';
                this.mainMode = 'tasks';
                this.tasks = await queryService.getTasks(`${prefix}${term}`);
                this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                this.closeModal();
                return;
            }

            if (type === 'filter') {
                const name = String(this.modal.filterName || '').trim();
                const filter = String(this.modal.filterValue || '').trim();
                if (!name || !filter) return;

                try {
                    if (this.modal.filterId) {
                        const result = await apiClient.updateFilter(this.modal.filterId, { name, filter });
                        if (!result.success) {
                            this.showToast(result.error || 'Failed to update filter', 'error');
                            return;
                        }
                        await this.refreshFilters();
                        this.closeModal();
                        return;
                    }

                    const result = await apiClient.createFilter({ name, filter });
                    if (result.success) {
                        await this.refreshFilters();
                        this.closeModal();
                    } else {
                        this.showToast(result.error || 'Failed to create filter', 'error');
                    }
                } catch (error) {
                    this.showToast(String(error?.message || error), 'error');
                }
            }
        },

        async editTask(taskUuid) {
            const task = this.tasks.find((t) => String(t.uuid) === String(taskUuid));
            const currentDescription = task?.description ? String(task.description) : '';
            const currentProject = task?.project ? String(task.project) : '';
            const currentTags = Array.isArray(task?.tags) ? task.tags.join(', ') : '';
            const currentPriority = task?.priority ? String(task.priority) : '';
            const currentDue = task?.due ? String(task.due) : '';
            
            // Fetch full task details for the collapsible section
            let taskDetailsOutput = '';
            try {
                const result = await commandService.showTask(taskUuid);
                if (result.success) {
                    const output = (result.output || '').trim();
                    const err = (result.error || '').trim();
                    taskDetailsOutput = [output, err].filter(Boolean).join('\n') || 'No details available';
                }
            } catch (error) {
                taskDetailsOutput = 'Failed to load task details';
            }

            this.modal = {
                open: true,
                type: 'edit',
                value: currentDescription,
                output: '',
                taskId: taskUuid,
                filterId: null,
                filterName: '',
                filterValue: '',
                description: currentDescription,
                project: currentProject,
                tags: currentTags,
                priority: currentPriority,
                due: currentDue,
                showTaskDetails: false,
                taskDetailsOutput: taskDetailsOutput,
                // Store original values for comparison
                originalDescription: currentDescription,
                originalProject: currentProject,
                originalTags: currentTags,
                originalPriority: currentPriority,
                originalDue: currentDue,
            };

            this.resetCompletion();
            this.$nextTick(() => {
                const input = this.$refs.modalInput;
                if (input) {
                    input.focus();
                    try {
                        const len = String(this.modal.description || '').length;
                        input.setSelectionRange(len, len);
                    } catch {
                        // ignore
                    }
                }
            });
        },

        async withBusyTask(taskUuid, fn) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            if (this.busyTaskUuids[uuid]) return;
            this.busyTaskUuids = { ...this.busyTaskUuids, [uuid]: true };

            try {
                await fn();
            } finally {
                const next = { ...this.busyTaskUuids };
                delete next[uuid];
                this.busyTaskUuids = next;
            }
        },

        async toggleTaskDone(task, event) {
            const uuid = String(task?.uuid || '').trim();
            if (!uuid) return;

            const checkbox = event?.target;
            const desiredChecked = Boolean(checkbox?.checked);
            const wasCompleted = String(task?.status || '') === 'completed';

            if (desiredChecked === wasCompleted) return;

            const previousChecked = wasCompleted;

            await this.withBusyTask(uuid, async () => {
                let result;
                if (desiredChecked) {
                    result = await commandService.completeTask(uuid);
                } else {
                    result = await commandService.markPending(uuid);
                }

                if (result.success) {
                    this.showToast(desiredChecked ? 'Marked done' : 'Marked pending', 'success');
                    await this.refreshCurrentPanel();
                } else {
                    if (checkbox) checkbox.checked = previousChecked;
                    this.showToast(result.error || 'Failed to update task', 'error');
                }
            });
        },

        async showTask(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.showTask(uuid);
                if (result.success) {
                    const output = (result.output || '').trim();
                    const err = (result.error || '').trim();
                    const text = [output, err].filter(Boolean).join('\n') || 'OK';

                    this.modal = {
                        open: true,
                        type: 'show',
                        value: '',
                        output: text,
                        taskId: uuid,
                        filterId: null,
                        filterName: '',
                        filterValue: '',
                    };
                } else {
                    this.showToast(result.error || 'Failed to load task', 'error');
                }
            });
        },

        async deleteTask(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            if (!confirm(`Delete task ${uuid}?`)) return;

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.deleteTask(uuid);
                if (result.success) {
                    this.showToast('Deleted task', 'success');
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to delete task', 'error');
                }
            });
        },

        formatDate(dateStr) {
            const raw = String(dateStr || '').trim();
            if (!raw) return '';

            let normalized = raw;

            const zuluMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
            if (zuluMatch) {
                const [, year, month, day, hour, minute, second] = zuluMatch;
                normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
            }

            const localMatch = raw.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/);
            if (localMatch) {
                const [, year, month, day, hour, minute, second] = localMatch;
                normalized = `${year}-${month}-${day}T${hour}:${minute}:${second}`;
            }

            const dateOnlyMatch = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
            if (dateOnlyMatch) {
                const [, year, month, day] = dateOnlyMatch;
                normalized = `${year}-${month}-${day}`;
            }

            const date = new Date(normalized);
            if (Number.isNaN(date.getTime())) return '';

            return date.toLocaleDateString();
        },

        formatUrgency(value) {
            const num = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(num)) return '';
            return num.toFixed(2);
        },

        getTaskUrgency(task) {
            const status = String(task?.status || '').toLowerCase();
            if (status === 'completed' || status === 'deleted') return 0;

            const num = typeof task?.urgency === 'number' ? task.urgency : Number(task?.urgency);
            return Number.isFinite(num) ? num : 0;
        },


        async loadTaskrc() {
            try {
                const response = await fetch('/api/taskrc');
                if (!response.ok) throw new Error(await response.text());
                const text = await response.text();
                this.taskrcText = text;
                this.loadedTaskrcText = text;
            } catch (error) {
                this.showToast(`Error loading taskrc: ${error.message}`, 'error');
            }
        },

        async saveTaskrc() {
            try {
                const response = await fetch('/api/taskrc', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: this.taskrcText,
                });
                if (!response.ok) throw new Error(await response.text());
                this.loadedTaskrcText = this.taskrcText;
                this.showToast('Saved taskrc', 'success');
            } catch (error) {
                this.showToast(`Error saving taskrc: ${error.message}`, 'error');
            }
        },
    },
}).mount('#app');
