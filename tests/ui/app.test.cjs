const fs = require('fs');
const path = require('path');
const { createMockBackend } = require('./mockBackend.cjs');

function loadIndexHtml() {
    const htmlPath = path.join(__dirname, '..', '..', 'public', 'index.html');
    return fs.readFileSync(htmlPath, 'utf8');
}

async function flushPromises(vm, ticks = 1) {
    const count = Math.max(1, Number(ticks) || 1);
    for (let i = 0; i < count; i++) {
        await Promise.resolve();
        if (vm && typeof vm.$nextTick === 'function') {
            await vm.$nextTick();
        }
        await Promise.resolve();
    }
}

function mountWithBackend(backend) {
    const TaskwarriorWeb = require('../../public/app.js');
    const { vm } = TaskwarriorWeb.mountTaskwarriorApp({ element: '#app', fetchImpl: backend.fetchImpl });
    return { vm, TaskwarriorWeb };
}

describe('Taskwarrior Web UI (component-style)', () => {
    const originalTz = process.env.TZ;

    beforeAll(() => {
        // Ensure we run with a non-UTC timezone so Zulu timestamps
        // are validated against local rendering.
        process.env.TZ = 'Europe/Berlin';
    });

    afterAll(() => {
        process.env.TZ = originalTz;
    });

    beforeEach(() => {
        jest.useFakeTimers();
        document.documentElement.innerHTML = loadIndexHtml();

        // Reset URL between tests.
        window.history.replaceState({}, '', 'http://localhost/');
        jest.restoreAllMocks();
    });

    afterEach(() => {
        jest.runOnlyPendingTimers();
        jest.clearAllTimers();
        jest.useRealTimers();
    });

    function dispatchKey(el, key, opts = {}) {
        const event = {
            key,
            target: el,
            preventDefault: jest.fn(),
            stopPropagation: jest.fn(),
            ...opts,
        };
        return event;
    }

    test('mounts and loads initial tasks', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        expect(vm.tasks).toHaveLength(1);
        expect(Array.isArray(vm.taskGroups)).toBe(true);
        expect(document.body.textContent).toContain('Hello');
    });

    test('formats zulu timestamps in local timezone', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 3);

        // Berlin winter time: 23:00Z is 00:00 next day.
        expect(vm.formatDate('20251226T230000Z')).toBe('27.12.2025');
    });

    test('switches built-in view to All', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Pending', status: 'pending', urgency: 10 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Completed', status: 'completed', urgency: 1 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        expect(vm.selectedView).toEqual({ type: 'builtin', key: 'next' });
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-1']);

        vm.selectBuiltin('all');
        await flushPromises(vm, 5);

        expect(vm.tasks.map((t) => t.uuid).sort()).toEqual(['uuid-1', 'uuid-2']);
        expect(document.body.textContent).toContain('Completed');
    });

    test('opens add task modal from topbar plus button', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);

        await flushPromises(vm, 5);

        const addBtn = document.querySelector('header.topbar button[aria-label="Add task"]');
        expect(addBtn).toBeTruthy();

        addBtn.click();
        await flushPromises(vm, 2);

        expect(vm.modal.open).toBe(true);
        expect(vm.modal.type).toBe('add');
    });

    test('adds a task with attributes via modal submit', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);

        await flushPromises(vm, 5);

        vm.openAddTask();
        await flushPromises(vm, 1);

        vm.modal.description = 'Buy milk';
        vm.modal.project = 'Home';
        vm.modal.tags = 'groceries, urgent';
        vm.modal.priority = 'H';
        vm.modal.due = 'tomorrow';

        await vm.submitModal();
        await flushPromises(vm, 5);

        const added = vm.tasks.find((t) => String(t.description).includes('Buy milk'));
        expect(added).toBeTruthy();
        expect(added.project).toBe('Home');
        expect(Array.isArray(added.tags)).toBe(true);
        expect(added.tags.sort()).toEqual(['groceries', 'urgent']);
        expect(added.priority).toBe('H');
        expect(added.due).toBe('tomorrow');
    });

    test('edits a task (change and clear attributes)', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({
            uuid: 'uuid-1',
            description: 'Original',
            status: 'pending',
            urgency: 1,
            project: 'Home',
            tags: ['a', 'b'],
            priority: 'M',
            due: 'today',
        });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        await vm.editTask('uuid-1');
        await flushPromises(vm, 2);

        expect(vm.modal.type).toBe('edit');
        expect(vm.modal.taskId).toBe('uuid-1');
        expect(vm.modal.description).toBe('Original');

        vm.modal.description = 'Updated';
        vm.modal.project = '';
        vm.modal.priority = '';
        vm.modal.tags = 'b, c';
        vm.modal.due = '';

        await vm.submitModal();
        await flushPromises(vm, 5);

        const updated = vm.tasks.find((t) => t.uuid === 'uuid-1');
        expect(updated.description).toBe('Updated');
        expect(updated.project).toBeUndefined();
        expect(updated.priority).toBeUndefined();
        expect(updated.due).toBeUndefined();
        expect(updated.tags.sort()).toEqual(['b', 'c']);
    });

    test('completes and marks pending again', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        const task = vm.tasks[0];
        await vm.toggleTaskDone(task, { target: { checked: true } });
        await flushPromises(vm, 3);
        expect(vm.toast.text).toContain('Marked done');

        vm.selectBuiltin('all');
        await flushPromises(vm, 3);
        const completed = vm.tasks.find((t) => t.uuid === 'uuid-1');
        expect(completed.status).toBe('completed');

        await vm.toggleTaskDone(completed, { target: { checked: false } });
        await flushPromises(vm, 3);
        expect(vm.toast.text).toContain('Marked pending');
    });

    test('deletes a task (confirm)', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Delete me', status: 'pending', urgency: 1.5 });

        const confirmSpy = jest.spyOn(global, 'confirm').mockImplementation(() => true);

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        await vm.deleteTask('uuid-1');
        await flushPromises(vm, 5);

        expect(confirmSpy).toHaveBeenCalled();
        expect(backend.state.tasks).toHaveLength(0);
        expect(vm.toast.text).toContain('Deleted task');

        confirmSpy.mockRestore();
    });

    test('reschedules a task and clears reschedule field', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Due', status: 'pending', urgency: 1.5, due: 'today' });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.toggleReschedule('uuid-1');
        expect(vm.reschedule.open).toBe(true);

        await vm.applyReschedulePreset('uuid-1', 'tomorrow');
        await flushPromises(vm, 5);
        expect(vm.toast.text).toContain('Rescheduled task');
        expect(backend.state.tasks[0].due).toBe('tomorrow');

        vm.toggleReschedule('uuid-1');
        await vm.clearRescheduleField('uuid-1');
        await flushPromises(vm, 5);
        expect(vm.toast.text).toContain('Cleared due');
        expect(backend.state.tasks[0].due).toBeUndefined();
    });

    test('searches pending-only and includes completed', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'findme', status: 'pending', urgency: 1.5 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'findme done', status: 'completed', urgency: 1.5 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.selectSearch();
        await flushPromises(vm, 2);
        vm.modal.value = 'findme';
        vm.searchPendingOnly = true;
        await vm.submitModal();
        await flushPromises(vm, 4);

        expect(vm.selectedView.type).toBe('search');
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-1']);

        vm.selectSearch();
        await flushPromises(vm, 2);
        vm.modal.value = 'findme';
        vm.searchPendingOnly = false;
        await vm.submitModal();
        await flushPromises(vm, 4);

        expect(vm.tasks.map((t) => t.uuid).sort()).toEqual(['uuid-1', 'uuid-2']);
    });

    test('creates, edits, reorders, and deletes filters', async () => {
        const backend = createMockBackend();
        const fetchSpy = jest.fn(backend.fetchImpl);
        backend.fetchImpl = fetchSpy;

        const confirmSpy = jest.spyOn(global, 'confirm').mockImplementation(() => true);

        const { vm } = mountWithBackend(backend);
        const reloadSpy = jest.spyOn(vm, 'reloadAndReapplyCurrentView').mockImplementation(() => {});
        await flushPromises(vm, 5);

        vm.openAddFilter();
        vm.modal.filterName = 'Home';
        vm.modal.filterValue = 'project:Home status:pending';
        vm.modal.filterIcon = '🏠';
        await vm.submitModal();
        await flushPromises(vm, 3);

        vm.openAddFilter();
        vm.modal.filterName = 'Work';
        vm.modal.filterValue = 'project:Work status:pending';
        vm.modal.filterIcon = '💼';
        await vm.submitModal();
        await flushPromises(vm, 3);

        expect(vm.filters.map((f) => f.name)).toEqual(['Home', 'Work']);
        expect(vm.filters.map((f) => f.icon)).toEqual(['🏠', '💼']);
        expect(document.body.textContent).toContain('🏠');

        const homeFilterId = vm.filters[0].id;
        const workFilterId = vm.filters[1].id;
        expect(Number.isFinite(homeFilterId)).toBe(true);
        expect(Number.isFinite(workFilterId)).toBe(true);
        expect(homeFilterId).not.toBe(workFilterId);

        // Reorder: drag Work above Home (pass a minimal target object)
        vm.draggedFilterId = workFilterId;
        await vm.onFilterDrop({ id: homeFilterId });
        await flushPromises(vm, 3);

        // Ensure reorder endpoint was called
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/filters/reorder',
            expect.objectContaining({ method: 'PUT' }),
        );

        // Ensure order persists after refresh
        await vm.refreshFilters();
        await flushPromises(vm, 2);

        expect(vm.filters.map((f) => f.id)).toEqual([workFilterId, homeFilterId]);
        expect(vm.filters.map((f) => f.name)).toEqual(['Work', 'Home']);

        // Edit a non-active filter
        vm.openEditFilter(vm.filters[0]);
        vm.modal.filterName = 'Work2';
        vm.modal.filterIcon = '🧠';
        await vm.submitModal();
        await flushPromises(vm, 2);
        expect(vm.filters[0].name).toBe('Work2');
        expect(vm.filters[0].icon).toBe('🧠');

        // Edit active filter triggers reload
        vm.selectCustomFilter(vm.filters[0]);
        await flushPromises(vm, 3);
        vm.openEditFilter(vm.filters[0]);
        vm.modal.filterValue = 'project:Work status:pending';
        await vm.submitModal();
        expect(reloadSpy).toHaveBeenCalled();

        // Delete active filter returns to Next
        await vm.deleteFilter(vm.filters[0]);
        await flushPromises(vm, 3);
        expect(vm.selectedView).toEqual({ type: 'builtin', key: 'next' });

        confirmSpy.mockRestore();
        reloadSpy.mockRestore();
    });

    test('adds/edits/deletes annotations and shows details output', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5, project: 'Home' });

        const confirmSpy = jest.spyOn(global, 'confirm').mockImplementation(() => true);

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        await vm.editTask('uuid-1');
        await flushPromises(vm, 3);

        expect(String(vm.modal.taskDetailsOutput)).toContain('UUID: uuid-1');

        vm.modal.annotationDraft = 'note 1';
        await vm.addAnnotation();
        await flushPromises(vm, 3);
        expect(vm.toast.text).toContain('Added annotation');
        expect(vm.modal.annotations).toHaveLength(1);

        const anno = vm.modal.annotations[0];
        vm.startEditAnnotation(anno);
        vm.modal.annotationEditDraft = 'note 2';
        await vm.saveEditAnnotation(anno);
        await flushPromises(vm, 4);
        expect(vm.toast.text).toContain('Updated annotation');
        expect(vm.modal.annotations.some((a) => a.description === 'note 2')).toBe(true);

        const updatedAnno = vm.modal.annotations.find((a) => a.description === 'note 2');
        await vm.deleteAnnotation(updatedAnno);
        await flushPromises(vm, 3);
        expect(vm.toast.text).toContain('Deleted annotation');
        expect(vm.modal.annotations).toHaveLength(0);

        confirmSpy.mockRestore();
    });

    test('executes command and switches to output view', async () => {
        const backend = createMockBackend();

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.openCommandModal('exec');
        vm.modal.value = 'rc.color=off diagnostics';
        await vm.submitModal();
        await flushPromises(vm, 2);

        expect(vm.mainMode).toBe('output');
        expect(vm.mainOutput).toContain('Executed:');
        expect(vm.modal.open).toBe(false);
    });

    test('runs sync and displays toast', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 2);

        await vm.runSync();
        await flushPromises(vm, 2);

        expect(vm.toast.text).toContain('Sync OK');
    });

    test('completions return suggestions (project/due/tags)', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5, project: 'Home', tags: ['groceries'] });

        const { vm, TaskwarriorWeb } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        const tokenInfo = TaskwarriorWeb.getTokenAtCursor('Ho', 2);
        const projectSuggestions = await vm.updateCompletion('modal.project', tokenInfo);
        expect(projectSuggestions).toEqual(['Home']);

        const dueSuggestions = await vm.updateCompletion('modal.due', TaskwarriorWeb.getTokenAtCursor('to', 2));
        expect(dueSuggestions).toContain('tomorrow');

        const tagSuggestions = await vm.updateCompletion('modal.tags', TaskwarriorWeb.getTokenAtCursor('gr', 2));
        expect(tagSuggestions).toEqual(['groceries']);
    });

    test('Escape closes drawer/reschedule/completion and respects modal safety', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.toggleDrawer(true);
        vm.toggleReschedule('uuid-1');
        vm.completion.visible = true;
        vm.groupDropdownOpen = true;

        vm.onGlobalKeydown({ key: 'Escape' });
        expect(vm.drawerOpen).toBe(false);
        expect(vm.reschedule.open).toBe(false);
        expect(vm.completion.visible).toBe(false);
        expect(vm.groupDropdownOpen).toBe(false);

        // Modal safety: first Esc shows hint, second closes.
        vm.openAddTask();
        await flushPromises(vm, 1);
        vm.modal.description = 'Dirty';

        vm.onGlobalKeydown({ key: 'Escape' });
        expect(vm.modal.open).toBe(true);
        expect(vm.modalEscHintVisible).toBe(true);

        vm.onGlobalKeydown({ key: 'Escape' });
        expect(vm.modal.open).toBe(false);
    });

    test('loads and saves taskrc in settings', async () => {
        const backend = createMockBackend();
        backend.state.taskrc = 'data.location=/tmp\n';

        const { vm } = mountWithBackend(backend);

        vm.openSettings();
        await flushPromises(vm, 5);

        expect(vm.taskrcText).toContain('data.location=/tmp');

        vm.taskrcText += '# comment\n';
        await vm.saveTaskrc();
        await flushPromises(vm, 1);

        expect(backend.state.taskrc).toContain('# comment');
        expect(vm.toast.text).toContain('Saved taskrc');
    });

    test('built-in filters: Today view, rename, and hide', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Due today', status: 'pending', due: 'today', urgency: 10 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Due tomorrow', status: 'pending', due: 'tomorrow', urgency: 9 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.selectBuiltin('today');
        await flushPromises(vm, 4);
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-1']);
        expect(vm.currentTitle).toBe('Today');

        vm.openSettings();
        await flushPromises(vm, 3);

        vm.settingsBuiltinDraft.today.name = 'My Today';
        vm.settingsBuiltinDraft.today.filter = 'due:tomorrow status:pending';
        vm.toggleBuiltinVisibility('today');
        expect(vm.settingsBuiltinDraft.today.visible).toBe(false);

        await vm.saveBuiltinFilters();
        await flushPromises(vm, 4);

        expect(vm.builtinFilters.today.name).toBe('My Today');
        expect(vm.builtinFilters.today.visible).toBe(false);

        vm.selectBuiltin('today');
        await flushPromises(vm, 2);
        expect(vm.selectedView).not.toEqual({ type: 'builtin', key: 'today' });

        vm.toggleBuiltinVisibility('today');
        expect(vm.settingsBuiltinDraft.today.visible).toBe(true);
        await vm.saveBuiltinFilters();
        await flushPromises(vm, 4);

        vm.selectBuiltin('today');
        await flushPromises(vm, 4);
        expect(vm.currentTitle).toBe('My Today');
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-2']);
    });

    test('groups tasks by project and persists per view', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'One', status: 'pending', urgency: 10, project: 'Home' });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Two', status: 'pending', urgency: 9, project: 'Work' });
        backend.state.tasks.push({ uuid: 'uuid-3', description: 'No project', status: 'pending', urgency: 8 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        // Default view: Next
        expect(vm.selectedView).toEqual({ type: 'builtin', key: 'next' });
        expect(vm.currentGroupBy).toBe(null);

        // Set Group by Project for Next
        await vm.updateGroupBy('project');
        await flushPromises(vm, 6);

        expect(vm.currentGroupBy).toBe('project');
        expect(backend.state.builtinFilters.next.group_by).toBe('project');
        expect(vm.taskGroups.map((g) => g.name)).toEqual(['(No Project)', 'Home', 'Work']);
        expect(document.body.textContent).toContain('Home');
        expect(document.body.textContent).toContain('Work');

        // Switch view, then back: grouping should restore from backend
        vm.selectBuiltin('all');
        await flushPromises(vm, 4);
        expect(vm.currentGroupBy).toBe(null);

        vm.selectBuiltin('next');
        await flushPromises(vm, 5);
        expect(vm.currentGroupBy).toBe('project');

        await vm.resetGroupSettings();
        await flushPromises(vm, 6);
        expect(vm.currentGroupBy).toBe(null);
        expect(backend.state.builtinFilters.next.group_by).toBe(null);
    });

    test('persists selected view to URL (builtin/filter/search)', async () => {
        const backend = createMockBackend();
        backend.state.filters.push({ id: 10, name: 'Home', filter: 'project:Home status:pending', order: 0 });

        const replaceSpy = jest.spyOn(window.history, 'replaceState');

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.selectBuiltin('all');
        await flushPromises(vm, 2);
        expect(replaceSpy).toHaveBeenCalled();
        expect(window.location.search).toContain('viewType=builtin');
        expect(window.location.search).toContain('viewKey=all');

        vm.selectCustomFilter(vm.filters[0]);
        await flushPromises(vm, 3);
        expect(window.location.search).toContain('viewType=filter');
        expect(window.location.search).toContain('filterId=10');

        vm.selectSearch();
        await flushPromises(vm, 3);
        expect(window.location.search).toContain('viewType=search');
    });

    test('restores selected view from URL on mount', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Pending', status: 'pending', urgency: 10 });
        backend.state.filters.push({ id: 10, name: 'Home', filter: 'status:pending', order: 0 });

        window.history.replaceState({}, '', 'http://localhost/?viewType=filter&filterId=10');

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        expect(vm.selectedView).toEqual({ type: 'filter', id: 10 });
        expect(vm.currentTitle).toBe('Home');
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-1']);
    });

    test('settings reload replaces editor content and dirty state toggles Save', async () => {
        const backend = createMockBackend();
        backend.state.taskrc = 'data.location=/tmp\n';

        const { vm } = mountWithBackend(backend);

        vm.openSettings();
        await flushPromises(vm, 5);

        const saveBtn = Array.from(document.querySelectorAll('button')).find((btn) => btn.textContent === 'Save');
        const reloadBtn = Array.from(document.querySelectorAll('button')).find((btn) => btn.textContent === 'Reload');
        expect(saveBtn).toBeTruthy();
        expect(reloadBtn).toBeTruthy();

        expect(vm.taskrcDirty).toBe(false);
        expect(saveBtn.disabled).toBe(true);

        vm.taskrcText += '# changed\n';
        await flushPromises(vm, 2);
        expect(vm.taskrcDirty).toBe(true);
        expect(saveBtn.disabled).toBe(false);

        backend.state.taskrc = 'data.location=/var\n';
        reloadBtn.click();
        await flushPromises(vm, 4);
        expect(vm.taskrcText).toContain('data.location=/var');
        expect(vm.taskrcDirty).toBe(false);
        expect(saveBtn.disabled).toBe(true);
    });

    test('reschedule custom date and other presets', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Due', status: 'pending', urgency: 1.5, due: 'today' });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.applyReschedulePreset('uuid-1', 'today');
        await flushPromises(vm, 4);
        expect(backend.state.tasks[0].due).toBe('today');

        await vm.applyReschedulePreset('uuid-1', 'sonw');
        await flushPromises(vm, 4);
        expect(backend.state.tasks[0].due).toBe('sonw');

        vm.toggleReschedule('uuid-1');
        vm.reschedule.custom = 'eom';
        await vm.applyRescheduleCustom('uuid-1');
        await flushPromises(vm, 4);
        expect(backend.state.tasks[0].due).toBe('eom');
    });

    test('reschedule uses configured settings field', async () => {
        const backend = createMockBackend();
        backend.state.settings.reschedule_field = 'wait';
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Wait', status: 'pending', urgency: 1.5, due: 'today' });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.applyReschedulePreset('uuid-1', 'tomorrow');
        await flushPromises(vm, 4);

        expect(backend.state.tasks[0].wait).toBe('tomorrow');
        expect(backend.state.tasks[0].due).toBe('today');

        await vm.clearRescheduleField('uuid-1');
        await flushPromises(vm, 4);

        expect(backend.state.tasks[0].wait).toBeUndefined();
    });

    test('add/edit modal uses configured scheduling field', async () => {
        const backend = createMockBackend();
        backend.state.settings.reschedule_field = 'wait';

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.openAddTask();
        await flushPromises(vm, 2);

        vm.modal.description = 'Test';
        vm.modal.due = 'tomorrow';
        await vm.submitModal();
        await flushPromises(vm, 5);

        const created = backend.state.tasks.find((t) => t.description === 'Test');
        expect(created).toBeTruthy();
        expect(created.wait).toBe('tomorrow');
        expect(created.due).toBeUndefined();

        // Now edit the same task and clear the field.
        vm.tasks = backend.state.tasks.slice();
        await vm.editTask(created.uuid);
        await flushPromises(vm, 3);

        vm.modal.due = '';
        await vm.submitModal();
        await flushPromises(vm, 5);

        const updated = backend.state.tasks.find((t) => t.uuid === created.uuid);
        expect(updated.wait).toBeUndefined();
    });

    test('edit modal shows configured field from export', async () => {
        const backend = createMockBackend();
        backend.state.settings.reschedule_field = 'scheduled';

        // Simulate a task list export that doesn't include `scheduled`.
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Scheduled', status: 'pending', urgency: 1 });

        backend.state.beforeFetch = async ({ pathname, method, init }) => {
            if (pathname !== '/api/task' || method !== 'POST') return null;

            const body = init.body ? JSON.parse(String(init.body)) : {};
            const args = String(body.args || '');
            if (args.trim() !== 'uuid-1 export') return null;

            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        success: true,
                        output: JSON.stringify([{ uuid: 'uuid-1', scheduled: 'tomorrow' }]),
                        error: '',
                    };
                },
                async text() {
                    return JSON.stringify({ success: true });
                },
            };
        };

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.editTask('uuid-1');
        await flushPromises(vm, 4);

        expect(vm.modal.open).toBe(true);
        expect(vm.modal.type).toBe('edit');
        expect(vm.modal.due).toBe('tomorrow');
    });

    test('edit modal resolves abbreviated schedule field (schedule -> scheduled)', async () => {
        const backend = createMockBackend();
        backend.state.settings.reschedule_field = 'schedule';

        // List view task does not include the scheduling field.
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Scheduled', status: 'pending', urgency: 1 });

        backend.state.beforeFetch = async ({ pathname, method, init }) => {
            if (pathname !== '/api/task' || method !== 'POST') return null;

            const body = init.body ? JSON.parse(String(init.body)) : {};
            const args = String(body.args || '');
            if (args.trim() !== 'uuid-1 export') return null;

            return {
                ok: true,
                status: 200,
                async json() {
                    return {
                        success: true,
                        output: JSON.stringify([{ uuid: 'uuid-1', scheduled: 'tomorrow' }]),
                        error: '',
                    };
                },
            };
        };

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.editTask('uuid-1');
        await flushPromises(vm, 4);

        expect(vm.modal.open).toBe(true);
        expect(vm.modal.type).toBe('edit');
        expect(vm.modal.due).toBe('tomorrow');
    });

    test('completion panel keyboard flow applies suggestion', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5, project: 'Home' });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.openAddTask();
        await flushPromises(vm, 2);

        // Open the project attribute dropdown; it will trigger initial completion.
        vm.toggleAttributeDropdown('project');
        await flushPromises(vm, 4);

        const input = vm.$refs.attributeInput;
        expect(input).toBeTruthy();

        // Type a prefix and position cursor.
        vm.modal.attributeInputValue = 'Ho';
        input.value = 'Ho';
        input.selectionStart = 2;
        input.selectionEnd = 2;

        await vm.handleAttributeInput({ target: input });
        await flushPromises(vm, 3);

        expect(vm.completion.suggestions).toEqual(['Home']);

        // Tab with one suggestion should apply and close dropdown.
        const event = dispatchKey(input, 'Tab');
        await vm.handleAttributeKeydown(event);
        await flushPromises(vm, 2);

        expect(event.preventDefault).toHaveBeenCalled();
        expect(vm.modal.project).toBe('Home');
        expect(vm.modal.activeAttributeDropdown).toBe(null);
    });

    test('modal completion keyboard flow applies selected suggestion', async () => {
        const backend = createMockBackend();

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.openCommandModal('search');
        await flushPromises(vm, 2);

        const input = vm.$refs.modalInput;
        expect(input).toBeTruthy();

        vm.modal.value = 'st';
        input.value = 'st';
        input.selectionStart = 2;
        input.selectionEnd = 2;

        const tabEvent = dispatchKey(input, 'Tab');
        await vm.handleCompletionKeydown(tabEvent, 'modal.value', 'submitModal');
        await flushPromises(vm, 3);

        expect(tabEvent.preventDefault).toHaveBeenCalled();
        expect(vm.completion.visible).toBe(true);
        expect(vm.completion.suggestions).toEqual(['status:pending', 'status:completed']);

        const arrowEvent = dispatchKey(input, 'ArrowDown');
        await vm.handleCompletionKeydown(arrowEvent, 'modal.value', 'submitModal');
        await flushPromises(vm, 1);

        expect(vm.completion.selectedIndex).toBe(1);

        const enterEvent = dispatchKey(input, 'Enter');
        await vm.handleCompletionKeydown(enterEvent, 'modal.value', 'submitModal');
        await flushPromises(vm, 3);

        expect(vm.modal.value).toBe('status:completed');
        expect(vm.completion.visible).toBe(false);
        expect(vm.completion.suggestions).toEqual([]);
    });

    test('error paths: checkbox rollback + filter reorder refresh', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5 });
        backend.state.filters.push({ id: 10, name: 'A', filter: 'status:pending', order: 0 });
        backend.state.filters.push({ id: 11, name: 'B', filter: 'status:pending', order: 1 });

        // Fail "uuid-1 done" requests.
        backend.state.beforeFetch = ({ pathname, method, init }) => {
            if (pathname === '/api/task' && method === 'POST') {
                const body = init.body ? JSON.parse(String(init.body)) : {};
                if (String(body.args || '').includes('uuid-1 done')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { success: false, output: '', error: 'nope' };
                        },
                    };
                }

                if (String(body.args || '').startsWith('export')) {
                    // Ensure refreshFilters reload still works.
                    return null;
                }
            }

            if (pathname === '/api/filters/reorder' && method === 'PUT') {
                return {
                    ok: true,
                    status: 200,
                    async json() {
                        return { success: false, error: 'reorder failed' };
                    },
                };
            }

            return null;
        };

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 7);

        const checkbox = document.querySelector('input[type="checkbox"]');
        expect(checkbox).toBeTruthy();
        checkbox.checked = true;
        await vm.toggleTaskDone(vm.tasks[0], { target: checkbox });
        await flushPromises(vm, 3);

        expect(vm.toast.type).toBe('error');
        expect(checkbox.checked).toBe(false);

        // Reorder filters in-memory then attempt to persist -> should refresh from backend order.
        vm.draggedFilterId = 11;
        await vm.onFilterDrop({ id: 10 });
        await flushPromises(vm, 5);

        // Backend order is unchanged (A then B).
        expect(vm.filters.map((f) => f.id)).toEqual([10, 11]);
        expect(vm.toast.type).toBe('error');
    });

    test('settings: load/save error paths show toast and keep loaded copy stable', async () => {
        const backend = createMockBackend();
        backend.state.taskrc = 'data.location=/tmp\n';

        backend.state.beforeFetch = ({ pathname, method }) => {
            if (pathname === '/api/taskrc' && method === 'GET') {
                return {
                    ok: false,
                    status: 500,
                    async text() {
                        return 'backend down';
                    },
                };
            }
            return null;
        };

        const { vm } = mountWithBackend(backend);

        vm.openSettings();
        await flushPromises(vm, 6);

        expect(vm.toast.type).toBe('error');
        expect(vm.toast.text).toContain('Error loading taskrc');

        // Now allow loading, but fail saving.
        backend.state.beforeFetch = ({ pathname, method }) => {
            if (pathname === '/api/taskrc' && method === 'PUT') {
                return {
                    ok: false,
                    status: 500,
                    async text() {
                        return 'no write';
                    },
                };
            }
            return null;
        };

        // Force-load the taskrc.
        await vm.loadTaskrc();
        await flushPromises(vm, 3);

        expect(vm.taskrcText).toContain('data.location=/tmp');
        expect(vm.loadedTaskrcText).toContain('data.location=/tmp');

        vm.taskrcText += '# changed\n';
        await flushPromises(vm, 1);

        await vm.saveTaskrc();
        await flushPromises(vm, 2);

        expect(vm.toast.type).toBe('error');
        expect(vm.toast.text).toContain('Error saving taskrc');
        expect(vm.loadedTaskrcText).toContain('data.location=/tmp');
    });

    test('toast auto-dismisses and a new toast replaces the timer', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 3);

        vm.showToast('First', 'success', 1000);
        expect(vm.toast).toEqual({ text: 'First', type: 'success' });

        jest.advanceTimersByTime(500);
        await flushPromises(vm, 1);

        vm.showToast('Second', 'error', 1000);
        expect(vm.toast).toEqual({ text: 'Second', type: 'error' });

        // Original timer would have expired at t=1000, but should be canceled.
        jest.advanceTimersByTime(600);
        await flushPromises(vm, 1);
        expect(vm.toast).toEqual({ text: 'Second', type: 'error' });

        // Second toast expires at t=1500.
        jest.advanceTimersByTime(500);
        await flushPromises(vm, 1);
        expect(vm.toast).toEqual({ text: '', type: 'success' });
    });

    test('delete task failure shows error toast and task remains', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Delete me', status: 'pending', urgency: 1.5 });

        jest.spyOn(global, 'confirm').mockImplementation(() => true);

        backend.state.beforeFetch = ({ pathname, method, init }) => {
            if (pathname === '/api/task' && method === 'POST') {
                const body = init.body ? JSON.parse(String(init.body)) : {};
                if (String(body.args || '').includes('uuid-1 delete')) {
                    return {
                        ok: true,
                        status: 200,
                        async json() {
                            return { success: false, output: '', error: 'no delete' };
                        },
                    };
                }
            }
            return null;
        };

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.deleteTask('uuid-1');
        await flushPromises(vm, 4);

        expect(vm.toast.type).toBe('error');
        expect(backend.state.tasks).toHaveLength(1);
        expect(document.body.textContent).toContain('Delete me');
    });
});
