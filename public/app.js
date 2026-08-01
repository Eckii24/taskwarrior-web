// CQRS - Command Query Responsibility Segregation

(function (root, factory) {
    const isCommonJs = typeof module !== 'undefined' && module.exports && typeof require === 'function';
    if (isCommonJs) {
        // Vue compiler build is required because we mount from DOM templates.
        // eslint-disable-next-line global-require
        module.exports = factory(require('vue/dist/vue.cjs.js'), { autoMount: false });
    } else {
        root.TaskwarriorWeb = factory(root.Vue, { autoMount: true });
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Vue, options) {

class TaskApiClient {
    constructor(baseUrl = '/api', fetchImpl) {
        this.baseUrl = baseUrl;

        const defaultFetch = (() => {
            if (typeof fetch !== 'function') return null;

            try {
                return fetch.bind(typeof globalThis !== 'undefined' ? globalThis : null);
            } catch {
                return fetch;
            }
        })();

        this.fetchImpl = fetchImpl || defaultFetch;
    }

    requireFetch() {
        if (typeof this.fetchImpl !== 'function') {
            throw new Error('fetch is not available (cannot call backend)');
        }
    }

    async execute(args, annotation) {
        try {
            this.requireFetch();

            const body = { args };
            if (annotation !== undefined) {
                body.annotation = annotation;
            }

            const response = await this.fetchImpl(`${this.baseUrl}/task`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            return await response.json();
        } catch (error) {
            return { success: false, error: error.message };
        }
    }

    async complete(token, limit = 20) {
        try {
            this.requireFetch();

            const origin = (typeof window !== 'undefined' && window.location && window.location.origin)
                ? window.location.origin
                : 'http://localhost';

            const url = new URL(`${this.baseUrl}/complete`, origin);
            url.searchParams.set('token', token);
            url.searchParams.set('limit', String(limit));

            const response = await this.fetchImpl(url.toString(), {
                method: 'GET',
                headers: { 'Accept': 'application/json' },
            });

            return await response.json();
        } catch (error) {
            return { success: false, error: error.message, suggestions: [] };
        }
    }

    async getFilters() {
        this.requireFetch();
        const response = await this.fetchImpl(`${this.baseUrl}/filters`);
        return await response.json();
    }

    async createFilter(payload) {
        this.requireFetch();
        const response = await this.fetchImpl(`${this.baseUrl}/filters`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await response.json();
    }

    async updateFilter(id, payload) {
        this.requireFetch();
        const response = await this.fetchImpl(`${this.baseUrl}/filters/${id}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        return await response.json();
    }

    async deleteFilter(id) {
        this.requireFetch();
        const response = await this.fetchImpl(`${this.baseUrl}/filters/${id}`, { method: 'DELETE' });
        return await response.json();
    }

    async reorderFilters(ids) {
        this.requireFetch();
        const response = await this.fetchImpl(`${this.baseUrl}/filters/reorder`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ids }),
        });
        return await response.json();
    }

     async getBuiltinFilters() {
          this.requireFetch();
          const response = await this.fetchImpl(`${this.baseUrl}/builtin-filters`);
          return await response.json();
      }

      async getReports() {
          this.requireFetch();
          const response = await this.fetchImpl(`${this.baseUrl}/reports`);
          return await response.json();
      }


     async updateBuiltinFilter(key, payload) {
         this.requireFetch();
         const response = await this.fetchImpl(`${this.baseUrl}/builtin-filters/${encodeURIComponent(String(key))}`, {
             method: 'PUT',
             headers: { 'Content-Type': 'application/json' },
             body: JSON.stringify(payload),
         });
         return await response.json();
     }

      async getSettings() {
          this.requireFetch();
          const response = await this.fetchImpl(`${this.baseUrl}/settings`);
          return await response.json();
      }
 
      async updateSettings(payload) {
          this.requireFetch();
          const response = await this.fetchImpl(`${this.baseUrl}/settings`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(payload),
          });
          return await response.json();
      }
  }

 class TaskQueryService {
     constructor(apiClient) {
         this.apiClient = apiClient;
         this.groupSortValueOrders = new Map();

         this.reportCache = {
             value: null,
             expiresAt: 0,
         };
     }

      async getReportNamesCached(ttlMs = 15000) {
          const now = Date.now();
          if (this.reportCache.value && this.reportCache.expiresAt > now) {
              return this.reportCache.value;
          }

          const result = await this.apiClient.getReports();
          const reports = result?.success && Array.isArray(result.reports) ? result.reports : [];

          const set = new Set(reports.map((value) => String(value || '').trim()).filter(Boolean));

          this.reportCache = {
              value: set,
              expiresAt: now + ttlMs,
          };

          return set;
      }


    async getTaskConfig(key) {
        const configKey = String(key || '').trim();
        if (!configKey) return null;

        const result = await this.apiClient.execute(`rc.hooks=0 _get rc.${sanitizeTaskCommandArg(configKey)}`);
        if (!result?.success) return null;

        const output = String(result?.output || '').trim();
        if (!output) return null;

        // Taskwarrior may return quoted values.
        return stripOuterQuotes(output);
    }

    async getGroupOrderForField(field) {
        const groupBy = String(field || '').trim();
        if (!groupBy) return null;

        if (this.groupSortValueOrders.has(groupBy)) {
            return this.groupSortValueOrders.get(groupBy);
        }

        const configKey = `uda.${groupBy}.values`;
        let order = null;

        try {
            const raw = await this.getTaskConfig(configKey);
            if (raw) {
                const values = raw
                    .split(',')
                    .map((value) => String(value || '').trim())
                    .filter(Boolean);

                if (values.length > 0) {
                    order = values;
                }
            }
        } catch {
            order = null;
        }

        this.groupSortValueOrders.set(groupBy, order);
        return order;
    }


    async groupTasks(tasks, groupBy) {
        if (!groupBy || groupBy === 'none') {
            return [{ key: null, name: null, tasks }];
        }

        const groups = new Map();

        for (const task of tasks) {
            let groupKeys = [];

            switch (groupBy) {
                case 'project':
                    groupKeys = [task?.project || '(No Project)'];
                    break;

                case 'priority':
                    groupKeys = [task?.priority || '(No Priority)'];
                    break;

                case 'status':
                    groupKeys = [task?.status || 'unknown'];
                    break;

                case 'tags':
                    if (Array.isArray(task?.tags) && task.tags.length > 0) {
                        groupKeys = task.tags;
                    } else {
                        groupKeys = ['(No Tags)'];
                    }
                    break;

                default:
                    // For UDAs or other fields, use the field value directly
                    groupKeys = [task?.[groupBy] || `(No ${groupBy})`];
                    break;
            }

            for (const groupKey of groupKeys) {
                if (!groups.has(groupKey)) {
                    groups.set(groupKey, []);
                }
                groups.get(groupKey).push(task);
            }
        }

        const result = [];
        for (const [key, groupTasks] of groups.entries()) {
            result.push({
                key,
                name: String(key),
                tasks: groupTasks,
            });
        }

        const groupOrder = await this.getGroupOrderForField(groupBy);
        const indexFor = (name) => {
            if (!Array.isArray(groupOrder)) return null;
            const idx = groupOrder.findIndex((entry) => String(entry) === String(name));
            return idx >= 0 ? idx : null;
        };

        // Sort groups by configured UDA order when available, otherwise alphabetically.
        // Unknown keys fall back to alphabetical and are put after the known ones.
        result.sort((a, b) => {
            const aName = String(a.name || '');
            const bName = String(b.name || '');

            const aIdx = indexFor(aName);
            const bIdx = indexFor(bName);

            if (aIdx !== null && bIdx !== null) return aIdx - bIdx;
            if (aIdx !== null) return -1;
            if (bIdx !== null) return 1;

            return aName.localeCompare(bName);
        });

        return result;
    }

     async getTasks(filterOrReport, groupBy = null) {
          // Preserve "" as a valid filter expression (meaning "export all").
          // Only default to "next" when no argument was provided.
           const normalized = filterOrReport === undefined ? 'next' : String(filterOrReport || '').trim();
 
          const tokens = normalized ? normalized.split(/\s+/).filter(Boolean) : [];
 
          const reportNames = normalized && tokens.length > 0
              ? await this.getReportNamesCached()
              : new Set();
 
          let report = null;
          let filterTokens = tokens;
          if (tokens.length > 0) {
              const maybeReport = tokens[tokens.length - 1];
              if (reportNames.has(maybeReport)) {
                  report = maybeReport;
                  filterTokens = tokens.slice(0, -1);
              }
          }
 
          const argsFilterPart = filterTokens.length > 0 ? `${filterTokens.join(' ')} ` : '';
          const args = report ? `${argsFilterPart}export ${report}` : (normalized ? `${normalized} export` : 'export');
 
          const result = await this.apiClient.execute(args);
 
          if (!result?.success) {
              throw new Error(result?.error || 'Failed to load tasks');
          }
 
          const rawOutput = String(result?.output || '');
          if (!rawOutput.trim()) return { tasks: [], groups: [] };
 
          try {
              let tasks = JSON.parse(rawOutput);
              if (!Array.isArray(tasks)) {
                  tasks = tasks ? [tasks] : [];
              }
 
              // Taskwarrior's JSON export does not necessarily preserve report sorting.
              // If we invoked a report: apply report sort settings manually.
              // Otherwise default to urgency desc.
              if (tasks.length > 1) {
                  if (report) {
                      const sortConfigRaw = await this.getTaskConfig(`report.${report}.sort`);
                      const sortConfig = String(sortConfigRaw || '').trim();
                      if (sortConfig) {
                          tasks = sortTasksByReportSort(tasks, sortConfig);
                      }
                  }
 
                  if (!report) {
                      tasks = tasks.slice().sort((a, b) => {
                          const aUrg = Number(a?.urgency) || 0;
                          const bUrg = Number(b?.urgency) || 0;
                          return bUrg - aUrg;
                      });
                  }
              }
 
              const groups = await this.groupTasks(tasks, groupBy);
              return { tasks, groups };
          } catch (error) {
              throw new Error(`Failed to parse task export JSON: ${error.message}`);
          }
      }
}

class TaskCommandService {
    constructor(apiClient) {
        this.apiClient = apiClient;
    }

    async addTask(taskArgs, annotation) {
        if (Array.isArray(taskArgs)) {
            const args = taskArgs.map((value) => String(value ?? '')).filter((value) => value.length > 0);
            if (args.length === 0) return { success: false, output: '', error: 'No task description provided' };
            return await this.apiClient.execute(['add', ...args], annotation);
        }

        return await this.apiClient.execute(`add ${String(taskArgs || '').trim()}`, annotation);
    }

    async modifyTask(taskUuid, ...modifications) {
        const uuid = String(taskUuid || '').trim();
        if (!uuid) return { success: false, output: '', error: 'No task ID provided' };

        const mods = modifications
            .flat()
            .map((value) => String(value || '').trim())
            .filter(Boolean);

        if (mods.length === 0) {
            return { success: false, output: '', error: 'No modifications provided' };
        }

        return await this.apiClient.execute([uuid, 'modify', ...mods]);
    }

    async modifyTasks(taskUuids, modifications) {
        const uuids = Array.isArray(taskUuids) ? taskUuids.map((uuid) => String(uuid || '').trim()).filter(Boolean) : [];
        if (uuids.length === 0) {
            return { success: false, output: '', error: 'No task IDs provided' };
        }

        if (Array.isArray(modifications)) {
            const mods = modifications.map((value) => String(value || '').trim()).filter(Boolean);
            if (mods.length === 0) {
                return { success: false, output: '', error: 'No modifications provided' };
            }
            return await this.apiClient.execute([...uuids, 'mod', ...mods]);
        }

        const mods = String(modifications || '').trim();
        if (!mods) {
            return { success: false, output: '', error: 'No modifications provided' };
        }

        return await this.apiClient.execute(`${uuids.join(' ')} mod ${mods}`);
    }

    async completeTask(taskUuid) {
        return await this.apiClient.execute([String(taskUuid), 'done']);
    }

    async markPending(taskUuid) {
        return await this.apiClient.execute([String(taskUuid), 'mod', 'status:pending']);
    }

    async deleteTask(taskUuid) {
        return await this.apiClient.execute([String(taskUuid), 'delete']);
    }

    async annotateTask(taskUuid, annotationText) {
        return await this.apiClient.execute([String(taskUuid), 'annotate', String(annotationText)]);
    }

    async denotateTask(taskUuid, pattern) {
        return await this.apiClient.execute([String(taskUuid), 'denotate', String(pattern)]);
    }

    async exportTask(taskUuid) {
        return await this.apiClient.execute([String(taskUuid), 'export']);
    }

    async showTask(taskUuid) {
        return await this.apiClient.execute([String(taskUuid)]);
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

const DEFAULT_ATTR_ABBREV_MIN = 2;
const DATE_VALUE_ATTRS = ['due', 'wait', 'until', 'scheduled', 'start', 'end'];

function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getTaskSortValue(task, field) {
    const key = String(field || '').trim();
    if (!key) return null;

    const raw = task ? task[key] : undefined;
    if (raw === undefined || raw === null) return null;

    if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;

    const asNumber = Number(raw);
    if (typeof raw !== 'boolean' && String(raw).trim() !== '' && Number.isFinite(asNumber)) {
        return asNumber;
    }

    return String(raw);
}

function compareTaskSortValues(aValue, bValue) {
    if (aValue === null && bValue === null) return 0;
    if (aValue === null) return 1;
    if (bValue === null) return -1;

    if (typeof aValue === 'number' && typeof bValue === 'number') {
        return aValue - bValue;
    }

    return String(aValue).localeCompare(String(bValue));
}

function sortTasksByReportSort(tasks, sortConfig) {
    const sortRaw = String(sortConfig || '').trim();
    if (!sortRaw) return tasks;

    const parts = sortRaw.split(',').map((part) => String(part || '').trim()).filter(Boolean);
    if (parts.length === 0) return tasks;

    const criteria = parts.map((part) => {
        const tokens = part.split(/\s+/).filter(Boolean);
        const field = tokens[0] ? String(tokens[0]).trim() : '';
        const dirToken = tokens[1] ? String(tokens[1]).toLowerCase() : 'ascending';
        const descending = dirToken === 'descending' || dirToken === 'desc' || dirToken === 'down';
        return { field, descending };
    }).filter((entry) => entry.field);

    if (criteria.length === 0) return tasks;

    return tasks.slice().sort((a, b) => {
        for (const { field, descending } of criteria) {
            const cmp = compareTaskSortValues(getTaskSortValue(a, field), getTaskSortValue(b, field));
            if (cmp !== 0) {
                return descending ? -cmp : cmp;
            }
        }

        return 0;
    });
}

function resolveAbbreviatedAttr(typedAttr, candidates = DATE_VALUE_ATTRS, minLen = DEFAULT_ATTR_ABBREV_MIN) {
    const typed = String(typedAttr || '').trim();
    if (!typed) return null;

    const normalized = typed.toLowerCase();

    const direct = candidates.find((value) => value === normalized);
    if (direct) return direct;

    if (normalized.length < minLen) return null;

    const matches = candidates.filter((value) => value.startsWith(normalized));
    if (matches.length === 1) return matches[0];

    return null;
}

function resolveTaskFieldName(obj, typedField) {
    if (!obj) return null;

    const raw = String(typedField || '').trim();
    if (!raw) return null;

    if (Object.prototype.hasOwnProperty.call(obj, raw)) return raw;

    const canonical = resolveAbbreviatedAttr(raw);
    if (canonical && Object.prototype.hasOwnProperty.call(obj, canonical)) return canonical;

    const matches = Object.keys(obj).filter((key) => key.startsWith(raw));
    if (matches.length === 1) return matches[0];

    return null;
}

function sanitizeTaskCommandArg(value) {
    const text = String(value ?? '').replace(/[\r\n\t]/g, ' ').trim();
    if (!text) return "''";

    // Prefer single quotes; escape embedded single quotes in a shell-like way.
    // Taskwarrior parses quotes; our backend splits on whitespace, so wrapping is required.
    return `'${text.replace(/'/g, "\\'")}'`;
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

function createTaskwarriorApp({
    baseUrl = '/api',
    fetchImpl,
} = {}) {
    const apiClient = new TaskApiClient(baseUrl, fetchImpl);
    const fetchFn = apiClient.fetchImpl;
    const queryService = new TaskQueryService(apiClient);
    const commandService = new TaskCommandService(apiClient);

    // Prime report cache early so initial loads/restores can use it.
    queryService.getReportNamesCached().catch(() => {});

    const { createApp } = Vue;

    const app = createApp({
    data() {
        return {
             drawerOpen: false,
             showTaskrc: false,

             gestures: {
                 edgeSwipe: {
                     active: false,
                     startX: 0,
                     startY: 0,
                     pointerId: null,
                 },
                 pullToRefresh: {
                     active: false,
                     startY: 0,
                     startScrollTop: 0,
                     pulled: 0,
                 },
             },

             pullRefreshUi: {
                 offset: 0,
                 dragging: false,
                 armed: false,
                 refreshing: false,
             },
            taskrcText: '',
            loadedTaskrcText: '',

            // TaskWarrior color rules
            taskrcColorRules: {},
            taskrcLoaded: false,
            taskrcLoading: false,
            taskrcLoadPromise: null,

              builtinFilters: {
                  today: { key: 'today', name: 'Today', filter: 'due:today status:pending', visible: true, group_by: null },
                  inbox: { key: 'inbox', name: 'Inbox', filter: 'status:pending project:', visible: true, group_by: null },
                  next: { key: 'next', name: 'Next', filter: 'status:pending limit:page', visible: true, group_by: null },
                  all: { key: 'all', name: 'All', filter: '', visible: true, group_by: null },
              },
              settingsBuiltinVisibilityDraft: {
                  today: { visible: true },
                  inbox: { visible: true },
                  next: { visible: true },
                  all: { visible: true },
              },

            settingsAppDraft: {
                reschedule_field: ['due'],
            },

            settingsAppLoaded: {
                reschedule_field: ['due'],
            },

             filters: [],
             draggedFilterId: null,
             insertionTarget: null,

             emojiPicker: {
                 filterIcons: ['⭐️', '🏠', '💼', '📌', '🧠', '🛒', '📅', '✅', '🔥', '🧹', '💡', '🧾', '📚', '🔁', '🎯', '🧰', '🔒', '🌱', '💤', '🧪'],
             },

             currentGroupBy: null,
             taskLoadRequestId: 0,
             completionRequestId: 0,


            selectedView: { type: 'builtin', key: 'next' },
            tasks: [],
            taskGroups: [],
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
                initialAnnotation: '', // For adding tasks with an initial annotation
                 showTaskDetails: false,
                 taskDetailsOutput: '',
                 // Annotations (Taskwarrior 'annotations' field)
                 showAnnotations: false,
                 annotationDraft: '',
                 annotations: [],
                 annotationEditKey: null,
                 annotationEditDraft: '',
                 // Original values for edit comparison
                 originalDescription: '',
                 originalProject: '',
                 originalTags: '',
                 originalPriority: '',
                 originalDue: '',
                 // Original values for filter editing
                 originalFilterName: '',
                 originalFilterValue: '',
                 // Attribute dropdown state
                 activeAttributeDropdown: null,
                 attributeInputValue: '',
            },

            modalEscHintVisible: false,
            modalEscForceCloseUntil: 0,
            modalEscHintTimeoutId: null,

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

            reschedule: {
                open: false,
                taskUuid: null,
                custom: '',
                fields: [],
                showFieldPicker: false,
            },

            groupDropdownOpen: false,
            groupOptions: [
                { value: null, label: 'None' },
                { value: 'project', label: 'Project' },
                { value: 'priority', label: 'Priority' },
                { value: 'tags', label: 'Tags' },
                { value: 'status', label: 'Status' },
            ],

            multiSelectMode: false,
            selectedTaskUuids: new Set(),
        };
    },
     computed: {
         pullRefreshIndicatorStyle() {
             const indicatorHeight = 54;
             const offset = Number(this.pullRefreshUi?.offset) || 0;
             return {
                 transform: `translateY(${offset - indicatorHeight}px)`,
                 opacity: offset > 0 || this.pullRefreshUi?.refreshing ? 1 : 0,
             };
         },
         pullRefreshContentStyle() {
             const offset = Number(this.pullRefreshUi?.offset) || 0;
             if (offset <= 0) return {};
             return {
                 transform: `translateY(${offset}px)`,
             };
         },
         pullRefreshSnapping() {
             return !this.pullRefreshUi?.dragging;
         },
         modalFilterIconLabel() {
            if (this.modal?.type !== 'filter') return '';
            const raw = String(this.modal?.filterIcon || '').trim();
            return raw || 'None';
        },
        taskrcDirty() {
            return this.taskrcText !== this.loadedTaskrcText;
        },
            currentTitle() {
             if (this.showTaskrc) return 'Settings';
             if (this.mainMode === 'output') return 'Command output';
             if (this.selectedView.type === 'search') return 'Search';

             if (this.selectedView.type === 'builtin') {
                 const key = String(this.selectedView.key || 'next');
                 const builtin = this.builtinFilters[key];
                 if (builtin && builtin.name) return builtin.name;
                 return key;
             }
             if (this.selectedView.type === 'filter') {
                 const filterId = Number(this.selectedView.id);
                 const filter = this.filters.find((f) => Number(f.id) === filterId);

                return filter ? filter.name : 'Filter';
            }
            return 'Taskwarrior';
        },
         modalTitle() {
             const map = {
                 add: 'Add Task',
                 edit: 'Edit Task',
                 'edit-multi': `Edit ${this.modal?.taskIds?.length || 0} Tasks`,
                 show: 'Task',
 
                 exec: 'Execute',
                 search: 'Search',
                 filter: this.modal.filterId ? 'Edit Filter' : 'Add Filter',
             };
             return map[this.modal.type] || 'Command';
         },
         modalSortedAnnotations() {
             const annotations = Array.isArray(this.modal?.annotations) ? this.modal.annotations : [];
             const list = annotations.slice();
             list.sort((a, b) => {
                 const aEntry = String(a?.entry || '');
                 const bEntry = String(b?.entry || '');
                 if (aEntry && bEntry) return bEntry.localeCompare(aEntry);
                 if (aEntry) return -1;
                 if (bEntry) return 1;
                 return 0;
             });
             return list;
         },
    },
         async mounted() {
         window.addEventListener('keydown', this.onGlobalKeydown);
         window.addEventListener('click', this.onGlobalClick);

         this.installGestureListeners();

         const restoredView = this.readPersistedSelectedView();

         await this.refreshBuiltinFilters();
         await this.refreshFilters();
         await this.refreshAppSettings();
         this.applyRestoredSelectedView(restoredView);

         // Load taskrc early so task color rules can be applied.
         // Do not block initial task load; when the rules arrive, Vue will re-render.
         this.ensureTaskrcLoaded();

         // Note: do not override any pre-set URL view params here.

         await this.loadTasksForSelection();

     },
     beforeUnmount() {
         window.removeEventListener('keydown', this.onGlobalKeydown);
         window.removeEventListener('click', this.onGlobalClick);

         this.removeGestureListeners();
         if (this.toastTimeoutId) clearTimeout(this.toastTimeoutId);
         if (this.modalEscHintTimeoutId) clearTimeout(this.modalEscHintTimeoutId);
     },
     methods: {
         installGestureListeners() {
             const isTouchDevice = typeof window !== 'undefined' && (
                 typeof window.ontouchstart !== 'undefined' ||
                 (typeof navigator !== 'undefined' && navigator.maxTouchPoints > 0)
             );
             if (!isTouchDevice) return;

             const main = this.$refs.mainScroller;
             if (!main || typeof main.addEventListener !== 'function') return;

             if (!this._gestureHandlers) {
                 this._gestureHandlers = {
                     touchStart: (event) => this.onTouchStart(event),
                     touchMove: (event) => this.onTouchMove(event),
                     touchEnd: (event) => this.onTouchEnd(event),
                 };
             }

             main.addEventListener('touchstart', this._gestureHandlers.touchStart, { passive: true });
             main.addEventListener('touchmove', this._gestureHandlers.touchMove, { passive: false });
             main.addEventListener('touchend', this._gestureHandlers.touchEnd, { passive: true });
             main.addEventListener('touchcancel', this._gestureHandlers.touchEnd, { passive: true });
         },

         removeGestureListeners() {
             const main = this.$refs.mainScroller;
             if (!main || !this._gestureHandlers) return;

             main.removeEventListener('touchstart', this._gestureHandlers.touchStart);
             main.removeEventListener('touchmove', this._gestureHandlers.touchMove);
             main.removeEventListener('touchend', this._gestureHandlers.touchEnd);
             main.removeEventListener('touchcancel', this._gestureHandlers.touchEnd);
         },

         getTouchPoint(event) {
             const touch = event?.touches?.[0] || event?.changedTouches?.[0];
             if (!touch) return null;
             return {
                 x: Number(touch.clientX) || 0,
                 y: Number(touch.clientY) || 0,
             };
         },

         onTouchStart(event) {
             const point = this.getTouchPoint(event);
             if (!point) return;
             if (this.pullRefreshUi.refreshing) return;

             // Edge swipe to open drawer.
             this.gestures.edgeSwipe = {
                 active: !this.drawerOpen && point.x <= 24,
                 startX: point.x,
                 startY: point.y,
                 pointerId: event?.touches?.[0]?.identifier ?? null,
             };

             this.pullRefreshUi.offset = 0;
             this.pullRefreshUi.dragging = false;
             this.pullRefreshUi.armed = false;

             // Pull to refresh (only when we're at top).
             const main = this.$refs.mainScroller;
             const startScrollTop = main && typeof main.scrollTop === 'number' ? main.scrollTop : 0;
             this.gestures.pullToRefresh = {
                 active: startScrollTop <= 0,
                 startY: point.y,
                 startScrollTop,
                 pulled: 0,
             };
         },

         onTouchMove(event) {
             const point = this.getTouchPoint(event);
             if (!point) return;
             if (this.pullRefreshUi.refreshing) return;

             // If drawer is open, let swipe/pull behave naturally.
             if (this.drawerOpen) return;

             const edge = this.gestures.edgeSwipe;
             if (edge.active) {
                 const dx = point.x - edge.startX;
                 const dy = Math.abs(point.y - edge.startY);

                 // Only treat as swipe if mostly horizontal.
                 if (dx > 55 && dy < 40) {
                     this.toggleDrawer(true);
                     this.gestures.edgeSwipe.active = false;
                 }
                 return;
             }

             const pull = this.gestures.pullToRefresh;
             if (!pull.active) return;

             const main = this.$refs.mainScroller;
             const scrollTop = main && typeof main.scrollTop === 'number' ? main.scrollTop : 0;
             if (scrollTop > 0) {
                 pull.active = false;
                 pull.pulled = 0;
                 this.pullRefreshUi.offset = 0;
                 this.pullRefreshUi.dragging = false;
                 this.pullRefreshUi.armed = false;
                 return;
             }

             const dy = point.y - pull.startY;
             if (dy <= 0) return;

             const threshold = 70;
             const maxPull = 90;
             const offset = Math.min(Math.round(dy), maxPull);

             pull.pulled = dy;
             this.pullRefreshUi.dragging = true;
             this.pullRefreshUi.offset = offset;
             this.pullRefreshUi.armed = offset >= threshold;

             // Prevent the rubber-band scroll from taking over.
             if (typeof event.preventDefault === 'function') {
                 event.preventDefault();
             }
         },

         async onTouchEnd() {
             const pull = this.gestures.pullToRefresh;
             const pulled = Number(pull?.pulled) || 0;
             const threshold = 70;
             const stickyOffset = 54;

             this.gestures.edgeSwipe.active = false;
             this.gestures.pullToRefresh.active = false;
             this.gestures.pullToRefresh.pulled = 0;

             if (this.drawerOpen) {
                 this.pullRefreshUi.offset = 0;
                 this.pullRefreshUi.dragging = false;
                 this.pullRefreshUi.armed = false;
                 return;
             }

             if (this.pullRefreshUi.refreshing) return;

             this.pullRefreshUi.dragging = false;

             if (pulled < threshold) {
                 this.pullRefreshUi.offset = 0;
                 this.pullRefreshUi.armed = false;
                 return;
             }

             this.pullRefreshUi.refreshing = true;
             this.pullRefreshUi.armed = false;
             this.pullRefreshUi.offset = stickyOffset;

             try {
                 await this.syncAndRefresh();
             } finally {
                 this.pullRefreshUi.refreshing = false;
                 this.pullRefreshUi.offset = 0;
             }
         },

        async syncAndRefresh() {
            await this.runSync();

            // Only reload tasks when the task list is currently visible.
            if (this.showTaskrc) return;
            if (this.mainMode !== 'tasks') return;

            await this.refreshCurrentPanel();
        },

         persistSelectedView(view) {
             try {
                 const safeView = view && typeof view === 'object' ? view : { type: 'builtin', key: 'next' };
                 const url = new URL(window.location.href);

                url.searchParams.delete('viewType');
                url.searchParams.delete('viewKey');
                url.searchParams.delete('filterId');

                if (safeView.type === 'builtin') {
                    url.searchParams.set('viewType', 'builtin');
                    url.searchParams.set('viewKey', String(safeView.key || 'next'));
                } else if (safeView.type === 'filter') {
                    url.searchParams.set('viewType', 'filter');
                    url.searchParams.set('filterId', String(safeView.id));
                } else if (safeView.type === 'search') {
                    url.searchParams.set('viewType', 'search');
                }

                window.history.replaceState({}, '', url.toString());
            } catch {
                // ignore
            }
        },

        readPersistedSelectedView() {
            try {
                const url = new URL(window.location.href);
                const viewType = String(url.searchParams.get('viewType') || '').trim();

                if (viewType === 'builtin') {
                    const key = String(url.searchParams.get('viewKey') || 'next');
                    return { type: 'builtin', key };
                }

                if (viewType === 'filter') {
                    const filterId = Number(url.searchParams.get('filterId'));
                    if (Number.isFinite(filterId)) return { type: 'filter', id: filterId };
                }

                if (viewType === 'search') {
                    return { type: 'search' };
                }

                return null;
            } catch {
                return null;
            }
        },

        applyRestoredSelectedView(candidateView) {
            if (!candidateView) return;

            if (candidateView.type === 'builtin') {
                const key = String(candidateView.key || 'next');
                const builtin = this.builtinFilters[key];
                const isHidden = builtin && builtin.visible === false;
                if (!isHidden) {
                    this.selectedView = { type: 'builtin', key };
                    this.showTaskrc = false;
                }
                return;
            }

            if (candidateView.type === 'filter') {
                const wantedId = Number(candidateView.id);
                const exists = this.filters.some((filter) => Number(filter.id) === wantedId);
                if (exists) {
                    this.selectedView = { type: 'filter', id: wantedId };
                    this.showTaskrc = false;
                }
                return;
            }

            if (candidateView.type === 'search') {
                this.selectedView = { type: 'search' };
                this.showTaskrc = false;
            }
        },

        isModalUnchangedOrEmpty() {
            if (!this.modal?.open) return true;

            const type = String(this.modal.type || '').trim();

            if (type === 'show') return true;

            if (type === 'add') {
                const descriptionEmpty = !String(this.modal.description || '').trim();
                const projectEmpty = !String(this.modal.project || '').trim();
                const tagsEmpty = !String(this.modal.tags || '').trim();
                const priorityEmpty = !String(this.modal.priority || '').trim();
                const dueEmpty = !String(this.modal.due || '').trim();
                const initialAnnotationEmpty = !String(this.modal.initialAnnotation || '').trim();

                const noAttributeDropdown = !this.modal.activeAttributeDropdown;
                const attributeValueEmpty = !String(this.modal.attributeInputValue || '').trim();

                return (
                    descriptionEmpty &&
                    projectEmpty &&
                    tagsEmpty &&
                    priorityEmpty &&
                    dueEmpty &&
                    initialAnnotationEmpty &&
                    noAttributeDropdown &&
                    attributeValueEmpty
                );
            }

            if (type === 'edit-multi') {
                const fields = ['value', 'project', 'tags', 'priority', 'due', 'attributeInputValue'];
                return fields.every((field) => !String(this.modal[field] || '').trim())
                    && !this.modal.activeAttributeDropdown;
            }

            if (type === 'edit') {
                const noAttributeDropdown = !this.modal.activeAttributeDropdown;
                const attributeValueEmpty = !String(this.modal.attributeInputValue || '').trim();

                const baseFieldsUnchanged =
                    String(this.modal.description || '') === String(this.modal.originalDescription || '') &&
                    String(this.modal.project || '') === String(this.modal.originalProject || '') &&
                    String(this.modal.tags || '') === String(this.modal.originalTags || '') &&
                    String(this.modal.priority || '') === String(this.modal.originalPriority || '') &&
                    String(this.modal.due || '') === String(this.modal.originalDue || '');

                const annotationsClean =
                    !String(this.modal.annotationDraft || '').trim() &&
                    !this.modal.annotationEditKey &&
                    !String(this.modal.annotationEditDraft || '').trim();

                return baseFieldsUnchanged && annotationsClean && noAttributeDropdown && attributeValueEmpty;
            }

            if (type === 'filter') {
                const name = String(this.modal.filterName || '');
                const filter = String(this.modal.filterValue || '');

                const nameUnchanged = name === String(this.modal.originalFilterName || '');
                const filterUnchanged = filter === String(this.modal.originalFilterValue || '');

                const emptyNew = !String(this.modal.filterId || '').trim() && !name.trim() && !filter.trim();

                return emptyNew || (nameUnchanged && filterUnchanged);
            }

            // search/exec/other single input modals
            const value = String(this.modal.value || '').trim();
            return !value;
        },

        showModalEscHint(durationMs = 3000) {
            const ms = Math.max(250, Number(durationMs) || 2000);
            const until = Date.now() + ms;

            this.modalEscHintVisible = true;
            this.modalEscForceCloseUntil = until;

            if (this.modalEscHintTimeoutId) clearTimeout(this.modalEscHintTimeoutId);
            this.modalEscHintTimeoutId = setTimeout(() => {
                this.modalEscHintVisible = false;
                this.modalEscForceCloseUntil = 0;
                this.modalEscHintTimeoutId = null;
            }, ms);
        },

        clearModalEscHint() {
            if (this.modalEscHintTimeoutId) clearTimeout(this.modalEscHintTimeoutId);
            this.modalEscHintVisible = false;
            this.modalEscForceCloseUntil = 0;
            this.modalEscHintTimeoutId = null;
        },

        onGlobalClick(event) {
            const target = event?.target;

            // Close group dropdown when clicking outside.
            if (this.groupDropdownOpen && !target?.closest('.tasks-controls')) {
                this.groupDropdownOpen = false;
            }

            // Keep the reschedule popover open only for clicks on its trigger or contents.
            if (this.reschedule.open && !target?.closest('.reschedule')) {
                this.closeReschedule();
            }
        },

        tryCloseModal() {
            if (!this.modal?.open) return true;

            const canClose = this.isModalUnchangedOrEmpty();
            const now = Date.now();

            if (canClose || (this.modalEscHintVisible && now <= this.modalEscForceCloseUntil)) {
                this.closeModal();
                return true;
            }

            this.showModalEscHint(3000);
            return false;
        },

        onGlobalKeydown(event) {
            if (event.key === 'Escape') {
                if (this.modal.open) {
                    this.tryCloseModal();
                }

                if (this.drawerOpen) this.toggleDrawer(false);
                this.closeReschedule();
                this.resetCompletion();
                this.groupDropdownOpen = false;
            }
        },

        toggleDrawer(open) {
            this.drawerOpen = Boolean(open);
        },

         openSettings() {
             this.beginTaskLoad();
             this.showTaskrc = true;
             this.persistSelectedView({ type: 'builtin', key: 'next' });
             this.mainMode = 'tasks';
             this.mainOutput = '';
             this.resetCompletion();
             this.toggleDrawer(false);

             this.refreshBuiltinFilters();
             this.refreshAppSettings();

             // Always load taskrc when opening settings to avoid stale color rules.
             this.loadTaskrc();
         },

        showToast(text, type = 'success', durationMs = 2500) {
            if (this.toastTimeoutId) clearTimeout(this.toastTimeoutId);
            this.toast = { text, type };
            this.toastTimeoutId = setTimeout(() => {
                this.toast = { text: '', type: 'success' };
                this.toastTimeoutId = null;
            }, durationMs);
        },

        renderMarkdown(text) {
            const input = String(text || '');

            // Tiny safe subset: paragraphs, line breaks, inline code, emphasis, links.
            const escapeHtml = (value) => String(value)
                .replaceAll('&', '&amp;')
                .replaceAll('<', '&lt;')
                .replaceAll('>', '&gt;')
                .replaceAll('"', '&quot;')
                .replaceAll("'", '&#39;');

            const fragments = [];
            let markerPrefix = '\uE000TW';
            while (input.includes(markerPrefix)) markerPrefix += 'X';
            const stash = (html) => {
                const marker = `${markerPrefix}${fragments.length}\uE001`;
                fragments.push(html);
                return marker;
            };

            // Protect generated markup from later regex passes. Without placeholders,
            // auto-linking rewrites URLs inside already generated <a href> attributes.
            let source = input.replace(/`([^`\n]+)`/g, (_match, code) => {
                return stash(`<code>${escapeHtml(code)}</code>`);
            });

            source = source.replace(/\[([^\]\n]+)]\((https?:\/\/[^\s)]+)\)/g, (_match, label, url) => {
                const safeUrl = escapeHtml(url);
                return stash(`<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`);
            });

            let output = escapeHtml(source);
            output = output.replace(/https?:\/\/[^\s<]+/g, (candidate) => {
                const trailingMatch = candidate.match(/[.,!?;:)\]}*]+$/);
                const trailing = trailingMatch ? trailingMatch[0] : '';
                const url = trailing ? candidate.slice(0, -trailing.length) : candidate;
                if (!url) return candidate;
                return `${stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)}${trailing}`;
            });

            output = output.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
            output = output.replace(/\*([^*]+)\*/g, '<em>$1</em>');
            output = output.replace(/\r\n?|\n/g, '<br>');

            fragments.forEach((fragment, index) => {
                output = output.replace(`${markerPrefix}${index}\uE001`, fragment);
            });

            return `<p>${output}</p>`;
        },

        resetCompletion() {
            this.completionRequestId += 1;
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

        closeReschedule() {
            if (!this.reschedule.open) return;
            this.reschedule = { open: false, taskUuid: null, custom: '', fields: [], showFieldPicker: false };
        },

        toggleReschedule(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            if (this.reschedule.open && this.reschedule.taskUuid === uuid) {
                this.closeReschedule();
                return;
            }

            this.reschedule = {
                open: true,
                taskUuid: uuid,
                custom: '',
                fields: this.rescheduleFieldNames(),
                showFieldPicker: false,
            };
        },

        isRescheduleFieldSelected(field, opts = {}) {
            const value = String(field || '').trim();
            if (!value) return false;

            const preferReschedule = Boolean(opts?.preferReschedule);

            const selected = preferReschedule && this.reschedule?.open
                ? (Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [])
                : (Array.isArray(this.settingsAppDraft?.reschedule_field) ? this.settingsAppDraft.reschedule_field : []);

            return selected.includes(value);
        },

        toggleRescheduleField(field, opts = {}) {
            const value = String(field || '').trim();
            if (!value) return;

            const allowEmpty = Boolean(opts?.allowEmpty);
            const preferReschedule = Boolean(opts?.preferReschedule);

            const currentSelected = preferReschedule && this.reschedule?.open
                ? (Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [])
                : (Array.isArray(this.settingsAppDraft?.reschedule_field) ? this.settingsAppDraft.reschedule_field : []);

            const selected = currentSelected.slice();

            const idx = selected.indexOf(value);
            if (idx >= 0) {
                if (!allowEmpty && selected.length <= 1) {
                    this.showToast('Select at least one attribute', 'error');
                    return;
                }
                selected.splice(idx, 1);
            } else {
                selected.push(value);
            }

            if (preferReschedule && this.reschedule?.open) {
                this.reschedule.fields = selected;
                return;
            }

            this.settingsAppDraft.reschedule_field = selected;
        },

        rescheduleFieldNames() {
            const raw = this.settingsAppLoaded?.reschedule_field;
            const list = Array.isArray(raw) ? raw : String(raw || 'due').split(',');
            return list
                .map((value) => String(value).trim())
                .filter(Boolean);
        },

        rescheduleFieldName() {
            const active = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : null;
            const list = Array.isArray(active) && active.length > 0 ? active : this.rescheduleFieldNames();
            return list[0] || 'due';
        },

        rescheduleFieldLabel() {
            const active = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : null;
            const fields = Array.isArray(active) && active.length > 0 ? active : this.rescheduleFieldNames();
            if (fields.length === 0) return 'Due';
            if (fields.length === 1) {
                const field = fields[0];
                return field ? `${field[0].toUpperCase()}${field.slice(1)}` : 'Due';
            }

            return 'Dates';
        },

        rescheduleFieldLabelForClear() {
            const active = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : null;
            const fields = Array.isArray(active) && active.length > 0 ? active : this.rescheduleFieldNames();
            if (fields.length === 0) return 'Due';
            if (fields.length === 1) {
                const field = fields[0];
                return field ? `${field[0].toUpperCase()}${field.slice(1)}` : 'Due';
            }

            return fields.map((field) => `${field[0].toUpperCase()}${field.slice(1)}`).join('/');
        },

        formatTaskDateInput(value) {
            const raw = String(value || '').trim();
            if (!raw) return '';

            const formatted = this.formatDate(raw);
            return formatted || raw;
        },

        async rescheduleTask(taskUuid, dateValue) {
            const uuid = String(taskUuid || '').trim();
            const value = String(dateValue || '').trim();
            if (!uuid || !value) return;

            const fieldsRaw = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [];
            const fields = fieldsRaw.map((f) => String(f).trim()).filter(Boolean);
            const modifications = fields.length > 0
                ? fields.map((f) => `${f}:${value}`)
                : [`due:${value}`];

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.modifyTask(uuid, ...modifications);
                if (result.success) {
                    this.showToast('Rescheduled task', 'success');
                    this.closeReschedule();
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to reschedule', 'error');
                }
            });
        },

        async clearRescheduleField(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            const fieldsRaw = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [];
            const fields = fieldsRaw.map((f) => String(f).trim()).filter(Boolean);

            await this.withBusyTask(uuid, async () => {
                const modifications = fields.length > 0
                    ? fields.map((f) => `${f}:`)
                    : ['due:'];

                const result = await commandService.modifyTask(uuid, ...modifications);
                if (result.success) {
                    const label = fields.length > 0
                        ? fields.map((field) => `${field[0].toUpperCase()}${field.slice(1)}`).join('/')
                        : 'Due';
                    this.showToast(`Cleared ${label}`, 'success');
                    this.closeReschedule();
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to clear', 'error');
                }
            });
        },

        async applyReschedulePreset(taskUuid, preset) {
            if (this.reschedule.multiSelect) {
                return await this.applyMultiReschedulePreset(preset);
            }

            const key = String(preset || '').trim();

            if (key === 'today') return await this.rescheduleTask(taskUuid, 'today');
            if (key === 'tomorrow') return await this.rescheduleTask(taskUuid, 'tomorrow');
            if (key === 'sonw') return await this.rescheduleTask(taskUuid, 'sonw');
        },

        async applyRescheduleCustom(taskUuid) {
            if (this.reschedule.multiSelect) {
                return await this.applyMultiRescheduleCustom();
            }

            const value = String(this.reschedule.custom || '').trim();
            if (!value) return;
            await this.rescheduleTask(taskUuid, value);
        },

        async onRescheduleCalendarChange(taskUuid, event) {
            if (this.reschedule.multiSelect) {
                return await this.onMultiRescheduleCalendarChange(event);
            }

            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            const value = String(event?.target?.value || '').trim();
            if (!value) return;

            // Clear the date input so choosing the same date again still triggers change.
            try {
                event.target.value = '';
            } catch {
                // ignore
            }

            await this.rescheduleTask(uuid, value);
        },

        toggleMultiSelectMode() {
            this.multiSelectMode = !this.multiSelectMode;
            if (!this.multiSelectMode) {
                this.selectedTaskUuids = new Set();
            }
            this.closeReschedule();
        },

        toggleTaskSelection(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            // Directly modify the Set for better performance
            if (this.selectedTaskUuids.has(uuid)) {
                this.selectedTaskUuids.delete(uuid);
            } else {
                this.selectedTaskUuids.add(uuid);
            }
            // Force reactivity update
            this.selectedTaskUuids = new Set(this.selectedTaskUuids);
        },

        isTaskSelected(taskUuid) {
            return this.selectedTaskUuids.has(String(taskUuid || '').trim());
        },

        selectAllTasks() {
            const newSet = new Set();
            // Only select pending tasks (non-completed, non-deleted)
            for (const task of this.tasks) {
                if (task?.uuid && task.status === 'pending') {
                    newSet.add(String(task.uuid));
                }
            }
            this.selectedTaskUuids = newSet;
        },

        deselectAllTasks() {
            this.selectedTaskUuids = new Set();
        },

        cancelMultiSelect() {
            this.multiSelectMode = false;
            this.selectedTaskUuids = new Set();
        },

        async rescheduleManyTasks() {
            if (this.selectedTaskUuids.size === 0) {
                this.showToast('No tasks selected', 'error');
                return;
            }

            // Open the bulk reschedule UI. Important: do NOT set taskUuid,
            // otherwise a single-task popover might also open.
            this.reschedule = {
                open: true,
                taskUuid: null,
                custom: '',
                fields: this.rescheduleFieldNames(),
                showFieldPicker: false,
                multiSelect: true,
            };
        },

        async applyMultiReschedulePreset(preset) {
            const uuids = Array.from(this.selectedTaskUuids);
            if (uuids.length === 0) return;

            const key = String(preset || '').trim();
            let value = '';
            if (key === 'today') value = 'today';
            else if (key === 'tomorrow') value = 'tomorrow';
            else if (key === 'sonw') value = 'sonw';
            else return;

            await this.rescheduleMultipleTasks(uuids, value);
        },

        async applyMultiRescheduleCustom() {
            const uuids = Array.from(this.selectedTaskUuids);
            const value = String(this.reschedule.custom || '').trim();
            if (!value || uuids.length === 0) return;

            await this.rescheduleMultipleTasks(uuids, value);
        },

        async clearMultiRescheduleField() {
            const uuids = Array.from(this.selectedTaskUuids);
            if (uuids.length === 0) return;

            const fieldsRaw = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [];
            const fields = fieldsRaw.map((f) => String(f).trim()).filter(Boolean);
            const modifications = fields.length > 0
                ? fields.map((f) => `${f}:`)
                : ['due:'];

            let successCount = 0;

            for (const uuid of uuids) {
                const result = await commandService.modifyTask(uuid, ...modifications);
                if (result.success) successCount++;
            }

            const label = fields.length > 0
                ? fields.map((field) => `${field[0].toUpperCase()}${field.slice(1)}`).join('/')
                : 'Due';
            this.showToast(`Cleared ${label} for ${successCount}/${uuids.length} tasks`, 'success');
            this.closeReschedule();
            await this.refreshCurrentPanel();
        },

        async onMultiRescheduleCalendarChange(event) {
            const uuids = Array.from(this.selectedTaskUuids);
            const value = String(event?.target?.value || '').trim();
            if (!value || uuids.length === 0) return;

            // Clear the date input so choosing the same date again still triggers change.
            try {
                event.target.value = '';
            } catch {
                // ignore
            }

            await this.rescheduleMultipleTasks(uuids, value);
        },

        async rescheduleMultipleTasks(uuids, dateValue) {
            const value = String(dateValue || '').trim();
            if (!value) return;

            const fieldsRaw = Array.isArray(this.reschedule?.fields) ? this.reschedule.fields : [];
            const fields = fieldsRaw.map((f) => String(f).trim()).filter(Boolean);
            const modifications = fields.length > 0
                ? fields.map((f) => `${f}:${value}`)
                : [`due:${value}`];

            let successCount = 0;

            for (const uuid of uuids) {
                const result = await commandService.modifyTask(uuid, ...modifications);
                if (result.success) successCount++;
            }

            this.showToast(`Rescheduled ${successCount}/${uuids.length} tasks`, 'success');
            this.closeReschedule();
            await this.refreshCurrentPanel();
        },

        editManyTasks() {
            if (this.selectedTaskUuids.size === 0) {
                this.showToast('No tasks selected', 'error');
                return;
            }

            this.modal = {
                open: true,
                type: 'edit-multi',
                taskIds: Array.from(this.selectedTaskUuids),
                value: '',
                project: '',
                tags: '',
                priority: '',
                due: '',
                activeAttributeDropdown: null,
                attributeInputValue: '',
            };
            this.resetCompletion();

            this.$nextTick(() => {
                const input = this.$refs.modalInput;
                if (input && typeof input.focus === 'function') input.focus();
            });
        },

        async submitMultiEdit() {
            const uuids = Array.isArray(this.modal.taskIds) ? this.modal.taskIds : [];
            if (uuids.length === 0) return;

            const input = String(this.modal.value || '').trim();
            const structured = [];
            const project = String(this.modal.project || '').trim();
            const tags = String(this.modal.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
            const priority = String(this.modal.priority || '').trim();
            const due = String(this.modal.due || '').trim();

            if (project) structured.push(`project:${project}`);
            tags.forEach((tag) => structured.push(`+${tag}`));
            if (priority) structured.push(`priority:${priority}`);
            if (due) structured.push(`${this.rescheduleFieldName()}:${due}`);

            if (!input && structured.length === 0) {
                this.showToast('No modifications specified', 'error');
                return;
            }

            const modifications = input
                ? [input, ...structured.map((value) => sanitizeTaskCommandArg(value))].filter(Boolean).join(' ')
                : structured;

            const result = await commandService.modifyTasks(uuids, modifications);
            if (result.success) {
                this.showToast(`Modified ${uuids.length} tasks`, 'success');
                this.closeModal();
                await this.refreshCurrentPanel();
            } else {
                this.showToast(result.error || 'Failed to modify tasks', 'error');
            }
        },

        isAnySelectedTaskBusy() {
            const uuids = Array.from(this.selectedTaskUuids || []);
            return uuids.some((uuid) => Boolean(this.busyTaskUuids?.[uuid]));
        },

        async completeSelectedTasks() {
            const uuids = Array.from(this.selectedTaskUuids || []);
            if (uuids.length === 0) {
                this.showToast('No tasks selected', 'error');
                return;
            }

            let successCount = 0;
            for (const uuid of uuids) {
                await this.withBusyTask(uuid, async () => {
                    const result = await commandService.completeTask(uuid);
                    if (result.success) successCount++;
                });
            }

            this.showToast(`Completed ${successCount}/${uuids.length} tasks`, successCount ? 'success' : 'error');
            this.selectedTaskUuids = new Set();
            await this.refreshCurrentPanel();
        },

        async deleteSelectedTasks() {
            const uuids = Array.from(this.selectedTaskUuids || []);
            if (uuids.length === 0) {
                this.showToast('No tasks selected', 'error');
                return;
            }

            if (!confirm(`Delete ${uuids.length} tasks?`)) return;

            let successCount = 0;
            for (const uuid of uuids) {
                await this.withBusyTask(uuid, async () => {
                    const result = await commandService.deleteTask(uuid);
                    if (result.success) successCount++;
                });
            }

            this.showToast(`Deleted ${successCount}/${uuids.length} tasks`, successCount ? 'success' : 'error');
            this.selectedTaskUuids = new Set();
            await this.refreshCurrentPanel();
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

        async fetchCompletionSuggestions(requestToken) {
            const result = await apiClient.complete(requestToken);
            if (result && result.success && Array.isArray(result.suggestions)) {
                return result.suggestions;
            }
            return [];
        },

        stripPrefixFromSuggestions(suggestions, prefixPattern) {
            const list = Array.isArray(suggestions) ? suggestions : [];
            if (!prefixPattern) return list;

            if (prefixPattern instanceof RegExp) {
                return list.map((value) => String(value).replace(prefixPattern, ''));
            }

            const prefix = String(prefixPattern);
            return list.map((value) => {
                const text = String(value);
                return text.startsWith(prefix) ? text.slice(prefix.length) : text;
            });
        },

        getCompletionSpec(field) {
            const priorities = ['H', 'M', 'L'];

            if (field === 'modal.project') {
                return { type: 'api', requestPrefix: 'project:', stripPrefix: /^project:/ };
            }
            if (field === 'modal.tags') {
                return { type: 'api', requestPrefix: '+', stripPrefix: /^\+/ };
            }
            if (field === 'modal.due') {
                const scheduleField = this.rescheduleFieldName();
                const canonical = resolveAbbreviatedAttr(scheduleField) || scheduleField;
                return {
                    type: 'api',
                    requestPrefix: `${scheduleField}:`,
                    stripPrefix: new RegExp(`^${escapeRegExp(canonical)}:`),
                };
            }
            if (field === 'modal.priority') {
                return {
                    type: 'local',
                    getSuggestions(token) {
                        return priorities.filter((value) => value.toLowerCase().startsWith(String(token).toLowerCase()));
                    },
                };
            }

            return null;
        },

        setCompletionState(field, tokenInfo, token, suggestions, { forceVisible = false } = {}) {
            const keepVisible = this.completion.visible && this.completion.field === field;

            this.completion = {
                field,
                token,
                start: tokenInfo.start,
                end: tokenInfo.end,
                suggestions,
                selectedIndex: 0,
                visible: forceVisible ? true : keepVisible,
            };
        },

        async updateCompletion(field, tokenInfo, { autoTrigger = false } = {}) {
            const requestId = ++this.completionRequestId;
            const token = tokenInfo.token || '';
            const spec = this.getCompletionSpec(field);
            let suggestions = [];

            if (spec && spec.type === 'local') {
                suggestions = spec.getSuggestions(token);
            } else if (spec && spec.type === 'api') {
                const raw = await this.fetchCompletionSuggestions(`${spec.requestPrefix}${token}`);
                suggestions = this.stripPrefixFromSuggestions(raw, spec.stripPrefix);
            } else {
                const normalized = String(token).trim();
                if (!normalized) {
                    if (requestId === this.completionRequestId) this.resetCompletion();
                    return [];
                }
                suggestions = await this.fetchCompletionSuggestions(normalized);
            }

            if (requestId !== this.completionRequestId) return [];
            if (suggestions.length === 0) {
                this.resetCompletion();
                return [];
            }

            this.setCompletionState(field, tokenInfo, token, suggestions, { forceVisible: autoTrigger });
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

        async applyCompletionSuggestionAndMaybeRetrigger(inputEl, field, suggestion) {
            const current = String(this.getFieldValue(field) || '');
            const { start, end } = this.completion;
            const nextValue = replaceRange(current, start, end, suggestion);
            const cursor = start + suggestion.length;
            this.setFieldValue(field, nextValue);

            this.$nextTick(() => {
                try {
                    inputEl.setSelectionRange(cursor, cursor);
                } catch {
                    // ignore
                }
            });

            this.resetCompletion();
            const normalizedSuggestion = String(suggestion || '').trim();
            if (!normalizedSuggestion.endsWith(':')) return;

            const requestId = ++this.completionRequestId;
            const requestPrefix = normalizedSuggestion;
            const raw = await this.fetchCompletionSuggestions(requestPrefix);
            if (requestId !== this.completionRequestId) return;

            const stripPrefix = new RegExp(`^${escapeRegExp(requestPrefix)}`);
            const suggestions = this.stripPrefixFromSuggestions(raw, stripPrefix);
            if (suggestions.length === 0) return;

            const tokenInfo = { token: '', start: cursor, end: cursor };
            this.setCompletionState(field, tokenInfo, '', suggestions, { forceVisible: true });
        },

        async applyModalCompletion(field, suggestion) {
            const inputEl = this.$refs.modalInput;
            if (!inputEl) return;

            await this.applyCompletionSuggestionAndMaybeRetrigger(inputEl, field, suggestion);
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
                await this.updateCompletion(field, tokenInfo, { autoTrigger: true });
            }

            if (this.completion.suggestions.length === 0) {
                if (event.key === 'Tab' && isActive) {
                    this.resetCompletion();
                }
                return;
            }


            if (this.completion.suggestions.length === 1 && event.key === 'Tab') {
                await this.applyCompletionSuggestionAndMaybeRetrigger(inputEl, field, this.completion.suggestions[0]);
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
                    await this.applyCompletionSuggestionAndMaybeRetrigger(inputEl, field, suggestion);
                }
            }
        },

        async handleCompletionInput(event, field) {
            const inputEl = event.target;
            if (!inputEl || typeof inputEl.selectionStart !== 'number') {
                this.resetCompletion();
                return;
            }

            const text = String(this.getFieldValue(field) || '');
            const cursor = inputEl.selectionStart;
            const tokenInfo = getTokenAtCursor(text, cursor);

            // Auto-trigger completion when token has meaningful length (>= 2 chars)
            const shouldAutoTrigger = tokenInfo.token && tokenInfo.token.length >= 2;
            
            if (this.completion.visible && this.completion.field === field) {
                await this.updateCompletion(field, tokenInfo);
            } else if (shouldAutoTrigger) {
                await this.updateCompletion(field, tokenInfo, { autoTrigger: true });
            } else {
                this.resetCompletion();
            }
        },

        handleCompletionBlur(field) {
            // Delay so mousedown on a suggestion can apply it.
            setTimeout(() => {
                if (this.completion.field === field) this.resetCompletion();
            }, 150);
        },

        async refreshBuiltinFilters() {
            try {
                const result = await apiClient.getBuiltinFilters();
                if (result.success && Array.isArray(result.filters)) {
                     const next = { ...this.builtinFilters };
                     const draft = { ...this.settingsBuiltinVisibilityDraft };

                    for (const entry of result.filters) {
                        const key = String(entry?.key || '').trim();
                        if (!key) continue;

                        next[key] = {
                            key,
                            name: String(entry?.name || key),
                            filter: String(entry?.filter ?? ''),
                            visible: Boolean(entry?.visible),
                            group_by: entry?.group_by || null,
                        };

                         draft[key] = {
                             visible: next[key].visible,
                         };
                    }

                     this.builtinFilters = next;
                     this.settingsBuiltinVisibilityDraft = draft;

                    if (this.selectedView.type === 'builtin') {
                        const selectedKey = String(this.selectedView.key || '').trim();
                        const selected = next[selectedKey];
                        if (selected && selected.visible === false) {
                            const fallbackKey = ['today', 'next', 'all'].find((k) => next[k] && next[k].visible !== false) || 'next';
                            this.selectedView = { type: 'builtin', key: fallbackKey };
                            this.persistSelectedView(this.selectedView);

                            if (!this.showTaskrc) {
                                await this.loadTasksForSelection();
                            }
                        }
                    }
                }
            } catch {
                // ignore
            }
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

         async refreshAppSettings() {
             try {
                 const result = await apiClient.getSettings();
                 if (!result?.success) return;

                const rescheduleFieldRaw = String(result?.settings?.reschedule_field || 'due').trim() || 'due';
                const rescheduleFields = rescheduleFieldRaw
                    .split(',')
                    .map((value) => String(value).trim())
                    .filter(Boolean);

                this.settingsAppLoaded = {
                    reschedule_field: rescheduleFields.length > 0 ? rescheduleFields : ['due'],
                };
                this.settingsAppDraft = {
                    reschedule_field: rescheduleFields.length > 0 ? rescheduleFields : ['due'],
                };
             } catch {
                 // ignore
             }
         },

        resetAppSettingsDraft() {
            this.settingsAppDraft = { ...this.settingsAppLoaded };
        },

         async saveAppSettings() {
             try {
                const raw = this.settingsAppDraft?.reschedule_field;
                const list = Array.isArray(raw) ? raw : [raw];
                const cleaned = list
                    .map((value) => String(value).trim())
                    .filter(Boolean);

                const payload = {
                    reschedule_field: cleaned.join(','),
                };

                 const result = await apiClient.updateSettings(payload);
                 if (!result?.success) {
                     throw new Error(result?.error || 'Failed to save settings');
                 }

                 await this.refreshAppSettings();
                 this.showToast('Saved app settings', 'success');
             } catch (error) {
                 this.showToast(String(error?.message || error), 'error');
             }
         },

        reloadAndReapplyCurrentView() {
            // Persist before reload to make restoration deterministic.
            this.persistSelectedView(this.selectedView);
            window.location.reload();
        },

        selectBuiltin(key) {
            const normalizedKey = String(key || '').trim();
            const builtin = this.builtinFilters[normalizedKey];
            if (builtin && builtin.visible === false) return;

            this.showTaskrc = false;
            this.selectedView = { type: 'builtin', key: normalizedKey };
            this.persistSelectedView(this.selectedView);
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.loadTasksForSelection();
        },

        selectSearch() {
            this.beginTaskLoad();
            this.showTaskrc = false;
            this.selectedView = { type: 'search' };
            this.persistSelectedView(this.selectedView);
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.openCommandModal('search');
        },

        selectCustomFilter(filter) {
            this.showTaskrc = false;
            this.selectedView = { type: 'filter', id: filter.id };
            this.persistSelectedView(this.selectedView);
            this.mainMode = 'tasks';
            this.toggleDrawer(false);
            this.loadTasksForSelection();
        },

        beginTaskLoad() {
            this.taskLoadRequestId += 1;
            return this.taskLoadRequestId;
        },

        isCurrentTaskLoad(requestId) {
            return requestId === this.taskLoadRequestId;
        },

        async loadTasksForSelection() {
            const requestId = this.beginTaskLoad();
            const selectedView = { ...this.selectedView };
            this.emptyMessage = 'Loading…';
            this.tasks = [];
            this.taskGroups = [];
            this.mainMode = 'tasks';
            this.mainOutput = '';
            this.ensureTaskrcLoaded();

            try {
                if (selectedView.type === 'search') {
                    if (!this.isCurrentTaskLoad(requestId)) return;
                    this.tasks = [];
                    this.taskGroups = [];
                    this.emptyMessage = 'Use Search to load tasks.';
                    return;
                }

                if (selectedView.type === 'builtin') {
                    const key = String(selectedView.key || '').trim();
                    const builtin = this.builtinFilters[key];
                    const query = builtin ? builtin.filter : key;
                    const groupBy = builtin?.group_by || null;
                    const result = await queryService.getTasks(query, groupBy);
                    if (!this.isCurrentTaskLoad(requestId)) return;
                    this.currentGroupBy = groupBy;
                    this.tasks = result.tasks;
                    this.taskGroups = result.groups;
                    this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                    return;
                }

                if (selectedView.type === 'filter') {
                    const selectedId = Number(selectedView.id);
                    const filter = this.filters.find((entry) => Number(entry.id) === selectedId);
                    if (!filter) {
                        if (!this.isCurrentTaskLoad(requestId)) return;
                        this.tasks = [];
                        this.taskGroups = [];
                        this.emptyMessage = 'Filter not found.';
                        return;
                    }

                    const groupBy = filter?.group_by || null;
                    const result = await queryService.getTasks(filter.filter, groupBy);
                    if (!this.isCurrentTaskLoad(requestId)) return;
                    this.currentGroupBy = groupBy;
                    this.tasks = result.tasks;
                    this.taskGroups = result.groups;
                    this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
                }
            } catch (error) {
                if (!this.isCurrentTaskLoad(requestId)) return;
                this.tasks = [];
                this.taskGroups = [];
                this.emptyMessage = 'Error loading tasks.';
                this.showToast(String(error?.message || error), 'error');
            }
        },

        async refreshCurrentPanel() {
            if (this.showTaskrc) return;
            this.ensureTaskrcLoaded();

            if (this.selectedView.type !== 'search') {
                await this.loadTasksForSelection();
                return;
            }

            const term = String(this.lastSearch.term || '').trim();
            const requestId = this.beginTaskLoad();
            if (!term) {
                this.tasks = [];
                this.taskGroups = [];
                this.emptyMessage = 'Use Search to load tasks.';
                return;
            }

            const prefix = this.lastSearch.pendingOnly ? 'status:pending ' : '';
            this.tasks = [];
            this.taskGroups = [];
            this.emptyMessage = 'Loading…';
            this.mainMode = 'tasks';
            try {
                const result = await queryService.getTasks(`${prefix}${term}`, this.currentGroupBy);
                if (!this.isCurrentTaskLoad(requestId)) return;
                this.tasks = result.tasks;
                this.taskGroups = result.groups;
                this.emptyMessage = this.tasks.length === 0 ? 'No tasks found.' : '';
            } catch (error) {
                if (!this.isCurrentTaskLoad(requestId)) return;
                this.tasks = [];
                this.taskGroups = [];
                this.emptyMessage = 'Error loading tasks.';
                this.showToast(String(error?.message || error), 'error');
            }
        },

        toggleGroupDropdown() {
            this.groupDropdownOpen = !this.groupDropdownOpen;
        },

        selectGroupOption(value) {
            this.groupDropdownOpen = false;
            this.updateGroupBy(value);
        },

        getGroupByLabel(value) {
            const option = this.groupOptions.find(opt => opt.value === value);
            return option ? option.label : 'Group by';
        },

        async updateGroupBy(groupBy) {
            this.currentGroupBy = groupBy || null;
            await this.saveGroupSettings();
            await this.refreshCurrentPanel();
        },

        async resetGroupSettings() {
            this.currentGroupBy = null;
            this.groupDropdownOpen = false;
            await this.saveGroupSettings();
            await this.refreshCurrentPanel();
        },

        async saveGroupSettings() {
            try {
                if (this.selectedView.type === 'builtin') {
                    const key = String(this.selectedView.key || '').trim();
                    const result = await apiClient.updateBuiltinFilter(key, {
                        group_by: this.currentGroupBy || '',
                    });
                    if (result.success) {
                        await this.refreshBuiltinFilters();
                    }
                 } else if (this.selectedView.type === 'filter') {
                     const selectedId = Number(this.selectedView.id);
                     const filter = this.filters.find((f) => Number(f.id) === selectedId);
                     if (filter) {

                        const result = await apiClient.updateFilter(filter.id, {
                            group_by: this.currentGroupBy || '',
                        });
                        if (result.success) {
                            await this.refreshFilters();
                        }
                    }
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error');
            }
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
            this.modal = {
                open: true,
                type: 'filter',
                value: '',
                taskId: null,
                filterId: null,
                filterName: '',
                filterValue: '',
                filterIcon: '',
                originalFilterName: '',
                originalFilterValue: '',
                originalFilterIcon: '',
            };
            this.resetCompletion();
            this.$nextTick(() => {
                if (this.$refs.modalNameInput) this.$refs.modalNameInput.focus();
            });
        },

        openEditFilter(filter) {
            const name = filter?.name ? String(filter.name) : '';
            const value = filter?.filter ? String(filter.filter) : '';
            const icon = filter?.icon ? String(filter.icon) : '';

            this.modal = {
                open: true,
                type: 'filter',
                value: '',
                taskId: null,
                filterId: filter.id,
                filterName: name,
                filterValue: value,
                filterIcon: icon,
                originalFilterName: name,
                originalFilterValue: value,
                originalFilterIcon: icon,
            };
            this.resetCompletion();
            this.$nextTick(() => {
                if (this.$refs.modalNameInput) this.$refs.modalNameInput.focus();
            });
        },

        async deleteFilter(filter) {
            if (!filter) return;
            return await this.deleteFilterById(filter.id);
        },

        async deleteFilterById(filterId) {
            const id = Number(filterId);
            if (!Number.isFinite(id)) return;

            const filter = this.filters.find((f) => f.id === id);
            const filterName = filter?.name ? String(filter.name) : String(filterId);

            if (!confirm(`Delete filter "${filterName}"?`)) return;

            try {
                const result = await apiClient.deleteFilter(id);
                if (result.success) {
                    await this.refreshFilters();
                    if (this.selectedView.type === 'filter' && this.selectedView.id === id) {
                        this.selectBuiltin('next');
                    }

                    if (this.modal?.open && this.modal.type === 'filter' && this.modal.filterId === id) {
                        this.closeModal();
                    }
                } else {
                    this.showToast(result.error || 'Failed to delete filter', 'error');
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error');
            }
        },

        getDraggedFilterId(event) {
            const stateId = Number(this.draggedFilterId);
            if (Number.isFinite(stateId) && stateId > 0) return stateId;

            const dt = event?.dataTransfer;
            if (!dt || typeof dt.getData !== 'function') return null;

            const raw = dt.getData('text/plain');
            const parsed = Number(raw);
            if (!Number.isFinite(parsed) || parsed <= 0) return null;
            return parsed;
        },

        onFilterDragStart(filter, event) {
            const id = Number(filter?.id);
            if (!Number.isFinite(id) || id <= 0) return;

            this.draggedFilterId = id;

            const dt = event?.dataTransfer;
            if (!dt) return;

            try {
                dt.effectAllowed = 'move';
                // Firefox needs explicit data to enable drag.
                if (typeof dt.setData === 'function') {
                    dt.setData('text/plain', String(id));
                }
            } catch {
                // ignore
            }
        },

        onFilterDragOver(filter, position) {
            if (!this.draggedFilterId) return;

            if (position === 'before') {
                const id = Number(filter?.id);
                if (!Number.isFinite(id) || id <= 0) return;
                this.insertionTarget = { type: 'before', id };
                return;
            }

            if (position === 'start') {
                this.insertionTarget = { type: 'start' };
                return;
            }

            if (position === 'end') {
                this.insertionTarget = { type: 'end' };
            }
        },

        onFiltersDragLeave(event) {
            if (event?.relatedTarget && typeof event.relatedTarget.closest === 'function') {
                const stillInside = event.relatedTarget.closest('.filters');
                if (stillInside) return;
            }
            this.insertionTarget = null;
        },

        onFilterDragEnd() {
            this.draggedFilterId = null;
            this.insertionTarget = null;
        },

        async persistFilterReorder(nextFilters) {
            const list = Array.isArray(nextFilters) ? nextFilters : [];
            if (list.length === 0) return;

            try {
                const ids = list.map((f) => f.id);
                const result = await apiClient.reorderFilters(ids);
                if (!result.success) {
                    this.showToast(result.error || 'Failed to reorder', 'error');
                    await this.refreshFilters();
                }
            } catch (error) {
                this.showToast(String(error?.message || error), 'error');
                await this.refreshFilters();
            } finally {
                this.onFilterDragEnd();
            }
        },

        async onFilterDrop(targetFilter, event) {
            const draggedId = this.getDraggedFilterId(event);
            const targetId = Number(targetFilter?.id);
            if (!draggedId || !Number.isFinite(targetId) || draggedId === targetId) return;

            const current = this.filters.slice();
            const fromIndex = current.findIndex((f) => f.id === draggedId);
            const toIndex = current.findIndex((f) => f.id === targetId);
            if (fromIndex === -1 || toIndex === -1) return;

            // Drop on a filter means insert before it.
            const [moved] = current.splice(fromIndex, 1);
            const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            current.splice(adjustedIndex, 0, moved);

            this.filters = current;
            await this.persistFilterReorder(current);
        },

        async onFiltersDrop(event, position = 'end') {
            const draggedId = this.getDraggedFilterId(event);
            if (!draggedId) return;

            const normalized = position === 'start' ? 'start' : 'end';
            const current = this.filters.slice();
            const fromIndex = current.findIndex((f) => f.id === draggedId);
            if (fromIndex === -1) return;

            const toIndex = normalized === 'start' ? 0 : current.length;
            const isNoop = (normalized === 'start' && fromIndex === 0)
                || (normalized === 'end' && fromIndex === current.length - 1);
            if (isNoop) {
                this.onFilterDragEnd();
                return;
            }

            const [moved] = current.splice(fromIndex, 1);
            const adjustedIndex = fromIndex < toIndex ? toIndex - 1 : toIndex;
            current.splice(adjustedIndex, 0, moved);

            this.filters = current;
            await this.persistFilterReorder(current);
        },

         openCommandModal(type) {
             const baseModal = { open: true, type, value: '', output: '', taskId: null, filterId: null, filterName: '', filterValue: '', filterIcon: '' };

             if (type === 'add') {
                 baseModal.description = '';
                 baseModal.project = '';
                 baseModal.tags = '';
                 baseModal.priority = '';
                 baseModal.due = '';
                 baseModal.initialAnnotation = '';
                 baseModal.originalDescription = '';
                 baseModal.originalProject = '';
                 baseModal.originalTags = '';
                 baseModal.originalPriority = '';
                 baseModal.originalDue = '';
                 baseModal.activeAttributeDropdown = null;
                 baseModal.attributeInputValue = '';
             }

             this.modal = baseModal;
            if (type === 'exec') this.showTaskrc = false;
            this.resetCompletion();
            this.$nextTick(() => {
                const input = this.$refs.modalInput;
                if (input) input.focus();
            });
        },

        closeModal() {
            this.clearModalEscHint();
            this.modal.open = false;
            this.modal.type = null;
            this.modal.value = '';
            this.modal.output = '';
            this.modal.taskId = null;
            this.modal.filterId = null;
            this.modal.filterName = '';
            this.modal.filterValue = '';
            this.modal.filterIcon = '';
            this.modal.description = '';
            this.modal.project = '';
            this.modal.tags = '';
            this.modal.priority = '';
            this.modal.due = '';
            this.modal.initialAnnotation = '';
             this.modal.showTaskDetails = false;
             this.modal.taskDetailsOutput = '';
             this.modal.showAnnotations = false;
             this.modal.annotationDraft = '';
             this.modal.annotations = [];
             this.modal.annotationEditKey = null;
             this.modal.annotationEditDraft = '';
             this.modal.originalDescription = '';
             this.modal.originalProject = '';
             this.modal.originalTags = '';
             this.modal.originalPriority = '';
             this.modal.originalDue = '';
              this.modal.originalFilterName = '';
              this.modal.originalFilterValue = '';
              this.modal.originalFilterIcon = '';
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
             const scheduleField = this.rescheduleFieldName();

             const placeholders = {
                 due: `e.g., tomorrow, eom, 2024-12-31 (sets ${scheduleField})`,
                 priority: 'H, M, L',
                 project: 'Select or type project name',
                 tags: 'Add tags (comma separated)',
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
            const requestId = ++this.completionRequestId;
            const fieldByAttr = {
                project: 'modal.project',
                tags: 'modal.tags',
                priority: 'modal.priority',
                due: 'modal.due',
            };

            const mappedField = fieldByAttr[String(attributeName || '')];
            if (!mappedField) {
                if (requestId === this.completionRequestId) this.resetCompletion();
                return [];
            }

            const token = tokenInfo.token || '';
            const spec = this.getCompletionSpec(mappedField);
            if (!spec) {
                if (requestId === this.completionRequestId) this.resetCompletion();
                return [];
            }

            let suggestions = [];
            if (spec.type === 'local') {
                suggestions = spec.getSuggestions(token);
            } else {
                const raw = await this.fetchCompletionSuggestions(`${spec.requestPrefix}${token}`);
                suggestions = this.stripPrefixFromSuggestions(raw, spec.stripPrefix);
            }

            if (requestId !== this.completionRequestId) return [];
            if (suggestions.length === 0) {
                this.resetCompletion();
                return [];
            }

            this.setCompletionState('modal.attributeInputValue', tokenInfo, token, suggestions, { forceVisible: true });
            return suggestions;
        },

         async refreshTaskAnnotations(taskUuid) {
             const uuid = String(taskUuid || '').trim();
             if (!uuid) return;

             try {
                 const exportResult = await commandService.exportTask(uuid);
                 if (!exportResult.success) return;

                 const payload = (exportResult.output || '').trim();
                 const parsed = JSON.parse(payload);
                 const task = Array.isArray(parsed) ? parsed[0] : parsed;
                 const annotations = Array.isArray(task?.annotations) ? task.annotations.slice() : [];

                 if (this.modal.type === 'edit' && String(this.modal.taskId) === uuid) {
                     this.modal.annotations = annotations;
                 }

                 const idx = this.tasks.findIndex((t) => String(t.uuid) === uuid);
                 if (idx !== -1) {
                     const copy = this.tasks.slice();
                     copy[idx] = { ...copy[idx], annotations };
                     this.tasks = copy;
                 }
             } catch {
                 // ignore
             }
         },

        async addAnnotation() {
            const uuid = String(this.modal?.taskId || '').trim();
            if (!uuid) return;
            const text = String(this.modal.annotationDraft || '').trim();
            if (!text) return;
            const normalized = text.replace(/\s*\n\s*/g, ' / ');

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.annotateTask(uuid, normalized);
                if (result.success) {
                    this.modal.annotationDraft = '';
                    await this.refreshTaskAnnotations(uuid);
                    this.showToast('Added annotation', 'success');
                } else {
                    this.showToast(result.error || 'Failed to add annotation', 'error');
                }
            });
        },

        startEditAnnotation(annotation) {
            const entry = String(annotation?.entry || '').trim();
            const description = String(annotation?.description || '');
            const key = `${entry}|${description}`;
            this.modal.annotationEditKey = key;
            this.modal.annotationEditDraft = description;
        },

        cancelEditAnnotation() {
            this.modal.annotationEditKey = null;
            this.modal.annotationEditDraft = '';
        },

        async saveEditAnnotation(annotation) {
            const uuid = String(this.modal?.taskId || '').trim();
            if (!uuid) return;
            const original = String(annotation?.description || '');
            const draftRaw = String(this.modal.annotationEditDraft || '').trim();
            if (!draftRaw) return;

            const draft = draftRaw.replace(/\s*\n\s*/g, ' / ');
            if (draft === original) {
                this.cancelEditAnnotation();
                return;
            }

            await this.withBusyTask(uuid, async () => {
                const deleteResult = await commandService.denotateTask(uuid, original);
                if (!deleteResult.success) {
                    this.showToast(deleteResult.error || 'Failed to update annotation', 'error');
                    return;
                }

                const addResult = await commandService.annotateTask(uuid, draft);
                if (addResult.success) {
                    this.cancelEditAnnotation();
                    await this.refreshTaskAnnotations(uuid);
                    this.showToast('Updated annotation', 'success');
                    return;
                }

                // Editing is delete + add in Taskwarrior. Restore old content on failure.
                const rollbackResult = await commandService.annotateTask(uuid, original);
                const rollbackMessage = rollbackResult.success
                    ? ' Original annotation restored.'
                    : ' Original annotation could not be restored.';
                this.showToast(`${addResult.error || 'Failed to update annotation'}${rollbackMessage}`, 'error');
                await this.refreshTaskAnnotations(uuid);
            });
        },

        async deleteAnnotation(annotation) {
            const uuid = String(this.modal?.taskId || '').trim();
            if (!uuid) return;
            const description = String(annotation?.description || '').trim();
            if (!description) return;
            if (!confirm('Delete this annotation?')) return;

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.denotateTask(uuid, description);
                if (result.success) {
                    await this.refreshTaskAnnotations(uuid);
                    this.showToast('Deleted annotation', 'success');
                } else {
                    this.showToast(result.error || 'Failed to delete annotation', 'error');
                }
            });
        },

         async submitModal() {
             const type = this.modal.type;


             if (type === 'add') {
                const description = String(this.modal.description || '').trim();
                if (!description) return;

                // Keep CLI syntax in the task-name field, but quote structured
                // values so whitespace remains part of one Taskwarrior argument.
                const taskParts = [description];
                const project = String(this.modal.project || '').trim();
                const tags = String(this.modal.tags || '').split(',').map((tag) => tag.trim()).filter(Boolean);
                const priority = String(this.modal.priority || '').trim();
                const due = String(this.modal.due || '').trim();

                if (project) taskParts.push(sanitizeTaskCommandArg(`project:${project}`));
                tags.forEach((tag) => taskParts.push(sanitizeTaskCommandArg(`+${tag}`)));
                if (priority) taskParts.push(sanitizeTaskCommandArg(`priority:${priority}`));
                if (due) taskParts.push(sanitizeTaskCommandArg(`${this.rescheduleFieldName()}:${due}`));

                const annotation = String(this.modal.initialAnnotation || '').trim() || undefined;
                const result = await commandService.addTask(taskParts.join(' '), annotation);
                if (result.success) {
                    if (result.error) {
                        this.showToast(`Added task. ${String(result.error).trim()}`, 'error', 5000);
                    } else {
                        this.showToast('Added task', 'success');
                    }
                    this.closeModal();
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to add', 'error');
                }
                return;
            }

            if (type === 'edit-multi') {
                await this.submitMultiEdit();
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
                     const scheduleField = this.rescheduleFieldName();
                     if (this.modal.due) {
                         parts.push(`${scheduleField}:${this.modal.due}`);
                     } else {
                         parts.push(`${scheduleField}:`);
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
                
                const result = await commandService.modifyTask(taskId, ...parts);
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

                this.mainMode = 'tasks';
                this.closeModal();
                await this.refreshCurrentPanel();
                return;
            }

            if (type === 'filter') {
                const name = String(this.modal.filterName || '').trim();
                const filter = String(this.modal.filterValue || '').trim();
                const icon = String(this.modal.filterIcon || '').trim();
                if (!name || !filter) return;

                const payload = { name, filter };
                payload.icon = icon || null;

                try {
                    if (this.modal.filterId) {
                        const updatedId = this.modal.filterId;
                        const wasActive = this.selectedView.type === 'filter' && this.selectedView.id === updatedId;

                        const result = await apiClient.updateFilter(updatedId, payload);
                        if (!result.success) {
                            this.showToast(result.error || 'Failed to update filter', 'error');
                            return;
                        }

                        if (wasActive) {
                            // Requirement: when an active filter is adjusted, reload and reapply it.
                            this.closeModal();
                            this.reloadAndReapplyCurrentView();
                            return;
                        }

                        await this.refreshFilters();
                        this.closeModal();
                        return;
                    }

                    const result = await apiClient.createFilter(payload);
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
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            const task = this.tasks.find((t) => String(t.uuid) === uuid);
            const currentDescription = task?.description ? String(task.description) : '';
            const currentProject = task?.project ? String(task.project) : '';
            const currentTags = Array.isArray(task?.tags) ? task.tags.join(', ') : '';
            const currentPriority = task?.priority ? String(task.priority) : '';

            const scheduleFieldRaw = this.rescheduleFieldName();

            let currentDue = '';
            const resolvedFromList = resolveTaskFieldName(task, scheduleFieldRaw);
            if (resolvedFromList) {
                currentDue = task[resolvedFromList] ? String(task[resolvedFromList]) : '';
            } else {
                try {
                    const exportResult = await commandService.exportTask(uuid);
                    if (exportResult.success) {
                        const payload = String(exportResult.output || '').trim();
                        const parsed = payload ? JSON.parse(payload) : [];
                        const exportedTask = Array.isArray(parsed) ? parsed[0] : parsed;

                        const resolvedFromExport = resolveTaskFieldName(exportedTask, scheduleFieldRaw);
                        if (resolvedFromExport) {
                            currentDue = exportedTask[resolvedFromExport] ? String(exportedTask[resolvedFromExport]) : '';
                        }
                    }
                } catch {
                    // ignore
                }
            }

            // Fetch full task details for the collapsible section
            let taskDetailsOutput = '';
            try {
                const result = await commandService.showTask(uuid);
                if (result.success) {
                    const output = (result.output || '').trim();
                    const err = (result.error || '').trim();
                    taskDetailsOutput = [output, err].filter(Boolean).join('\n') || 'No details available';
                }
            } catch {
                taskDetailsOutput = 'Failed to load task details';
            }

             const annotations = Array.isArray(task?.annotations) ? task.annotations.slice() : [];
             
             this.modal = {
                 open: true,
                 type: 'edit',
                 value: currentDescription,
                 output: '',
                 taskId: uuid,
                filterId: null,
                filterName: '',
                filterValue: '',
                filterIcon: '',
                 description: currentDescription,
                 project: currentProject,
                 tags: currentTags,
                 priority: currentPriority,
                 due: currentDue,
                 showAnnotations: false,
                 annotationDraft: '',
                 annotations,
                 annotationEditKey: null,
                 annotationEditDraft: '',
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

        async completeTaskFromEdit(taskUuid) {
            const uuid = String(taskUuid || '').trim();
            if (!uuid) return;

            await this.withBusyTask(uuid, async () => {
                const result = await commandService.completeTask(uuid);
                if (result.success) {
                    if (this.modal?.open && this.modal.type === 'edit' && String(this.modal.taskId) === uuid) {
                        this.closeModal();
                    }

                    this.showToast('Marked done', 'success');
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to update task', 'error');
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
                    if (this.modal?.open && this.modal.type === 'edit' && String(this.modal.taskId) === uuid) {
                        this.closeModal();
                    }

                    this.showToast('Deleted task', 'success');
                    await this.refreshCurrentPanel();
                } else {
                    this.showToast(result.error || 'Failed to delete task', 'error');
                }
            });
        },

        normalizeTaskDate(dateStr) {
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

            return normalized;
        },

        parseNormalizedDateParts(normalized) {
            const value = String(normalized || '').trim();
            if (!value) return null;

            // `normalized` is either YYYY-MM-DD or YYYY-MM-DDTHH:MM:SS[Z]
            const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(Z)?)?$/);
            if (!match) return null;

            const [, yearText, monthText, dayText, hourText, minuteText, secondText, zuluMarker] = match;
            const hasTime = hourText !== undefined && minuteText !== undefined;
            const isZulu = Boolean(zuluMarker);

            // Treat date-only values and local timestamps as local wall-clock times.
            // Only convert when Taskwarrior exported a UTC timestamp (with trailing 'Z').
            if (!hasTime || !isZulu) {
                return {
                    year: Number(yearText),
                    month: Number(monthText),
                    day: Number(dayText),
                    hour: hasTime ? Number(hourText) : null,
                    minute: hasTime ? Number(minuteText) : null,
                    hasTime,
                };
            }

            const rawHour = Number(hourText);
            const rawMinute = Number(minuteText);
            const rawSecond = secondText !== undefined ? Number(secondText) : 0;

            // Taskwarrior often represents "date-only" values as UTC timestamps at 00:00:00Z
            // (and sometimes 23:59:59Z). If we convert those to local time, the UI can show
            // spurious times like "01:00" (and even a different calendar day) depending on TZ.
            // For these placeholders, keep the literal date and hide the time.
            const isZuluPlaceholder =
                (rawHour === 0 && rawMinute === 0 && rawSecond === 0)
                || (rawHour === 23 && rawMinute === 59 && rawSecond >= 0);

            if (isZuluPlaceholder) {
                return {
                    year: Number(yearText),
                    month: Number(monthText),
                    day: Number(dayText),
                    hour: null,
                    minute: null,
                    hasTime: false,
                };
            }

            const date = new Date(value);
            if (Number.isNaN(date.getTime())) return null;

            return {
                year: date.getFullYear(),
                month: date.getMonth() + 1,
                day: date.getDate(),
                hour: date.getHours(),
                minute: date.getMinutes(),
                hasTime,
            };
        },

        pad2(value) {
            return String(value).padStart(2, '0');
        },

        formatDate(dateStr) {
            const normalized = this.normalizeTaskDate(dateStr);
            const parts = this.parseNormalizedDateParts(normalized);
            if (!parts) return '';

            const dateText = `${this.pad2(parts.day)}.${this.pad2(parts.month)}.${parts.year}`;

            if (!parts.hasTime) return dateText;

            const hour = parts.hour ?? 0;
            const minute = parts.minute ?? 0;

            // Hide time when it is a placeholder (00:00 or 23:59), but only if time exists.
            if ((hour === 0 && minute === 0) || (hour === 23 && minute === 59)) {
                return dateText;
            }

            return `${dateText} ${this.pad2(hour)}:${this.pad2(minute)}`;
        },

        // Keep for compatibility with templates that expect a date+time formatter.
        // With deterministic formatting, it's the same as `formatDate`.
        formatDateTime(dateStr) {
            return this.formatDate(dateStr);
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


        async ensureTaskrcLoaded() {
            if (this.taskrcLoaded) return true;
            if (this.taskrcLoadPromise) return await this.taskrcLoadPromise;

            this.taskrcLoadPromise = (async () => {
                try {
                    this.taskrcLoading = true;
                    await this.loadTaskrc();
                    return this.taskrcLoaded;
                } finally {
                    this.taskrcLoading = false;
                    this.taskrcLoadPromise = null;
                }
            })();

            return await this.taskrcLoadPromise;
        },

        async loadTaskrc() {
            try {
                const response = await fetchFn('/api/taskrc', {
                    method: 'GET',
                    cache: 'no-store',
                });

                // Express may send a 304 when ETags are enabled. In that case we keep
                // the previously loaded taskrc so colors don't disappear.
                if (response.status === 304) {
                    const cached = this.loadedTaskrcText || this.taskrcText;
                    if (cached) {
                        this.taskrcText = cached;
                        this.loadedTaskrcText = cached;
                        this.parseTaskrcColors(cached);
                        this.taskrcLoaded = true;
                        return;
                    }

                    throw new Error('taskrc not modified (no cached copy available)');
                }

                if (!response.ok) throw new Error(await response.text());
                const text = await response.text();
                this.taskrcText = text;
                this.loadedTaskrcText = text;

                // Parse color rules from taskrc
                this.parseTaskrcColors(text);
                this.taskrcLoaded = true;
            } catch (error) {
                // Keep the last known-good rules so colors don't disappear due to
                // transient issues (e.g., offline or backend hiccups).
                const hasCached = Boolean(this.loadedTaskrcText || this.taskrcText);
                if (!hasCached) {
                    this.taskrcColorRules = {};
                }
                this.taskrcLoaded = hasCached;
                this.showToast(`Error loading taskrc: ${error.message}`, 'error');
            }
        },

        async saveTaskrc() {
            try {
                const response = await fetchFn('/api/taskrc', {
                    method: 'PUT',
                    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
                    body: this.taskrcText,
                });
                if (!response.ok) throw new Error(await response.text());
                this.loadedTaskrcText = this.taskrcText;

                // Re-parse color rules after saving
                this.parseTaskrcColors(this.taskrcText);
                this.taskrcLoaded = true;

                this.showToast('Saved taskrc', 'success');
            } catch (error) {
                this.showToast(`Error saving taskrc: ${error.message}`, 'error');
            }
        },
        
        parseTaskrcColors(taskrcContent) {
            // Use TaskColors module if available
            if (typeof TaskColors !== 'undefined' && TaskColors.parseTaskrcColors) {
                const parsed = TaskColors.parseTaskrcColors(taskrcContent);
                this.taskrcColorRules = parsed && typeof parsed === 'object' ? parsed : {};
                return;
            }

            this.taskrcColorRules = {};
        },
        
        getTaskTextStyle(task) {
            const full = this.getTaskColorStyle(task);
            if (!full || typeof full !== 'object') return {};

            const styles = { ...full };
            delete styles.backgroundColor;
            return styles;
        },

        getTaskCardStyle(task) {
            const full = this.getTaskColorStyle(task);
            const bg = full && typeof full === 'object' ? full.backgroundColor : null;
            return bg ? { backgroundColor: bg } : {};
        },

        getTaskColorStyle(task) {
            // Use TaskColors module if available
            if (typeof TaskColors !== 'undefined' && TaskColors.getTaskColorStyle) {
                return TaskColors.getTaskColorStyle(task, this.taskrcColorRules);
            }
            return {};
        },

         async saveBuiltinFilters() {
             const keys = ['today', 'inbox', 'next', 'all'];
 
             try {
                 for (const key of keys) {
                     const draft = this.settingsBuiltinVisibilityDraft[key];
                     if (!draft) continue;
 
                     const payload = {
                         visible: Boolean(draft.visible),
                     };
 
                     const result = await apiClient.updateBuiltinFilter(key, payload);
                     if (!result?.success) {
                         throw new Error(result?.error || `Failed to save built-in filter visibility: ${key}`);
                     }
                 }
 
                 await this.refreshBuiltinFilters();
                 this.showToast('Saved filter settings', 'success');
             } catch (error) {
                 this.showToast(String(error?.message || error), 'error');
             }
         },
 
         toggleBuiltinVisibility(key) {
             const k = String(key || '').trim();
             if (!k || !this.settingsBuiltinVisibilityDraft[k]) return;
             this.settingsBuiltinVisibilityDraft[k].visible = !this.settingsBuiltinVisibilityDraft[k].visible;
         },
 
         resetBuiltinSettingsDraft() {
             const keys = ['today', 'inbox', 'next', 'all'];
             const next = { ...this.settingsBuiltinVisibilityDraft };
             for (const key of keys) {
                 const current = this.builtinFilters[key];
                 if (!current) continue;
                 next[key] = {
                     visible: current.visible,
                 };
             }
             this.settingsBuiltinVisibilityDraft = next;
         },
    },
});

    return {
        app,
        apiClient,
        queryService,
        commandService,
    };
}

function mountTaskwarriorApp({
    element = '#app',
    baseUrl = '/api',
    fetchImpl,
} = {}) {
    const { app, apiClient, queryService, commandService } = createTaskwarriorApp({ baseUrl, fetchImpl });
    const vm = app.mount(element);

    return {
        app,
        vm,
        apiClient,
        queryService,
        commandService,
    };
}

const autoMountEnabled = options && options.autoMount;
if (autoMountEnabled && typeof window !== 'undefined' && window.document) {
    mountTaskwarriorApp({ element: '#app' });
}

return {
    TaskApiClient,
    TaskQueryService,
    TaskCommandService,
    createTaskwarriorApp,
    mountTaskwarriorApp,
    getTokenAtCursor,
    replaceRange,
    sanitizeTaskCommandArg,
};
}));
