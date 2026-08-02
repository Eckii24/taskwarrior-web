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

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

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
            const previous = current[current.length - 1] || '';
            if (ch === "'" && /[a-zA-Z0-9]/.test(previous)) {
                current += ch;
                continue;
            }

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

    if (escaped) current += '\\';
    if (current) tokens.push(current);
    return tokens;
}

function looksLikeAttributeToken(token) {
    const t = String(token || '');
    if (!t) return false;
    if (t.startsWith('+') || t.startsWith('-')) return true;
    if (t.includes(':')) return true;
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
        const token = String(list[i] || '');
        if (token.startsWith('+')) {
            const tag = token.slice(1);
            if (!tag) continue;
            ensureTags();
            if (!task.tags.includes(tag)) task.tags.push(tag);
            continue;
        }

        if (token.startsWith('-')) {
            const tag = token.slice(1);
            if (!tag) continue;
            ensureTags();
            task.tags = task.tags.filter((t) => t !== tag);
            continue;
        }

        const attrMatch = token.match(/^([^:]+):(.*)$/);
        if (!attrMatch) continue;

        const attr = attrMatch[1];
        const value = String(attrMatch[2] || '').trim();

        if (!value) {
            delete task[attr];
            continue;
        }

        task[attr] = value;
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
    let due = null;
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
        if (token.startsWith('due:')) {
            due = token.slice('due:'.length);
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

        // Built-in views (today/next/all) are treated as Taskwarrior reports.
        // When exported they should not affect filtering here.
        if (token === 'today' || token === 'next' || token === 'all') {
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

    if (due) {
        // Best-effort: treat due tokens as string equality.
        if (String(task?.due || '') !== String(due)) return false;
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
        builtinFilters: {
            today: { key: 'today', name: 'Today', filter: 'due:today status:pending', visible: true, group_by: null },
            inbox: { key: 'inbox', name: 'Inbox', filter: 'status:pending project:', visible: true, group_by: null },
            next: { key: 'next', name: 'Next', filter: '', visible: true, group_by: null },
            all: { key: 'all', name: 'All', filter: '', visible: true, group_by: null },
        },
         reports: ['next', 'today', 'all'],
        settings: {
            reschedule_field: 'due',
            planner_date_field: 'due',
            planner_days: 5,
        },
        taskrc: '# taskrc\n',
        nextTaskId: 1,
        nextFilterId: 1,
        nextAnnotationId: 1,

        taskConfig: {},

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

        if (pathname === '/api/settings' && method === 'GET') {
            return jsonResponse({ success: true, settings: { ...state.settings } });
        }

        if (pathname === '/api/settings' && method === 'PUT') {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            if (typeof body.reschedule_field !== 'string' || !String(body.reschedule_field).trim()) {
                return jsonResponse({ success: false, error: 'reschedule_field must include at least one value' }, { status: 400 });
            }

            const normalize = (value) => String(value).trim() === 'schedule' ? 'scheduled' : String(value).trim();
            const allowed = new Set(['due', 'scheduled', 'wait', 'until']);
            const requested = String(body.reschedule_field)
                .split(',')
                .map(normalize)
                .filter(Boolean);

            if (requested.length === 0) {
                return jsonResponse({ success: false, error: 'reschedule_field must include at least one value' }, { status: 400 });
            }

            for (const field of requested) {
                if (!allowed.has(field)) {
                    return jsonResponse({ success: false, error: 'reschedule_field contains invalid values' }, { status: 400 });
                }
            }

            const plannerDateField = normalize(body.planner_date_field || requested[0]);
            const plannerDays = body.planner_days === undefined ? 5 : Number(body.planner_days);
            if (!allowed.has(plannerDateField) || (plannerDays !== 5 && plannerDays !== 7)) {
                return jsonResponse({ success: false, error: 'invalid planner settings' }, { status: 400 });
            }
            state.settings.reschedule_field = Array.from(new Set(requested)).join(',');
            state.settings.planner_date_field = plannerDateField;
            state.settings.planner_days = plannerDays;
            return jsonResponse({ success: true, settings: { ...state.settings } });
        }

        if (pathname === '/api/builtin-filters' && method === 'GET') {
            const filters = Object.values(state.builtinFilters)
                .map((entry) => ({
                    key: entry.key,
                    name: entry.name,
                    filter: entry.filter,
                    visible: entry.visible ? 1 : 0,
                    group_by: entry.group_by ?? null,
                }));
            return jsonResponse({ success: true, filters });
        }

        if (pathname.startsWith('/api/builtin-filters/') && method === 'PUT') {
            const key = String(pathname.split('/').pop() || '').trim();
            if (!key || !state.builtinFilters[key]) {
                return jsonResponse({ success: false, error: 'not found' }, { status: 404 });
            }

            const body = init.body ? JSON.parse(String(init.body)) : {};
            const existing = state.builtinFilters[key];

            const next = {
                ...existing,
                // name/filter come from taskrc reports and are treated as read-only.
                visible: body.visible !== undefined ? Boolean(body.visible) : existing.visible,
                group_by: body.group_by !== undefined ? String(body.group_by || '').trim() || null : existing.group_by,
            };

            state.builtinFilters[key] = next;
            return jsonResponse({ success: true, filter: { ...next, visible: next.visible ? 1 : 0 } });
        }

            if (pathname === '/api/filters' && method === 'GET') {
                const filters = state.filters.slice().map((filter, idx) => ({
                    ...filter,
                    // Ensure reorder/edit tests get a stable order field.
                    order: filter.order ?? idx,
                }));
                return jsonResponse({ success: true, filters });
            }


        if (pathname === '/api/filters' && method === 'POST') {
            const body = init.body ? JSON.parse(String(init.body)) : {};
            const filter = {
                id: state.nextFilterId++,
                name: body.name,
                filter: body.filter,
                icon: body.icon ?? null,
                order: state.filters.length,
                group_by: body.group_by !== undefined ? String(body.group_by || '').trim() || null : null,
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
                icon: body.icon !== undefined ? body.icon : state.filters[idx].icon,
                group_by: body.group_by !== undefined ? String(body.group_by || '').trim() || null : state.filters[idx].group_by,
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

        if (pathname === '/api/reports' && method === 'GET') {
            return jsonResponse({
                success: true,
                reports: Array.isArray(state.reports) ? state.reports.slice() : [],
            });
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
            } else if (normalized.startsWith('status:')) {
                const prefix = token.slice('status:'.length);
                const statuses = ['pending', 'completed', 'deleted', 'waiting'];
                suggestions = statuses
                    .filter((value) => value.toLowerCase().startsWith(String(prefix).toLowerCase()))
                    .map((value) => `status:${value}`);
            } else if (token.startsWith('+')) {
                const prefix = token.slice(1);
                suggestions = tags
                    .filter((t) => String(t).toLowerCase().startsWith(String(prefix).toLowerCase()))
                    .map((t) => `+${t}`);
            } else {
                // A few generic field suggestions.
                const generic = ['project:', 'due:', 'status:', 'status:pending', 'status:completed', '+'];
                suggestions = generic.filter((g) => g.toLowerCase().startsWith(normalized));
            }

            return jsonResponse({ success: true, token, suggestions, values: suggestions });
        }

        if (pathname === '/api/task' && method === 'POST') {
            const body = init.body ? JSON.parse(String(init.body)) : {};

            const { args, tokens } = (() => {
                if (Array.isArray(body.args)) {
                    const rawTokens = body.args.map((value) => String(value));
                    return { args: rawTokens.join(' '), tokens: rawTokens };
                }

                const argsText = String(body.args || '').trim();

                // Support args that are already tokenized by tests.
                // Some jsdom environments stringify arrays as "a,b".
                if (argsText.includes(',') && !argsText.includes(' ')) {
                    const maybeTokens = argsText.split(',').map((value) => value.trim()).filter(Boolean);
                    if (maybeTokens.length > 1) {
                        return { args: maybeTokens.join(' '), tokens: maybeTokens };
                    }
                }

                return { args: argsText, tokens: parseShellLikeArgs(argsText) };
            })();

            while (tokens[0] === 'rc.recurrence.confirmation=no') tokens.shift();

            if (!tokens.length) {
                // Treat empty args like a plain "task" invocation.
                // The UI sometimes sends an empty string when it wants to do just "export".
                tokens.push('export');
            }

            if (tokens[0] === 'rc.hooks=0' && tokens[1] === '_get' && tokens[2] && String(tokens[2]).startsWith('rc.')) {
                const key = String(tokens[2]).slice('rc.'.length);
                const valueRaw = state.taskConfig[key];
                const value = valueRaw === undefined ? '' : String(valueRaw);
                return jsonResponse({ success: true, output: `${value}\n`, error: '' });
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

            if (tokens.length === 1 && tokens[0] === 'export') {
                const matching = state.tasks.filter((t) => taskMatchesTokens(t, []));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
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

            if (tokens.length === 2 && tokens[0] === 'export') {
                // "export <report>" (no filters) emitted by report mode.
                const matching = state.tasks.filter((t) => taskMatchesTokens(t, []));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
            }

            if (tokens[0] === 'export' && tokens.length >= 2) {
                const filterTokens = tokens.slice(1, -1);

                // Reports are used for output formatting in real Taskwarrior.
                // For tests, we behave like a filtered export regardless of report token.
                const matching = state.tasks.filter((t) => taskMatchesTokens(t, filterTokens));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
            }

            if (tokens.length >= 3 && tokens.includes('export')) {
                const exportIndex = tokens.indexOf('export');
                const filterTokens = tokens.slice(0, exportIndex);

                const matching = state.tasks.filter((t) => taskMatchesTokens(t, filterTokens));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
            }

            // Support "export <report>" (no filters) emitted by report mode.
            if (tokens.length === 2 && tokens[0] === 'export') {
                const matching = state.tasks.filter((t) => taskMatchesTokens(t, []));
                return jsonResponse({ success: true, output: JSON.stringify(matching), error: '' });
            }

            // Everything else is either "<uuid> <cmd> ...", "<uuids> mod ...", or a raw exec command.
            const first = tokens[0];

            // Support Taskwarrior's "<uuid...> mod ..." multi-task modifier.
            // Our UI uses this via TaskCommandService.modifyTasks().
            const modIndex = tokens.findIndex((value) => value === 'mod');
            if (modIndex > 0) {
                const uuids = tokens.slice(0, modIndex);
                const rest = tokens.slice(modIndex + 1);

                let modifiedCount = 0;
                for (const uuid of uuids) {
                    const idx = state.tasks.findIndex((t) => t.uuid === uuid);
                    if (idx === -1) continue;

                    const task = { ...state.tasks[idx] };
                    applyTaskModifications(task, rest);
                    state.tasks[idx] = task;
                    modifiedCount++;
                }

                return jsonResponse({ success: true, output: `Modified ${modifiedCount}\n`, error: '' });
            }

            const taskIdx = state.tasks.findIndex((t) => t.uuid === first);
            if (taskIdx === -1) {
                // Unknown command path: allow tests to validate output view.
                return jsonResponse({ success: true, output: `Executed: ${args}\n`, error: '' });
            }

            const cmd = tokens[1] || '';

            if (!cmd) {
                const task = state.tasks[taskIdx];
                return jsonResponse({ success: true, output: `UUID: ${task.uuid}\n`, error: '' });
            }

            if (cmd === 'done') {
                state.tasks[taskIdx] = { ...state.tasks[taskIdx], status: 'completed' };
                return jsonResponse({ success: true, output: 'Completed 1\n', error: '' });
            }

            if (cmd === 'delete') {
                // Simulate delete confirmations.
                state.tasks.splice(taskIdx, 1);
                return jsonResponse({ success: true, output: 'Deleted 1\n', error: '' });
            }

            if (cmd === 'annotate') {
                const annotation = tokens.slice(2).join(' ').trim();
                const task = { ...state.tasks[taskIdx] };
                const entry = `${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}-${state.nextAnnotationId++}`;

                if (!Array.isArray(task.annotations)) task.annotations = [];
                task.annotations = task.annotations.concat([{ entry, description: annotation }]);
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Annotated\n', error: '' });
            }

            if (cmd === 'denotate') {
                const description = tokens.slice(2).join(' ').trim();
                const task = { ...state.tasks[taskIdx] };
                if (Array.isArray(task.annotations)) {
                    task.annotations = task.annotations.filter((a) => a.description !== description);
                }
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Denotated\n', error: '' });
            }

            if (cmd === 'mod' || cmd === 'modify') {
                const rest = tokens.slice(2);
                const task = { ...state.tasks[taskIdx] };
                applyTaskModifications(task, rest);
                state.tasks[taskIdx] = task;
                return jsonResponse({ success: true, output: 'Modified 1\n', error: '' });
            }

            return jsonResponse({ success: true, output: `Executed: ${args}\n`, error: '' });
        }

        return jsonResponse({ success: false, error: 'not found' }, { status: 404 });
    };

    return { state, fetchImpl };
}

module.exports = { createMockBackend, parseShellLikeArgs, stripOuterQuotes, tokenizeFilterExpression };
