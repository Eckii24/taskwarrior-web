function jsonResponse(payload, init = {}) {
    const status = init.status || 200;
    return {
        ok: status >= 200 && status < 300,
        status,
        async json() {
            return payload;
        },
        async text() {
            return typeof payload === 'string' ? payload : JSON.stringify(payload);
        },
    };
}

function stripOuterQuotes(text) {
    const raw = String(text || '');
    if (raw.length >= 2) {
        const first = raw[0];
        const last = raw[raw.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return raw.slice(1, -1);
        }
    }
    return raw;
}

function parseShellLikeArgs(input) {
    const text = String(input || '');
    const tokens = [];

    let current = '';
    let quote = null;
    let escaped = false;

    for (const ch of text) {
        if (escaped) {
            current += ch;
            escaped = false;
            continue;
        }

        if (ch === '\\') {
            escaped = true;
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
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += ch;
    }

    if (current) tokens.push(current);
    return tokens;
}

function looksLikeAttributeToken(token) {
    const t = String(token || '');
    if (!t) return false;
    if (t.startsWith('+') || t.startsWith('-')) return true;
    if (t.startsWith('project:')) return true;
    if (t.startsWith('priority:')) return true;
    if (t.startsWith('due:')) return true;
    if (t.startsWith('status:')) return true;
    if (t.startsWith('limit:')) return true;
    return false;
}

function applyTaskModifications(task, tokens) {
    const list = Array.isArray(tokens) ? tokens : [];

    const descriptionTokens = [];
    let i = 0;
    for (; i < list.length; i++) {
        if (looksLikeAttributeToken(list[i])) break;
        descriptionTokens.push(list[i]);
    }

    if (descriptionTokens.length) {
        task.description = descriptionTokens.join(' ');
    }

    const ensureTags = () => {
        if (!Array.isArray(task.tags)) task.tags = [];
    };

    for (; i < list.length; i++) {
        const token = list[i];
        if (token.startsWith('project:')) {
            const value = token.slice('project:'.length);
            if (value) task.project = value;
            else delete task.project;
        } else if (token.startsWith('priority:')) {
            const value = token.slice('priority:'.length);
            if (value) task.priority = value;
            else delete task.priority;
        } else if (token.startsWith('due:')) {
            const valueRaw = token.slice('due:'.length);
            const value = String(valueRaw || '').trim();
            if (value) task.due = value;
            else delete task.due;
        } else if (token.startsWith('+')) {
            const tag = token.slice(1);
            if (!tag) continue;
            ensureTags();
            if (!task.tags.includes(tag)) task.tags.push(tag);
        } else if (token.startsWith('-')) {
            const tag = token.slice(1);
            if (!tag) continue;
            ensureTags();
            task.tags = task.tags.filter((t) => t !== tag);
        }
    }

    return task;
}

function tokenizeFilterExpression(expression) {
    const raw = String(expression || '').trim();
    if (!raw) return [];
    return parseShellLikeArgs(raw);
}

function taskMatchesTokens(task, tokens) {
    const list = Array.isArray(tokens) ? tokens : [];

    let status = null;
    let project = null;
    const requiredTags = [];
    const forbiddenTags = [];
    const terms = [];

    for (const token of list) {
        if (!token) continue;
        if (token === 'export') continue;
        if (token.startsWith('status:')) {
            status = token.slice('status:'.length);
            continue;
        }
        if (token.startsWith('project:')) {
            project = token.slice('project:'.length);
            continue;
        }
        if (token.startsWith('+')) {
            requiredTags.push(token.slice(1));
            continue;
        }
        if (token.startsWith('-')) {
            forbiddenTags.push(token.slice(1));
            continue;
        }
        if (token.startsWith('limit:')) {
            continue;
        }
        terms.push(token);
    }

    const taskStatus = String(task?.status || '').toLowerCase();
    if (status) {
        if (String(status).toLowerCase() !== taskStatus) return false;
    }

    if (project) {
        if (String(task?.project || '') !== String(project)) return false;
    }

    const tagSet = new Set(Array.isArray(task?.tags) ? task.tags : []);
    for (const tag of requiredTags) {
        if (tag && !tagSet.has(tag)) return false;
    }
    for (const tag of forbiddenTags) {
        if (tag && tagSet.has(tag)) return false;
    }

    if (terms.length) {
        const haystack = `${task?.description || ''}`.toLowerCase();
        for (const term of terms) {
            if (!haystack.includes(String(term).toLowerCase())) return false;
        }
    }

    return true;
}

function createMockBackend() {
    const state = {
        tasks: [],
        filters: [],
        taskrc: '# taskrc\n',
        nextTaskId: 1,
        nextFilterId: 1,
        nextAnnotationId: 1,

        // Optional test hooks.
        // If provided, it may return a Response-like object to short-circuit handling.
        beforeFetch: null,
    };

    const fetchImpl = async (url, init = {}) => {
        const href = typeof url === 'string' ? url : url.toString();
        const parsed = new URL(href, 'http://localhost');
        const pathname = parsed.pathname;
        const method = String(init.method || 'GET').toUpperCase();

        if (typeof state.beforeFetch === 'function') {
            const override = await state.beforeFetch({ href, parsed, pathname, method, init });
            if (override) return override;
        }

        if (pathname === '/api/filters' && method === 'GET') {
            return jsonResponse({ success: true, filters: state.filters.slice() });
        }

        if (pathname === '/api/filters' && method === 'POST') {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            const filter = {
                id: state.nextFilterId++,
                name: body.name,
                filter: body.filter,
                order: state.filters.length,
            };
            state.filters.push(filter);
            return jsonResponse({ success: true, filter });
        }

        if (pathname === '/api/filters/reorder' && method === 'PUT') {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            const ids = Array.isArray(body.ids) ? body.ids.map((n) => Number(n)) : [];

            const byId = new Map(state.filters.map((f) => [Number(f.id), f]));
            const used = new Set();

            const reordered = [];
            let order = 0;

            for (const idInput of ids) {
                const id = Number(idInput);
                const existing = byId.get(id);
                if (!existing) continue;
                used.add(id);
                reordered.push({ ...existing, id, order: order++ });
            }

            for (const filter of state.filters) {
                const id = Number(filter.id);
                if (used.has(id)) continue;
                reordered.push({ ...filter, id, order: order++ });
            }

            state.filters = reordered;
            return jsonResponse({ success: true });
        }

        if (pathname.startsWith('/api/filters/') && method === 'PUT') {
            const id = Number(pathname.split('/').pop());
            const body = init.body ? JSON.parse(String(init.body)) : {};
            const idx = state.filters.findIndex((f) => f.id === id);
            if (idx === -1) return jsonResponse({ success: false, error: 'not found' }, { status: 404 });
            state.filters[idx] = {
                ...state.filters[idx],
                name: body.name ?? state.filters[idx].name,
                filter: body.filter ?? state.filters[idx].filter,
            };
            return jsonResponse({ success: true, filter: state.filters[idx] });
        }

        if (pathname.startsWith('/api/filters/') && method === 'DELETE') {
            const id = Number(pathname.split('/').pop());
            state.filters = state.filters.filter((f) => f.id !== id);
            return jsonResponse({ success: true });
        }

        if (pathname === '/api/taskrc' && method === 'GET') {
            return {
                ok: true,
                status: 200,
                async text() {
                    return state.taskrc;
                },
            };
        }

        if (pathname === '/api/taskrc' && method === 'PUT') {
            state.taskrc = String(init.body || '');
            return {
                ok: true,
                status: 200,
                async text() {
                    return 'OK';
                },
            };
        }

        if (pathname === '/api/complete' && method === 'GET') {
            const token = String(parsed.searchParams.get('token') || '');
            const normalized = token.toLowerCase();

            const uniq = (arr) => Array.from(new Set(arr)).filter(Boolean);

            const projects = uniq(state.tasks.map((t) => t.project).filter(Boolean));
            const tags = uniq(state.tasks.flatMap((t) => (Array.isArray(t.tags) ? t.tags : [])));

            let suggestions = [];

            if (normalized.startsWith('project:')) {
                const prefix = token.slice('project:'.length);
                suggestions = projects
                    .filter((p) => String(p).toLowerCase().startsWith(String(prefix).toLowerCase()))
                    .map((p) => `project:${p}`);
            } else if (normalized.startsWith('due:')) {
                const prefix = token.slice('due:'.length);
                const dueKeywords = ['today', 'tomorrow', 'eom', 'eow', 'eoy', 'sonw'];
                suggestions = dueKeywords
                    .filter((k) => k.toLowerCase().startsWith(String(prefix).toLowerCase()))
                    .map((k) => `due:${k}`);
            } else if (token.startsWith('+')) {
                const prefix = token.slice(1);
                suggestions = tags
                    .filter((t) => String(t).toLowerCase().startsWith(String(prefix).toLowerCase()))
                    .map((t) => `+${t}`);
            } else {
                // A few generic field suggestions.
                const generic = ['project:', 'due:', 'status:pending', 'status:completed', '+'];
                suggestions = generic.filter((g) => g.toLowerCase().startsWith(normalized));
            }

            return jsonResponse({ success: true, token, suggestions, values: suggestions });
        }

        if (pathname === '/api/task' && method === 'POST') {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            const args = String(body.args || '').trim();
            const tokens = parseShellLikeArgs(args);

            if (!tokens.length) {
                return jsonResponse({ success: false, output: '', error: 'Missing args' }, { status: 400 });
            }

            if (tokens[0] === 'sync') {
                return jsonResponse({ success: true, output: 'Sync OK\n', error: '' });
            }

            if (tokens[0] === 'add') {
                const addTokens = tokens.slice(1);
                const uuid = `uuid-${state.nextTaskId++}`;
                const task = {
                    uuid,
                    description: '',
                    status: 'pending',
                    urgency: 0,
                    tags: [],
                };

                applyTaskModifications(task, addTokens);
                if (!task.description) {
                    task.description = addTokens.join(' ').trim();
                }

                state.tasks.push(task);
                return jsonResponse({ success: true, output: `Created task ${uuid}.\n`, error: '' });
            }

            if (tokens[tokens.length - 1] === 'export') {
                // Special-case "<uuid> export" used for annotations refresh.
                if (tokens.length === 2) {
                    const uuid = tokens[0];
                    const taskIdx = state.tasks.findIndex((t) => t.uuid === uuid);
                    if (taskIdx !== -1) {
                        return jsonResponse({ success: true, output: JSON.stringify([state.tasks[taskIdx]]), error: '' });
                    }
                }

                // Filtered export (best-effort) used by UI.
                const filterTokens = tokens.slice(0, -1);
                const matching = state.tasks.filter((t) => taskMatchesTokens(t, filterTokens));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
            }

            // Everything else is either "uuid <cmd> ..." or a raw exec command.
            const first = tokens[0];
            const taskIdx = state.tasks.findIndex((t) => t.uuid === first);
            if (taskIdx === -1) {
                // Unknown command path: allow tests to validate output view.
                return jsonResponse({ success: true, output: `Executed: ${args}\n`, error: '' });
            }

            const cmd = tokens[1] || '';

            if (!cmd) {
                const task = state.tasks[taskIdx];
                const lines = [
                    `UUID: ${task.uuid}`,
                    `Description: ${task.description || ''}`,
                    `Status: ${task.status || ''}`,
                ];
                if (task.project) lines.push(`Project: ${task.project}`);
                if (task.priority) lines.push(`Priority: ${task.priority}`);
                if (task.due) lines.push(`Due: ${task.due}`);
                if (Array.isArray(task.tags) && task.tags.length) lines.push(`Tags: ${task.tags.join(',')}`);
                return jsonResponse({ success: true, output: `${lines.join('\n')}\n`, error: '' });
            }

            if (cmd === 'done') {
                state.tasks[taskIdx] = { ...state.tasks[taskIdx], status: 'completed' };
                return jsonResponse({ success: true, output: 'Completed\n', error: '' });
            }

            if (cmd === 'delete') {
                state.tasks.splice(taskIdx, 1);
                return jsonResponse({ success: true, output: 'Deleted\n', error: '' });
            }

            if (cmd === 'modify') {
                const modifications = tokens.slice(2);
                const task = { ...state.tasks[taskIdx] };
                applyTaskModifications(task, modifications);
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Modified\n', error: '' });
            }

            if (cmd === 'mod') {
                const rest = tokens.slice(2);
                if (rest.some((t) => t.toLowerCase() === 'status:pending')) {
                    state.tasks[taskIdx] = { ...state.tasks[taskIdx], status: 'pending' };
                    return jsonResponse({ success: true, output: 'Modified\n', error: '' });
                }
                return jsonResponse({ success: true, output: 'OK\n', error: '' });
            }

            if (cmd === 'annotate') {
                const text = stripOuterQuotes(tokens.slice(2).join(' ')).trim();
                if (!text) return jsonResponse({ success: false, output: '', error: 'Missing annotation' }, { status: 400 });

                const task = { ...state.tasks[taskIdx] };
                const annotations = Array.isArray(task.annotations) ? task.annotations.slice() : [];
                annotations.push({ entry: `anno-${state.nextAnnotationId++}`, description: text });
                task.annotations = annotations;
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Annotated\n', error: '' });
            }

            if (cmd === 'denotate') {
                const pattern = stripOuterQuotes(tokens.slice(2).join(' ')).trim();
                const task = { ...state.tasks[taskIdx] };
                const annotations = Array.isArray(task.annotations) ? task.annotations.slice() : [];
                task.annotations = annotations.filter((a) => String(a.description) !== pattern);
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Denotated\n', error: '' });
            }

            if (cmd === 'export') {
                const task = state.tasks[taskIdx];
                return jsonResponse({ success: true, output: JSON.stringify([task]), error: '' });
            }

            return jsonResponse({ success: true, output: `OK: ${args}\n`, error: '' });
        }

        return jsonResponse({ success: false, error: `Unhandled ${method} ${pathname}` }, { status: 500 });
    };

    return { state, fetchImpl };
}

module.exports = {
    createMockBackend,
};
