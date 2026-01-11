const fs = require('fs');
const path = require('path');
const { createMockBackend } = require('./mockBackend.cjs');

// Load TaskColors module
global.TaskColors = require('../../public/task-colors.js');

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

    test('treats last token as report and appends to export', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Urgent report', status: 'pending', urgency: 2, tags: ['urgent'] });

        backend.state.reports = ['newest'];

        const seen = [];
        backend.state.beforeFetch = ({ pathname, method, init }) => {
            if (pathname !== '/api/task' || method !== 'POST') return null;
            const body = init.body ? JSON.parse(String(init.body)) : {};
            if (Array.isArray(body.args)) {
                seen.push(body.args.join(' '));
            } else if (body.args) {
                seen.push(String(body.args));
            }
            return null;
        };

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        // Simulate search selection (doesn't auto-load tasks).
        vm.selectedView = { type: 'search' };
        vm.lastSearch.term = 'status:pending newest';
        vm.lastSearch.pendingOnly = false;
        await vm.refreshCurrentPanel();
        await flushPromises(vm, 6);

        expect(seen.some((args) => args.trim() === 'status:pending export newest')).toBe(true);
    });

    test('applies report.sort when export order is unstable', async () => {
        const backend = createMockBackend();
        backend.state.reports = ['prio'];

        // Return tasks in non-sorted order; UI should apply report.prio.sort.
        backend.state.tasks = [
            { uuid: 'u1', description: 'B', status: 'pending', urgency: 1, priority: 'B' },
            { uuid: 'u2', description: 'A', status: 'pending', urgency: 1, priority: 'A' },
        ];

        backend.state.taskConfig['report.prio.sort'] = 'priority ascending';

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.selectedView = { type: 'search' };
        vm.lastSearch.term = 'status:pending prio';
        vm.lastSearch.pendingOnly = false;
        await vm.refreshCurrentPanel();
        await flushPromises(vm, 6);

        expect(vm.tasks.map((t) => t.description)).toEqual(['A', 'B']);
    });

    test('defaults to urgency sorting when not using report', async () => {
        const backend = createMockBackend();
        backend.state.tasks = [
            { uuid: 'u1', description: 'Low', status: 'pending', urgency: 1 },
            { uuid: 'u2', description: 'High', status: 'pending', urgency: 3 },
        ];

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.selectedView = { type: 'search' };
        vm.lastSearch.term = 'status:pending';
        vm.lastSearch.pendingOnly = false;
        await vm.refreshCurrentPanel();
        await flushPromises(vm, 6);

        expect(vm.tasks.map((t) => t.description)).toEqual(['High', 'Low']);
    });

    test('renders due, scheduled, and waiting dates in task list', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({
            uuid: 'uuid-1',
            description: 'Dates',
            status: 'pending',
            urgency: 1.5,
            due: '2025-01-03',
            scheduled: '2025-01-04',
            wait: '2025-01-05',
        });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        const card = document.querySelector('.task-card');
        expect(card).toBeTruthy();

        const dueEl = card.querySelector('.meta.meta-due');
        expect(dueEl).toBeTruthy();
        expect(dueEl.textContent).toContain('03.01.2025');

        const scheduledEl = card.querySelector('.meta.meta-scheduled');
        expect(scheduledEl).toBeTruthy();
        expect(scheduledEl.textContent).toContain('04.01.2025');

        const waitEl = card.querySelector('.meta.meta-wait');
        expect(waitEl).toBeTruthy();
        expect(waitEl.textContent).toContain('05.01.2025');
    });

    test('applies taskrc colors to due/scheduled tasks', async () => {
        // This test relies on Taskwarrior-style color rules like `color.due.today`.
        // With Jest fake timers, we must set the system time so "today" is stable.
        jest.setSystemTime(new Date('2025-01-03T12:00:00Z'));

        const backend = createMockBackend();
        backend.state.taskrc = [
            '# taskrc',
            'color.pending=white',
            'color.due.today=bold red',
            'color.scheduled.today=yellow on blue',
            '',
        ].join('\n');

        backend.state.tasks.push({
            uuid: 'uuid-1',
            description: 'Due task',
            status: 'pending',
            urgency: 1.5,
            due: '20250103T000000Z',
        });

        backend.state.tasks.push({
            uuid: 'uuid-2',
            description: 'Scheduled task',
            status: 'pending',
            urgency: 1.5,
            scheduled: '20250103T000000Z',
        });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 8);

        const cards = Array.from(document.querySelectorAll('.task-card'));
        expect(cards).toHaveLength(2);

        const dueText = cards.find((card) => card.textContent.includes('Due task'));
        expect(dueText).toBeTruthy();

        const dueDesc = dueText.querySelector('.task-desc-text');
        expect(dueDesc).toBeTruthy();
        expect(dueDesc.style.color).toBe('rgb(255, 0, 0)');
        expect(dueDesc.style.fontWeight).toBe('bold');

        const scheduledCard = cards.find((card) => card.textContent.includes('Scheduled task'));
        expect(scheduledCard).toBeTruthy();
        expect(scheduledCard.style.backgroundColor).toBe('rgb(0, 0, 255)');

        const scheduledDesc = scheduledCard.querySelector('.task-desc-text');
        expect(scheduledDesc.style.color).toBe('rgb(255, 255, 0)');
    });

    test('keeps taskrc-based colors after refresh with updated task data', async () => {
        jest.setSystemTime(new Date('2025-01-03T12:00:00Z'));

        const backend = createMockBackend();
        backend.state.taskrc = [
            '# taskrc',
            'color.pending=white',
            'color.due.today=bold red',
            'color.scheduled.today=yellow on blue',
            '',
        ].join('\n');

        backend.state.tasks.push({
            uuid: 'uuid-1',
            description: 'Becomes due today',
            status: 'pending',
            urgency: 1.5,
        });

        backend.state.tasks.push({
            uuid: 'uuid-2',
            description: 'Scheduled today stays colored',
            status: 'pending',
            urgency: 1.5,
            scheduled: '20250103T000000Z',
        });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 10);

        const scheduledCardBefore = Array.from(document.querySelectorAll('.task-card'))
            .find((card) => card.textContent.includes('Scheduled today stays colored'));
        expect(scheduledCardBefore).toBeTruthy();
        expect(scheduledCardBefore.style.backgroundColor).toBe('rgb(0, 0, 255)');

        // Simulate that the backend now exports the task with a due date set to today.
        const updated = backend.state.tasks.find((task) => task.uuid === 'uuid-1');
        updated.due = '20250103T000000Z';

        await vm.refreshCurrentPanel();
        await flushPromises(vm, 8);

        const becomesDueCard = Array.from(document.querySelectorAll('.task-card'))
            .find((card) => card.textContent.includes('Becomes due today'));
        expect(becomesDueCard).toBeTruthy();
        const becomesDueDesc = becomesDueCard.querySelector('.task-desc-text');
        expect(becomesDueDesc.style.color).toBe('rgb(255, 0, 0)');
        expect(becomesDueDesc.style.fontWeight).toBe('bold');

        const scheduledCardAfter = Array.from(document.querySelectorAll('.task-card'))
            .find((card) => card.textContent.includes('Scheduled today stays colored'));
        expect(scheduledCardAfter).toBeTruthy();
        expect(scheduledCardAfter.style.backgroundColor).toBe('rgb(0, 0, 255)');
    });

    test('does not drop taskrc colors on 304 taskrc responses', async () => {
        const backend = createMockBackend();
        backend.state.taskrc = 'color.pending=red\n';

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        await vm.loadTaskrc();
        await flushPromises(vm, 2);
        expect(vm.taskrcColorRules.pending).toBeDefined();

        backend.state.beforeFetch = async ({ pathname }) => {
            if (pathname === '/api/taskrc') {
                return {
                    ok: true,
                    status: 304,
                    async text() {
                        return '';
                    },
                };
            }
            return null;
        };

        await vm.loadTaskrc();
        await flushPromises(vm, 2);
        expect(vm.taskrcColorRules.pending).toBeDefined();
        expect(vm.taskrcColorRules.pending.color).toBe('#ff0000');
    });

    test('hides urgency chip on mobile widths', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Hello', status: 'pending', urgency: 1.5 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        const urgencyEl = document.querySelector('.task-card .urgency');
        expect(urgencyEl).toBeTruthy();

        const stylesPath = path.join(__dirname, '..', '..', 'public', 'styles.css');
        const styles = fs.readFileSync(stylesPath, 'utf8');

        expect(styles).toMatch(/@media \(max-width: 768px\)[\s\S]*?\.urgency\s*\{[\s\S]*?display:\s*none;/);
    });

    test('opens drawer on left edge swipe', async () => {
        const backend = createMockBackend();

        // Force touch device detection.
        window.ontouchstart = () => {};

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        expect(vm.drawerOpen).toBe(false);

        const main = document.querySelector('main.main');
        expect(main).toBeTruthy();

        const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
        touchStart.touches = [{ clientX: 5, clientY: 40, identifier: 1 }];
        main.dispatchEvent(touchStart);

        const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
        touchMove.touches = [{ clientX: 90, clientY: 45, identifier: 1 }];
        touchMove.preventDefault = jest.fn();
        main.dispatchEvent(touchMove);

        await flushPromises(vm, 1);
        expect(vm.drawerOpen).toBe(true);
    });

    test('pulls down at top to sync and refresh', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'Before', status: 'pending', urgency: 1.5 });

        // Force touch device detection.
        window.ontouchstart = () => {};

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 8);

        // Slow down sync so we can observe the visual state.
        const runSyncSpy = jest.spyOn(vm, 'runSync').mockImplementation(() => new Promise((resolve) => setTimeout(resolve, 50)));
        const refreshSpy = jest.spyOn(vm, 'refreshCurrentPanel');

        const main = document.querySelector('main.main');
        expect(main).toBeTruthy();

        // Ensure scroller is at top.
        main.scrollTop = 0;

        const touchStart = new Event('touchstart', { bubbles: true, cancelable: true });
        touchStart.touches = [{ clientX: 100, clientY: 10, identifier: 1 }];
        main.dispatchEvent(touchStart);

        const touchMove = new Event('touchmove', { bubbles: true, cancelable: true });
        touchMove.touches = [{ clientX: 100, clientY: 120, identifier: 1 }];
        touchMove.preventDefault = jest.fn();
        main.dispatchEvent(touchMove);

        const touchEnd = new Event('touchend', { bubbles: true, cancelable: true });
        touchEnd.changedTouches = [{ clientX: 100, clientY: 120, identifier: 1 }];
        main.dispatchEvent(touchEnd);

        await flushPromises(vm, 2);

        const indicator = document.querySelector('.pull-refresh-indicator');
        expect(indicator).toBeTruthy();
        expect(indicator.classList.contains('spinning')).toBe(true);

        jest.advanceTimersByTime(60);
        await flushPromises(vm, 6);

        expect(runSyncSpy).toHaveBeenCalled();
        expect(refreshSpy).toHaveBeenCalled();
        expect(indicator.classList.contains('spinning')).toBe(false);
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

    test('multi-select: toggle shows X, uses icon buttons, and no selection circles', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'First', status: 'pending', urgency: 1.5 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Second', status: 'pending', urgency: 1.2 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 10);

        expect(vm.multiSelectMode).toBe(false);

        const toggleBtn = document.querySelector('.tasks-controls .control-btn[aria-label="Enable multi-select mode"]');
        expect(toggleBtn).toBeTruthy();

        toggleBtn.click();
        await flushPromises(vm, 2);

        expect(vm.multiSelectMode).toBe(true);

        const toggleBtnCancel = document.querySelector('.tasks-controls .control-btn[aria-label="Cancel multi-select mode"]');
        expect(toggleBtnCancel).toBeTruthy();

        const toolbar = document.querySelector('.multi-select-toolbar');
        expect(toolbar).toBeTruthy();

        const selectAllBtn = document.querySelector('.multi-select-actions button[aria-label="Select all pending tasks"]');
        expect(selectAllBtn).toBeTruthy();
        expect(selectAllBtn.classList.contains('icon-btn')).toBe(true);

        const deselectAllBtn = document.querySelector('.multi-select-actions button[aria-label="Deselect all"]');
        expect(deselectAllBtn).toBeFalsy();

        const completeSelectedBtn = document.querySelector('.multi-select-actions button[aria-label="Complete selected tasks"]');
        expect(completeSelectedBtn).toBeFalsy();

        const deleteSelectedBtn = document.querySelector('.multi-select-actions button[aria-label="Delete selected tasks"]');
        expect(deleteSelectedBtn).toBeFalsy();

        const rescheduleBtn = document.querySelector('.multi-select-actions button[aria-label="Reschedule selected"]');
        expect(rescheduleBtn).toBeFalsy();

        const editBtn = document.querySelector('.multi-select-actions button[aria-label="Edit selected"]');
        expect(editBtn).toBeFalsy();

        expect(document.querySelector('.multi-select-actions button[aria-label="Cancel"]')).toBeFalsy();
        expect(document.querySelector('.task-select-indicator')).toBeFalsy();

        // Task completion checkbox is hidden while multi-select is enabled.
        expect(document.querySelector('.task-check input[type="checkbox"]')).toBeFalsy();

        // Clicking a task selects it via task card styling.
        document.querySelectorAll('.task-card')[0].click();
        await flushPromises(vm, 2);

        const deselectAllBtnAfterSelect = document.querySelector('.multi-select-actions button[aria-label="Deselect all"]');
        expect(deselectAllBtnAfterSelect).toBeTruthy();
        expect(deselectAllBtnAfterSelect.classList.contains('icon-btn')).toBe(true);

        const completeSelectedAfterSelect = document.querySelector('.multi-select-actions button[aria-label="Complete selected tasks"]');
        expect(completeSelectedAfterSelect).toBeTruthy();
        expect(completeSelectedAfterSelect.classList.contains('icon-btn')).toBe(true);

        const deleteSelectedAfterSelect = document.querySelector('.multi-select-actions button[aria-label="Delete selected tasks"]');
        expect(deleteSelectedAfterSelect).toBeTruthy();
        expect(deleteSelectedAfterSelect.classList.contains('icon-btn')).toBe(true);

        const rescheduleAfterSelect = document.querySelector('.multi-select-actions button[aria-label="Reschedule selected"]');
        expect(rescheduleAfterSelect).toBeTruthy();
        expect(rescheduleAfterSelect.classList.contains('icon-btn')).toBe(true);

        const editAfterSelect = document.querySelector('.multi-select-actions button[aria-label="Edit selected"]');
        expect(editAfterSelect).toBeTruthy();
        expect(editAfterSelect.classList.contains('icon-btn')).toBe(true);

        expect(vm.selectedTaskUuids.has('uuid-1')).toBe(true);
        const selectedCard = document.querySelectorAll('.task-card')[0];
        expect(selectedCard.classList.contains('task-selected')).toBe(true);

        // Toggle off multi-select clears selections.
        toggleBtnCancel.click();
        await flushPromises(vm, 2);

        expect(vm.multiSelectMode).toBe(false);
        expect(vm.selectedTaskUuids.size).toBe(0);
    });

     test('multi-reschedule can override default fields per action', async () => {
         const backend = createMockBackend();
         backend.state.tasks.push({ uuid: 'uuid-1', description: 'First', status: 'pending', urgency: 1.5 });
         backend.state.tasks.push({ uuid: 'uuid-2', description: 'Second', status: 'pending', urgency: 1.2 });

         backend.state.settings.reschedule_field = 'due,wait';

         const { vm } = mountWithBackend(backend);
         await flushPromises(vm, 10);

         document.querySelector('.tasks-controls .control-btn[aria-label="Enable multi-select mode"]').click();
         await flushPromises(vm, 2);

         const cards = document.querySelectorAll('.task-card');
         cards[0].click();
         cards[1].click();
         await flushPromises(vm, 2);

         document.querySelector('.multi-select-actions button[aria-label="Reschedule selected"]').click();
         await flushPromises(vm, 2);

         expect(vm.reschedule.open).toBe(true);
         expect(vm.reschedule.multiSelect).toBe(true);
         expect(vm.reschedule.fields).toEqual(['due', 'wait']);
         expect(vm.reschedule.showFieldPicker).toBe(false);

         // Override for this bulk reschedule: only schedule.
         vm.reschedule.fields = ['schedule'];

         await vm.applyMultiReschedulePreset('today');
         await flushPromises(vm, 6);

         expect(backend.state.tasks[0].schedule).toBe('today');
         expect(backend.state.tasks[1].schedule).toBe('today');
         expect(backend.state.tasks[0].due).toBeUndefined();
         expect(backend.state.tasks[0].wait).toBeUndefined();
     });

     test('multi-edit modal includes input and runs task <uuids> mod <input>', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'First', status: 'pending', urgency: 1.5 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Second', status: 'pending', urgency: 1.2 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 10);

        document.querySelector('.tasks-controls .control-btn[aria-label="Enable multi-select mode"]').click();
        await flushPromises(vm, 2);

        // Select both tasks.
        const cards = document.querySelectorAll('.task-card');
        cards[0].click();
        cards[1].click();
        await flushPromises(vm, 2);

        expect(vm.selectedTaskUuids.size).toBe(2);

        // Open bulk edit modal.
        document.querySelector('.multi-select-actions button[aria-label="Edit selected"]').click();
        await flushPromises(vm, 2);

        expect(vm.modal.open).toBe(true);
        expect(vm.modal.type).toBe('edit-multi');

        const modalInput = document.querySelector('.modal-form input.text-input');
        expect(modalInput).toBeTruthy();

        vm.modal.value = 'project:Bulk';
        await vm.submitModal();
        await flushPromises(vm, 8);

        const t1 = vm.tasks.find((t) => t.uuid === 'uuid-1');
        const t2 = vm.tasks.find((t) => t.uuid === 'uuid-2');
        expect(t1.project).toBe('Bulk');
        expect(t2.project).toBe('Bulk');
    });

    test('multi-select toolbar applies complete and delete to all selected tasks', async () => {
        const backend = createMockBackend();
        backend.state.tasks.push({ uuid: 'uuid-1', description: 'First', status: 'pending', urgency: 1.5 });
        backend.state.tasks.push({ uuid: 'uuid-2', description: 'Second', status: 'pending', urgency: 1.2 });

        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 10);

        // Enable multi select and select both tasks.
        document.querySelector('.tasks-controls .control-btn[aria-label="Enable multi-select mode"]').click();
        await flushPromises(vm, 2);

        const cards = document.querySelectorAll('.task-card');
        cards[0].click();
        cards[1].click();
        await flushPromises(vm, 2);

        const completeBtn = document.querySelector('.multi-select-actions button[aria-label="Complete selected tasks"]');
        expect(completeBtn).toBeTruthy();

        completeBtn.click();
        await flushPromises(vm, 10);

        expect(backend.state.tasks.find((t) => t.uuid === 'uuid-1').status).toBe('completed');
        expect(backend.state.tasks.find((t) => t.uuid === 'uuid-2').status).toBe('completed');

        // Delete the same tasks (even though they might not be visible in the default view).
        vm.selectedTaskUuids = new Set(['uuid-1', 'uuid-2']);
        await flushPromises(vm, 2);

        global.confirm = jest.fn(() => true);

        const deleteBtn = document.querySelector('.multi-select-actions button[aria-label="Delete selected tasks"]');
        expect(deleteBtn).toBeTruthy();

        deleteBtn.click();
        await flushPromises(vm, 10);

        expect(backend.state.tasks).toHaveLength(0);
        expect(global.confirm).toHaveBeenCalled();
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
        await flushPromises(vm, 8);

        await vm.editTask('uuid-1');
        await flushPromises(vm, 3);

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
        await flushPromises(vm, 8);

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
         backend.state.tasks.push({ uuid: 'uuid-1', description: 'Due', status: 'pending', urgency: 1.5, due: 'today', wait: 'today' });

         backend.state.settings.reschedule_field = 'due,wait';

         const { vm } = mountWithBackend(backend);
         await flushPromises(vm, 6);

         vm.toggleReschedule('uuid-1');
         expect(vm.reschedule.open).toBe(true);
         expect(vm.reschedule.showFieldPicker).toBe(false);

         await vm.applyReschedulePreset('uuid-1', 'tomorrow');
         await flushPromises(vm, 5);
         expect(vm.toast.text).toContain('Rescheduled task');
         expect(backend.state.tasks[0].due).toBe('tomorrow');
         expect(backend.state.tasks[0].wait).toBe('tomorrow');

         vm.toggleReschedule('uuid-1');
         await vm.clearRescheduleField('uuid-1');
         await flushPromises(vm, 5);
         expect(vm.toast.text).toContain('Cleared Due/Wait');
         expect(backend.state.tasks[0].due).toBeUndefined();
         expect(backend.state.tasks[0].wait).toBeUndefined();
     });

     test('reschedule can override default fields per action', async () => {
         const backend = createMockBackend();
         backend.state.tasks.push({ uuid: 'uuid-1', description: 'Override', status: 'pending', urgency: 1.5 });

         backend.state.settings.reschedule_field = 'due,wait';

         const { vm } = mountWithBackend(backend);
         await flushPromises(vm, 6);

         vm.toggleReschedule('uuid-1');
         expect(vm.reschedule.fields).toEqual(['due', 'wait']);
         expect(vm.reschedule.showFieldPicker).toBe(false);

         // Override for this reschedule: only schedule.
         vm.reschedule.fields = ['schedule'];

         await vm.applyReschedulePreset('uuid-1', 'tomorrow');
         await flushPromises(vm, 5);

         expect(backend.state.tasks[0].schedule).toBe('tomorrow');
         expect(backend.state.tasks[0].due).toBeUndefined();
         expect(backend.state.tasks[0].wait).toBeUndefined();
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

        const dataTransfer = {
            _data: {},
            setData: jest.fn(function (type, value) {
                this._data[type] = value;
            }),
            getData: jest.fn(function (type) {
                return this._data[type] || '';
            }),
        };

        // Reorder: drag Work above Home
        vm.onFilterDragStart({ id: workFilterId }, { dataTransfer });
        await vm.onFilterDrop({ id: homeFilterId }, { dataTransfer });
        await flushPromises(vm, 3);

        // Ensure reorder endpoint was called
        expect(fetchSpy).toHaveBeenCalledWith(
            '/api/filters/reorder',
            expect.objectContaining({ method: 'PUT' }),
        );

        // Ensure drag handles exist in DOM
        const dragHandles = Array.from(document.querySelectorAll('.filter-row .drag-handle'));
        expect(dragHandles).toHaveLength(2);
        expect(dragHandles[0].getAttribute('draggable')).toBe('true');
        expect(dragHandles[0].tagName).toBe('SPAN');

        const startDropZone = document.querySelector('.filters .filter-drop-zone.start');
        expect(startDropZone).toBeTruthy();

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
        expect(vm.renderMarkdown('**hi**')).toContain('<strong>hi</strong>');
        expect(vm.renderMarkdown('See https://example.com now')).toContain('<a href="https://example.com"');
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

    test('sidebar sync refreshes tasks when task list visible', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        expect(vm.mainMode).toBe('tasks');
        expect(vm.showTaskrc).toBe(false);

        const runSyncSpy = jest.spyOn(vm, 'runSync').mockResolvedValue();
        const refreshSpy = jest.spyOn(vm, 'refreshCurrentPanel').mockResolvedValue();

        const syncButton = document.querySelector('button[aria-label="Sync"]');
        expect(syncButton).toBeTruthy();

        syncButton.click();
        await flushPromises(vm, 3);

        expect(runSyncSpy).toHaveBeenCalled();
        expect(refreshSpy).toHaveBeenCalled();
    });

    test('sidebar sync does not refresh when output visible', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 6);

        vm.mainMode = 'output';
        vm.mainOutput = 'Hello';
        await flushPromises(vm, 1);

        const runSyncSpy = jest.spyOn(vm, 'runSync').mockResolvedValue();
        const refreshSpy = jest.spyOn(vm, 'refreshCurrentPanel').mockResolvedValue();

        const syncButton = document.querySelector('button[aria-label="Sync"]');
        expect(syncButton).toBeTruthy();

        syncButton.click();
        await flushPromises(vm, 3);

        expect(runSyncSpy).toHaveBeenCalled();
        expect(refreshSpy).not.toHaveBeenCalled();
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

    test('app settings save + reset work from settings panel', async () => {
        const backend = createMockBackend();
        backend.state.settings.reschedule_field = 'wait';

        const { vm } = mountWithBackend(backend);
        vm.openSettings();
        await flushPromises(vm, 6);

        expect(vm.settingsAppLoaded.reschedule_field).toEqual(['wait']);
        expect(vm.settingsAppDraft.reschedule_field).toEqual(['wait']);

        vm.settingsAppDraft.reschedule_field = ['schedule', 'due'];
        await flushPromises(vm, 1);

        vm.resetAppSettingsDraft();
        expect(vm.settingsAppDraft.reschedule_field).toEqual(['wait']);

        vm.settingsAppDraft.reschedule_field = ['schedule'];
        await vm.saveAppSettings();
        await flushPromises(vm, 4);

        expect(backend.state.settings.reschedule_field).toBe('schedule');
        expect(vm.settingsAppLoaded.reschedule_field).toEqual(['schedule']);
        expect(vm.toast.text).toContain('Saved app settings');
    });

    test('formatDate handles date-only, local and zulu timestamps', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 2);

        function pad2(value) {
            return String(value).padStart(2, '0');
        }

        function formatExpectedZulu(taskwarriorZulu) {
            const match = String(taskwarriorZulu || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
            if (!match) throw new Error(`Invalid zulu timestamp: ${taskwarriorZulu}`);

            const [, y, mon, d, h, min, s] = match;
            const date = new Date(`${y}-${mon}-${d}T${h}:${min}:${s}Z`);

            const dateText = `${pad2(date.getDate())}.${pad2(date.getMonth() + 1)}.${date.getFullYear()}`;
            const hour = date.getHours();
            const minute = date.getMinutes();

            if ((hour === 0 && minute === 0) || (hour === 23 && minute === 59)) {
                return dateText;
            }

            return `${dateText} ${pad2(hour)}:${pad2(minute)}`;
        }

        // Date-only
        expect(vm.formatDate('20251224')).toBe('24.12.2025');

        // Local timestamps keep their wall-clock time.
        expect(vm.formatDate('20251224T235900')).toBe('24.12.2025');
        expect(vm.formatDate('20251224T010500')).toBe('24.12.2025 01:05');

        // Zulu timestamps are converted to the runtime's local timezone.
        // Note: some CI images don't ship full tzdata, so `process.env.TZ`
        // may silently fall back to UTC.
        expect(vm.formatDate('20250102T003000Z')).toBe(formatExpectedZulu('20250102T003000Z'));

        // Midnight Zulu timestamps are often used as date-only placeholders.
        // These should stay date-only regardless of the runtime TZ.
        expect(vm.formatDate('20251231T000000Z')).toBe('31.12.2025');

        // Placeholder times are hidden even after conversion.
        expect(vm.formatDate('20250102T225900Z')).toBe(formatExpectedZulu('20250102T225900Z'));
    });

    test('TaskQueryService groups UDAs using configured order', async () => {
        const backend = createMockBackend();
        backend.state.taskConfig['uda.team.values'] = 'Bravo, Alpha';

        const { TaskwarriorWeb } = mountWithBackend(backend);

        const apiClient = new TaskwarriorWeb.TaskApiClient('/api', backend.fetchImpl);
        const queryService = new TaskwarriorWeb.TaskQueryService(apiClient);

        const tasks = [
            { uuid: '1', status: 'pending', urgency: 3, team: 'Charlie' },
            { uuid: '2', status: 'pending', urgency: 2, team: 'Alpha' },
            { uuid: '3', status: 'pending', urgency: 1, team: 'Bravo' },
        ];

        const groups = await queryService.groupTasks(tasks, 'team');
        expect(groups.map((g) => g.name)).toEqual(['Bravo', 'Alpha', 'Charlie']);

        // Verify caching (second call should not hit backend for _get again).
        const execSpy = jest.spyOn(apiClient, 'execute');
        const groups2 = await queryService.groupTasks(tasks, 'team');
        expect(groups2.map((g) => g.name)).toEqual(['Bravo', 'Alpha', 'Charlie']);
        expect(execSpy).not.toHaveBeenCalled();
        execSpy.mockRestore();
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

    test('Modal X button respects unsaved-changes safety (double-press)', async () => {
        const backend = createMockBackend();
        const { vm } = mountWithBackend(backend);
        await flushPromises(vm, 5);

        vm.openAddTask();
        await flushPromises(vm, 2);

        const closeBtn = document.querySelector('section.modal button[aria-label="Close"]');
        expect(closeBtn).toBeTruthy();

        // Clean modal closes immediately.
        closeBtn.click();
        await flushPromises(vm, 1);
        expect(vm.modal.open).toBe(false);

        // Dirty modal requires confirmation: first click shows hint.
        vm.openAddTask();
        await flushPromises(vm, 2);
        vm.modal.description = 'Dirty';
        await flushPromises(vm, 1);

        const closeBtnDirty = document.querySelector('section.modal button[aria-label="Close"]');
        expect(closeBtnDirty).toBeTruthy();

        closeBtnDirty.click();
        await flushPromises(vm, 1);
        expect(vm.modal.open).toBe(true);
        expect(vm.modalEscHintVisible).toBe(true);
        expect(closeBtnDirty.classList.contains('danger')).toBe(true);

        // Second click discards changes and closes.
        closeBtnDirty.click();
        await flushPromises(vm, 1);
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

        vm.toggleBuiltinVisibility('today');
        expect(vm.settingsBuiltinVisibilityDraft.today.visible).toBe(false);

        await vm.saveBuiltinFilters();
        await flushPromises(vm, 4);

        expect(vm.builtinFilters.today.name).toBe('Today');
        expect(vm.builtinFilters.today.visible).toBe(false);
        expect(vm.settingsBuiltinVisibilityDraft.today.visible).toBe(false);

        vm.selectBuiltin('today');
        await flushPromises(vm, 2);
        expect(vm.selectedView).not.toEqual({ type: 'builtin', key: 'today' });

        vm.toggleBuiltinVisibility('today');
        expect(vm.settingsBuiltinVisibilityDraft.today.visible).toBe(true);
        await vm.saveBuiltinFilters();
        await flushPromises(vm, 4);

        vm.selectBuiltin('today');
        await flushPromises(vm, 4);
        expect(vm.currentTitle).toBe('Today');
        expect(vm.tasks.map((t) => t.uuid)).toEqual(['uuid-1']);
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

        vm.toggleReschedule('uuid-1');
        await flushPromises(vm, 2);

        await vm.applyReschedulePreset('uuid-1', 'tomorrow');
        await flushPromises(vm, 4);

        expect(backend.state.tasks[0].wait).toBe('tomorrow');
        expect(backend.state.tasks[0].due).toBe('today');

        vm.toggleReschedule('uuid-1');
        await flushPromises(vm, 2);

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
        expect(vm.completion.suggestions).toEqual(['status:', 'status:pending', 'status:completed']);

        const enterEvent = dispatchKey(input, 'Enter');
        await vm.handleCompletionKeydown(enterEvent, 'modal.value', 'submitModal');
        await flushPromises(vm, 4);

        expect(vm.modal.value).toBe('status:');
        expect(vm.completion.visible).toBe(true);
        expect(vm.completion.suggestions).toEqual(['pending', 'completed', 'deleted', 'waiting']);

        const arrowEvent = dispatchKey(input, 'ArrowDown');
        await vm.handleCompletionKeydown(arrowEvent, 'modal.value', 'submitModal');
        await flushPromises(vm, 1);

        expect(vm.completion.selectedIndex).toBe(1);

        const enterEvent2 = dispatchKey(input, 'Enter');
        await vm.handleCompletionKeydown(enterEvent2, 'modal.value', 'submitModal');
        await flushPromises(vm, 3);

        expect(vm.modal.value).toBe('status:completed');
        expect(vm.completion.visible).toBe(false);
        expect(vm.completion.suggestions).toEqual([]);
    });

    test('modal completion click selection retriggers nested suggestions', async () => {
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

        expect(vm.completion.suggestions[0]).toBe('status:');

        await vm.applyModalCompletion('modal.value', 'status:');
        await flushPromises(vm, 5);

        expect(vm.modal.value).toBe('status:');
        expect(vm.completion.visible).toBe(true);
        expect(vm.completion.suggestions).toEqual(['pending', 'completed', 'deleted', 'waiting']);
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
    describe('TaskWarrior color support', () => {
        test('parses color rules from taskrc and applies them to tasks', async () => {
            const backend = createMockBackend();
            backend.state.taskrc = `
# TaskWarrior color configuration
color.pending=blue
color.priority.H=bold red
color.project.Work=yellow on gray5
color.tag.urgent=underline red
            `.trim();

            backend.state.tasks.push(
                { uuid: 'uuid-1', description: 'Pending task', status: 'pending', urgency: 1.0 },
                { uuid: 'uuid-2', description: 'High priority', status: 'pending', priority: 'H', urgency: 2.0 },
                { uuid: 'uuid-3', description: 'Work project', status: 'pending', project: 'Work', urgency: 1.5 },
                { uuid: 'uuid-4', description: 'Urgent task', status: 'pending', tags: ['urgent'], urgency: 3.0 }
            );

            const { vm } = mountWithBackend(backend);
            await flushPromises(vm, 6);

            // Load taskrc to parse colors
            await vm.loadTaskrc();
            await flushPromises(vm, 2);

            // Check that color rules are parsed
            expect(vm.taskrcColorRules).toBeDefined();
            expect(vm.taskrcColorRules.pending).toBeDefined();
            expect(vm.taskrcColorRules.pending.color).toBe('#0000ff');

            // Check that color styles are applied correctly
            const pendingTask = { status: 'pending' };
            const style1 = vm.getTaskColorStyle(pendingTask);
            expect(style1.color).toBe('#0000ff');

            const highPriorityTask = { status: 'pending', priority: 'H' };
            const style2 = vm.getTaskColorStyle(highPriorityTask);
            expect(style2.color).toBe('#ff0000');
            expect(style2.fontWeight).toBe('bold');

            const workTask = { status: 'pending', project: 'Work' };
            const style3 = vm.getTaskColorStyle(workTask);
            expect(style3.color).toBe('#ffff00');
            expect(style3.backgroundColor).toMatch(/^#/);

            const urgentTask = { status: 'pending', tags: ['urgent'] };
            const style4 = vm.getTaskColorStyle(urgentTask);
            expect(style4.color).toBe('#ff0000');
            expect(style4.textDecoration).toBe('underline');
        });

        test('handles taskrc without color config gracefully', async () => {
            const backend = createMockBackend();
            backend.state.taskrc = `
# TaskWarrior configuration
data.location=/home/user/.task
            `.trim();

            backend.state.tasks.push(
                { uuid: 'uuid-1', description: 'Task without colors', status: 'pending', urgency: 1.0 }
            );

            const { vm } = mountWithBackend(backend);
            await flushPromises(vm, 6);

            // Load taskrc
            await vm.loadTaskrc();
            await flushPromises(vm, 2);

            // Check that no color rules are parsed
            expect(vm.taskrcColorRules).toEqual({});

            // Check that getTaskColorStyle returns empty object
            const task = { status: 'pending' };
            const style = vm.getTaskColorStyle(task);
            expect(style).toEqual({});
        });

        test('re-parses colors after saving taskrc', async () => {
            const backend = createMockBackend();
            backend.state.taskrc = `# No colors`;

            const { vm } = mountWithBackend(backend);
            await flushPromises(vm, 6);

            // Load taskrc
            await vm.loadTaskrc();
            await flushPromises(vm, 2);
            expect(vm.taskrcColorRules).toEqual({});

            // Update taskrc with colors
            vm.taskrcText = `color.pending=red`;
            await vm.saveTaskrc();
            await flushPromises(vm, 2);

            // Check that colors are now parsed
            expect(vm.taskrcColorRules.pending).toBeDefined();
            expect(vm.taskrcColorRules.pending.color).toBe('#ff0000');
        });
    });
});
