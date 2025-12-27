/** @jest-environment node */

const { TextDecoder, TextEncoder } = require('util');

global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;

const fs = require('fs');
const os = require('os');
const path = require('path');
const request = require('supertest');

const { createApp } = require('../../backend/server.js');

function tmpPath(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `taskwarrior-web-${prefix}-`));
    return dir;
}

describe('Backend API (supertest)', () => {
    test('taskrc roundtrip (GET then PUT)', async () => {
        const dir = tmpPath('taskrc');
        const taskrcPath = path.join(dir, 'taskrc');
        const dbPath = path.join(dir, 'settings.sqlite');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const getRes = await request(app).get('/api/taskrc');
        expect(getRes.status).toBe(200);
        expect(getRes.text).toContain('data.location=');

        const putRes = await request(app).put('/api/taskrc').set('Content-Type', 'text/plain').send('data.location=/tmp\n');
        expect(putRes.status).toBe(200);

        const getRes2 = await request(app).get('/api/taskrc');
        expect(getRes2.text).toContain('data.location=/tmp');
    });

    test('filters CRUD + reorder', async () => {
        const dir = tmpPath('filters');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const createA = await request(app).post('/api/filters').send({ name: 'A', filter: 'status:pending', icon: '🏠', group_by: 'project' });
        expect(createA.status).toBe(200);
        expect(createA.body.filter.icon).toBe('🏠');
        expect(createA.body.filter.group_by).toBe('project');
        const idA = createA.body.filter.id;

        const createB = await request(app).post('/api/filters').send({ name: 'B', filter: 'status:pending project:Home' });
        expect(createB.status).toBe(200);
        const idB = createB.body.filter.id;

        const list1 = await request(app).get('/api/filters');
        expect(list1.body.success).toBe(true);
        expect(list1.body.filters.map((f) => f.id)).toEqual([idA, idB]);
        expect(list1.body.filters[0].icon).toBe('🏠');
        expect(list1.body.filters[0].group_by).toBe('project');

        const reorder = await request(app).put('/api/filters/reorder').send({ ids: [idB, idA] });
        expect(reorder.status).toBe(200);
        expect(reorder.body.success).toBe(true);

        const list2 = await request(app).get('/api/filters');
        expect(list2.body.filters.map((f) => f.id)).toEqual([idB, idA]);

        const update = await request(app).put(`/api/filters/${idB}`).send({ name: 'B2', icon: '💼', group_by: 'tags' });
        expect(update.status).toBe(200);
        expect(update.body.filter.name).toBe('B2');
        expect(update.body.filter.icon).toBe('💼');
        expect(update.body.filter.group_by).toBe('tags');

        const clearGroup = await request(app).put(`/api/filters/${idB}`).send({ group_by: '' });
        expect(clearGroup.status).toBe(200);
        expect(clearGroup.body.filter.group_by).toBe(null);

        const del = await request(app).delete(`/api/filters/${idA}`);
        expect(del.status).toBe(200);

        const list3 = await request(app).get('/api/filters');
        expect(list3.body.filters).toHaveLength(1);
        expect(list3.body.filters[0].id).toBe(idB);
    });

    test('filters icon validation + clearing', async () => {
        const dir = tmpPath('filters-icon');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const tooLong = await request(app)
            .post('/api/filters')
            .send({ name: 'A', filter: 'status:pending', icon: 'x'.repeat(17) });
        expect(tooLong.status).toBe(400);
        expect(tooLong.body.success).toBe(false);

        const created = await request(app)
            .post('/api/filters')
            .send({ name: 'A', filter: 'status:pending', icon: '🏠' });
        const id = created.body.filter.id;

        const cleared = await request(app).put(`/api/filters/${id}`).send({ icon: null });
        expect(cleared.status).toBe(200);
        expect(cleared.body.success).toBe(true);
        expect(cleared.body.filter.icon).toBe(null);

        const list = await request(app).get('/api/filters');
        expect(list.body.filters[0].icon).toBe(null);

        const tooLongUpdate = await request(app).put(`/api/filters/${id}`).send({ icon: 'x'.repeat(17) });
        expect(tooLongUpdate.status).toBe(400);
        expect(tooLongUpdate.body.success).toBe(false);
    });



    test('filters: negative paths (reorder validation + invalid ids)', async () => {
        const dir = tmpPath('filters-invalid');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const createA = await request(app).post('/api/filters').send({ name: 'A', filter: 'status:pending' });
        const createB = await request(app).post('/api/filters').send({ name: 'B', filter: 'status:pending' });
        const idA = createA.body.filter.id;
        const idB = createB.body.filter.id;

        const emptyIds = await request(app).put('/api/filters/reorder').send({ ids: [] });
        expect(emptyIds.status).toBe(400);
        expect(emptyIds.body.success).toBe(false);

        const dupIds = await request(app).put('/api/filters/reorder').send({ ids: [idA, idA] });
        expect(dupIds.status).toBe(400);
        expect(dupIds.body.success).toBe(false);

        const unknownId = await request(app).put('/api/filters/reorder').send({ ids: [idA, 123456, idB] });
        expect(unknownId.status).toBe(404);
        expect(unknownId.body.success).toBe(false);

        const invalidUpdate = await request(app).put('/api/filters/not-a-number').send({ name: 'X' });
        expect(invalidUpdate.status).toBe(400);
        expect(invalidUpdate.body.success).toBe(false);

        const missingUpdate = await request(app).put('/api/filters/99999').send({ name: 'X' });
        expect(missingUpdate.status).toBe(404);
        expect(missingUpdate.body.success).toBe(false);

        const invalidDelete = await request(app).delete('/api/filters/not-a-number');
        expect(invalidDelete.status).toBe(400);
        expect(invalidDelete.body.success).toBe(false);

        const missingDelete = await request(app).delete('/api/filters/99999');
        expect(missingDelete.status).toBe(404);
        expect(missingDelete.body.success).toBe(false);
    });

    test('settings API (default + update)', async () => {
        const dir = tmpPath('settings');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const getDefault = await request(app).get('/api/settings');
        expect(getDefault.status).toBe(200);
        expect(getDefault.body.success).toBe(true);
        expect(getDefault.body.settings.reschedule_field).toBe('due');

        const put = await request(app).put('/api/settings').send({ reschedule_field: 'wait' });
        expect(put.status).toBe(200);
        expect(put.body.success).toBe(true);
        expect(put.body.settings.reschedule_field).toBe('wait');

        const getAfter = await request(app).get('/api/settings');
        expect(getAfter.body.settings.reschedule_field).toBe('wait');
    });

    test('settings API validates reschedule_field', async () => {
        const dir = tmpPath('settings-validation');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const missing = await request(app).put('/api/settings').send({});
        expect(missing.status).toBe(400);
        expect(missing.body.success).toBe(false);
        expect(String(missing.body.error)).toContain('reschedule_field');

        const wrongType = await request(app).put('/api/settings').send({ reschedule_field: 123 });
        expect(wrongType.status).toBe(400);
        expect(wrongType.body.success).toBe(false);

        const empty = await request(app).put('/api/settings').send({ reschedule_field: '   ' });
        expect(empty.status).toBe(400);
        expect(empty.body.success).toBe(false);

        const invalidChars = await request(app).put('/api/settings').send({ reschedule_field: 'due;rm -rf' });
        expect(invalidChars.status).toBe(400);
        expect(invalidChars.body.success).toBe(false);
    });

    test('builtin filters API (seed + update)', async () => {
        const dir = tmpPath('builtin-filters');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const list = await request(app).get('/api/builtin-filters');
        expect(list.status).toBe(200);
        expect(list.body.success).toBe(true);
        expect(Array.isArray(list.body.filters)).toBe(true);

        const byKey = new Map(list.body.filters.map((f) => [f.key, f]));

        expect(byKey.has('today')).toBe(true);
        expect(byKey.has('next')).toBe(true);
        expect(byKey.has('all')).toBe(true);

        expect(byKey.get('today').filter).toBe('due:today status:pending');
        expect(byKey.get('today').group_by).toBe(null);

        const update = await request(app)
            .put('/api/builtin-filters/today')
            .send({ name: 'My Today', visible: false, filter: 'due:tomorrow status:pending', group_by: 'project' });
        expect(update.status).toBe(200);
        expect(update.body.success).toBe(true);
        expect(update.body.filter.key).toBe('today');
        expect(update.body.filter.name).toBe('My Today');
        expect(update.body.filter.filter).toBe('due:tomorrow status:pending');
        expect(update.body.filter.visible).toBe(0);
        expect(update.body.filter.group_by).toBe('project');

        const list2 = await request(app).get('/api/builtin-filters');
        const byKey2 = new Map(list2.body.filters.map((f) => [f.key, f]));
        expect(byKey2.get('today').name).toBe('My Today');
        expect(byKey2.get('today').visible).toBe(0);
        expect(byKey2.get('today').group_by).toBe('project');

        const clearGroup = await request(app)
            .put('/api/builtin-filters/today')
            .send({ group_by: '' });
        expect(clearGroup.status).toBe(200);
        expect(clearGroup.body.filter.group_by).toBe(null);

        const list3 = await request(app).get('/api/builtin-filters');
        const byKey3 = new Map(list3.body.filters.map((f) => [f.key, f]));
        expect(byKey3.get('today').group_by).toBe(null);
    });

    test('builtin filters API: negative paths (missing/unknown key + empty name)', async () => {
        const dir = tmpPath('builtin-filters-invalid');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => ({ stdout: '', stderr: '' }),
        });

        const missingKey = await request(app).put('/api/builtin-filters/%20').send({ name: 'X' });
        expect(missingKey.status).toBe(400);
        expect(missingKey.body.success).toBe(false);

        const unknownKey = await request(app).put('/api/builtin-filters/unknown').send({ name: 'X' });
        expect(unknownKey.status).toBe(404);
        expect(unknownKey.body.success).toBe(false);

        const emptyName = await request(app).put('/api/builtin-filters/today').send({ name: '   ' });
        expect(emptyName.status).toBe(400);
        expect(emptyName.body.success).toBe(false);
    });

    test('/api/task proxies to execTaskOverride and tokenizes string args', async () => {
        const dir = tmpPath('task');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const calls = [];
        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async (argsArray) => {
                calls.push(argsArray);
                return { stdout: JSON.stringify(argsArray), stderr: '' };
            },
        });

        const res = await request(app)
            .post('/api/task')
            .send({ args: "add 'Hello world' project:Home" });

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('add');
        expect(calls[0]).toContain('Hello world');
        expect(calls[0]).toContain('project:Home');
    });

    test('/api/task rejects missing args and returns success:false on exec error', async () => {
        const dir = tmpPath('task-invalid');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async () => {
                const err = new Error('boom');
                err.stderr = 'bad\n';
                throw err;
            },
        });

        const missing = await request(app).post('/api/task').send({});
        expect(missing.status).toBe(400);
        expect(missing.body.success).toBe(false);

        const res = await request(app).post('/api/task').send({ args: ['export'] });
        expect(res.status).toBe(200);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('bad');
    });

    test('/api/complete returns suggestions from task completion helpers', async () => {
        const dir = tmpPath('complete');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async (args) => {
                const str = args.join(' ');
                if (str.includes('_get rc.abbreviation.minimum')) return { stdout: '2\n', stderr: '' };
                if (str.includes('_projects')) return { stdout: 'Home\nWork\n', stderr: '' };
                if (str.includes('_tags')) return { stdout: 'groceries\nurgent\n', stderr: '' };
                if (str.includes('_columns')) return { stdout: 'project\ndue\nstatus\n', stderr: '' };
                if (str.includes('_config')) return { stdout: 'color\nverbose\n', stderr: '' };
                if (str.includes('_commands')) return { stdout: 'add\ninfo\n', stderr: '' };
                if (str.includes('_aliases')) return { stdout: 'ls\n', stderr: '' };
                if (str.includes('_ids')) return { stdout: '1\n2\n', stderr: '' };
                return { stdout: '', stderr: '' };
            },
        });

        const proj = await request(app).get('/api/complete').query({ token: 'project:Ho', limit: 20 });
        expect(proj.status).toBe(200);
        expect(proj.body.success).toBe(true);
        expect(proj.body.suggestions).toEqual(['project:Home']);

        const tag = await request(app).get('/api/complete').query({ token: '+ur', limit: 20 });
        expect(tag.body.suggestions).toEqual(['+urgent']);

        const status = await request(app).get('/api/complete').query({ token: 'status:co', limit: 20 });
        expect(status.body.suggestions).toEqual(['status:completed']);

        const generic = await request(app).get('/api/complete').query({ token: 'rc.', limit: 20 });
        expect(generic.body.suggestions.some((s) => s.startsWith('rc.'))).toBe(true);
    });

    test('/api/complete respects limit and returns 500 on exec error', async () => {
        const dir = tmpPath('complete-invalid');
        const dbPath = path.join(dir, 'settings.sqlite');
        const taskrcPath = path.join(dir, 'taskrc');

        const app = createApp({
            taskdataPath: dir,
            taskrcPath,
            settingsDbPath: dbPath,
            execTaskOverride: async (args) => {
                const str = args.join(' ');
                if (str.includes('_get rc.abbreviation.minimum')) return { stdout: '1\n', stderr: '' };
                if (str.includes('_columns')) return { stdout: 'alpha\nalphabet\nalpine\n', stderr: '' };
                throw new Error('task-failed');
            },
        });

        const limited = await request(app).get('/api/complete').query({ token: 'a', limit: 1 });
        expect(limited.status).toBe(200);
        expect(limited.body.success).toBe(true);
        expect(limited.body.suggestions).toHaveLength(1);

        const errorRes = await request(app).get('/api/complete').query({ token: 'project:x', limit: 5 });
        expect(errorRes.status).toBe(500);
        expect(errorRes.body.success).toBe(false);
    });
});
