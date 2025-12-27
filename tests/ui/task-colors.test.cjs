/**
 * @jest-environment jsdom
 */

const TaskColors = require('../../public/task-colors.js');

describe('TaskColors', () => {
    describe('parseColorToken', () => {
        test('parses basic colors', () => {
            expect(TaskColors.parseColorToken('red')).toBe('#ff0000');
            expect(TaskColors.parseColorToken('green')).toBe('#00ff00');
            expect(TaskColors.parseColorToken('blue')).toBe('#0000ff');
            expect(TaskColors.parseColorToken('yellow')).toBe('#ffff00');
            expect(TaskColors.parseColorToken('white')).toBe('#ffffff');
            expect(TaskColors.parseColorToken('black')).toBe('#000000');
            expect(TaskColors.parseColorToken('cyan')).toBe('#00ffff');
            expect(TaskColors.parseColorToken('magenta')).toBe('#ff00ff');
        });

        test('parses RGB cube colors', () => {
            expect(TaskColors.parseColorToken('rgb000')).toBe('#000000');
            expect(TaskColors.parseColorToken('rgb555')).toBe('#ffffff');
            expect(TaskColors.parseColorToken('rgb500')).toBe('#ff0000');
            expect(TaskColors.parseColorToken('rgb050')).toBe('#00ff00');
            expect(TaskColors.parseColorToken('rgb005')).toBe('#0000ff');
        });

        test('parses grayscale colors', () => {
            expect(TaskColors.parseColorToken('gray0')).toBe('#000000');
            expect(TaskColors.parseColorToken('gray23')).toBe('#ffffff');
            expect(TaskColors.parseColorToken('gray12')).toMatch(/^#[0-9a-f]{6}$/);
        });

        test('parses color codes', () => {
            expect(TaskColors.parseColorToken('color0')).toBe('#000000');
            expect(TaskColors.parseColorToken('color15')).toBe('#ffffff');
            expect(TaskColors.parseColorToken('color42')).toMatch(/^#[0-9a-f]{6}$/);
        });

        test('handles invalid colors', () => {
            expect(TaskColors.parseColorToken('invalid')).toBeNull();
            expect(TaskColors.parseColorToken('rgb666')).toBeNull();
            expect(TaskColors.parseColorToken('gray24')).toBeNull();
            expect(TaskColors.parseColorToken('color256')).toBeNull();
            expect(TaskColors.parseColorToken('')).toBeNull();
            expect(TaskColors.parseColorToken(null)).toBeNull();
        });

        test('is case-insensitive', () => {
            expect(TaskColors.parseColorToken('RED')).toBe('#ff0000');
            expect(TaskColors.parseColorToken('RGB500')).toBe('#ff0000');
            expect(TaskColors.parseColorToken('GRAY12')).toMatch(/^#[0-9a-f]{6}$/);
        });
    });

    describe('parseColorRule', () => {
        test('parses simple foreground color', () => {
            const rule = TaskColors.parseColorRule('red');
            expect(rule.color).toBe('#ff0000');
            expect(rule.backgroundColor).toBeNull();
            expect(rule.bold).toBe(false);
            expect(rule.underline).toBe(false);
        });

        test('parses foreground and background colors', () => {
            const rule = TaskColors.parseColorRule('rgb500 on rgb005');
            expect(rule.color).toBe('#ff0000');
            expect(rule.backgroundColor).toBe('#0000ff');
        });

        test('parses bold effect', () => {
            const rule = TaskColors.parseColorRule('bold red');
            expect(rule.color).toBe('#ff0000');
            expect(rule.bold).toBe(true);
        });

        test('parses underline effect', () => {
            const rule = TaskColors.parseColorRule('underline green');
            expect(rule.color).toBe('#00ff00');
            expect(rule.underline).toBe(true);
        });

        test('parses inverse effect', () => {
            const rule = TaskColors.parseColorRule('inverse');
            expect(rule.inverse).toBe(true);
        });

        test('parses multiple effects', () => {
            const rule = TaskColors.parseColorRule('bold underline red on blue');
            expect(rule.color).toBe('#ff0000');
            expect(rule.backgroundColor).toBe('#0000ff');
            expect(rule.bold).toBe(true);
            expect(rule.underline).toBe(true);
        });

        test('handles empty rule', () => {
            const rule = TaskColors.parseColorRule('');
            expect(rule).toEqual({});
        });
    });

    describe('colorRuleToCss', () => {
        test('converts basic color rule to CSS', () => {
            const rule = TaskColors.parseColorRule('red');
            const css = TaskColors.colorRuleToCss(rule);
            expect(css.color).toBe('#ff0000');
            expect(css.backgroundColor).toBeUndefined();
        });

        test('converts foreground and background to CSS', () => {
            const rule = TaskColors.parseColorRule('rgb500 on rgb005');
            const css = TaskColors.colorRuleToCss(rule);
            expect(css.color).toBe('#ff0000');
            expect(css.backgroundColor).toBe('#0000ff');
        });

        test('converts bold effect to CSS', () => {
            const rule = TaskColors.parseColorRule('bold red');
            const css = TaskColors.colorRuleToCss(rule);
            expect(css.fontWeight).toBe('bold');
        });

        test('converts underline effect to CSS', () => {
            const rule = TaskColors.parseColorRule('underline green');
            const css = TaskColors.colorRuleToCss(rule);
            expect(css.textDecoration).toBe('underline');
        });

        test('handles inverse effect', () => {
            const rule = TaskColors.parseColorRule('inverse red on blue');
            const css = TaskColors.colorRuleToCss(rule);
            // Inverse swaps foreground and background
            expect(css.color).toBe('#0000ff');
            expect(css.backgroundColor).toBe('#ff0000');
        });

        test('handles null rule', () => {
            const css = TaskColors.colorRuleToCss(null);
            expect(css).toEqual({});
        });
    });

    describe('parseTaskrcColors', () => {
        test('parses color rules from taskrc content', () => {
            const taskrc = `
# This is a comment
color.active=rgb500
color.completed=gray12
color.pending=bold blue on white
            `;

            const rules = TaskColors.parseTaskrcColors(taskrc);
            expect(rules.active).toBeDefined();
            expect(rules.active.color).toBe('#ff0000');
            expect(rules.completed).toBeDefined();
            expect(rules.pending).toBeDefined();
            expect(rules.pending.bold).toBe(true);
        });

        test('ignores non-color rules', () => {
            const taskrc = `
data.location=/home/user/.task
color.active=red
report.next.description=Next tasks
            `;

            const rules = TaskColors.parseTaskrcColors(taskrc);
            expect(Object.keys(rules)).toHaveLength(1);
            expect(rules.active).toBeDefined();
        });

        test('handles empty taskrc', () => {
            const rules = TaskColors.parseTaskrcColors('');
            expect(rules).toEqual({});
        });

        test('handles taskrc with only comments', () => {
            const taskrc = `
# Comment 1
# Comment 2
            `;
            const rules = TaskColors.parseTaskrcColors(taskrc);
            expect(rules).toEqual({});
        });

        test('parses various color rule formats', () => {
            const taskrc = `
color.active=rgb500 on rgb005
color.priority.H=bold red
color.project.Work=blue on gray5
color.tag.urgent=underline yellow
            `;

            const rules = TaskColors.parseTaskrcColors(taskrc);
            expect(rules.active).toBeDefined();
            expect(rules['priority.H']).toBeDefined();
            expect(rules['project.Work']).toBeDefined();
            expect(rules['tag.urgent']).toBeDefined();
        });
    });

    describe('getTaskColorStyle', () => {
        const colorRules = {
            'pending': TaskColors.parseColorRule('blue'),
            'completed': TaskColors.parseColorRule('green'),
            'priority.H': TaskColors.parseColorRule('bold red'),
            'project.Work': TaskColors.parseColorRule('yellow on gray5'),
            'tag.urgent': TaskColors.parseColorRule('underline red'),
        };

        test('returns status-based color', () => {
            const task = { status: 'pending' };
            const style = TaskColors.getTaskColorStyle(task, colorRules);
            expect(style.color).toBe('#0000ff');
        });

        test('priority overrides status', () => {
            const task = { status: 'pending', priority: 'H' };
            const style = TaskColors.getTaskColorStyle(task, colorRules);
            expect(style.color).toBe('#ff0000');
            expect(style.fontWeight).toBe('bold');
        });

        test('project overrides priority', () => {
            const task = { status: 'pending', priority: 'H', project: 'Work' };
            const style = TaskColors.getTaskColorStyle(task, colorRules);
            expect(style.color).toBe('#ffff00');
        });

        test('tag overrides project', () => {
            const task = {
                status: 'pending',
                priority: 'H',
                project: 'Work',
                tags: ['urgent'],
            };
            const style = TaskColors.getTaskColorStyle(task, colorRules);
            expect(style.color).toBe('#ff0000');
            expect(style.textDecoration).toBe('underline');
        });

        test('returns empty object when no color rules', () => {
            const task = { status: 'pending' };
            const style = TaskColors.getTaskColorStyle(task, {});
            expect(style).toEqual({});
        });

        test('returns empty object when task has no matching rules', () => {
            const task = { status: 'waiting' };
            const style = TaskColors.getTaskColorStyle(task, colorRules);
            expect(style).toEqual({});
        });

        test('handles null/undefined inputs gracefully', () => {
            expect(TaskColors.getTaskColorStyle(null, colorRules)).toEqual({});
            expect(TaskColors.getTaskColorStyle({}, null)).toEqual({});
        });

        describe('attribute-based colors', () => {
            const attributeRules = {
                'pending': TaskColors.parseColorRule('white'),
                'due': TaskColors.parseColorRule('red'),
                'overdue': TaskColors.parseColorRule('bold red'),
                'active': TaskColors.parseColorRule('green'),
                'scheduled': TaskColors.parseColorRule('yellow'),
                'recurring': TaskColors.parseColorRule('blue'),
                'tagged': TaskColors.parseColorRule('cyan'),
                'blocked': TaskColors.parseColorRule('magenta'),
            };

            test('applies color.due when task has due date', () => {
                const task = { status: 'pending', due: '2099-12-31T00:00:00Z' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#ff0000');
            });

            test('applies color.overdue when task is overdue', () => {
                const task = { status: 'pending', due: '2020-01-01T00:00:00Z' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#ff0000');
                expect(style.fontWeight).toBe('bold');
            });

            test('does not apply color.overdue to completed tasks', () => {
                const task = { status: 'completed', due: '2020-01-01T00:00:00Z' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                // Should not match overdue, might match status or nothing
                expect(style.fontWeight).not.toBe('bold');
            });

            test('applies color.active when task is active', () => {
                const task = { status: 'pending', start: '2024-01-01T00:00:00Z' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#00ff00');
            });

            test('applies color.scheduled when task has scheduled date', () => {
                const task = { status: 'pending', scheduled: '2024-01-01T00:00:00Z' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#ffff00');
            });

            test('applies color.recurring when task is recurring', () => {
                const task = { status: 'pending', recur: 'weekly' };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#0000ff');
            });

            test('applies color.tagged when task has tags', () => {
                const task = { status: 'pending', tags: ['work'] };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#00ffff');
            });

            test('applies color.blocked when task has dependencies', () => {
                const task = { status: 'pending', depends: ['uuid-123'] };
                const style = TaskColors.getTaskColorStyle(task, attributeRules);
                expect(style.color).toBe('#ff00ff');
            });

            test('priority overrides attribute-based colors', () => {
                const rulesWithPriority = {
                    ...attributeRules,
                    'priority.H': TaskColors.parseColorRule('bold white'),
                };
                const task = { status: 'pending', due: '2099-12-31T00:00:00Z', priority: 'H' };
                const style = TaskColors.getTaskColorStyle(task, rulesWithPriority);
                expect(style.color).toBe('#ffffff');
                expect(style.fontWeight).toBe('bold');
            });

            test('tag-specific overrides attribute-based colors', () => {
                const rulesWithTag = {
                    ...attributeRules,
                    'tag.urgent': TaskColors.parseColorRule('underline white'),
                };
                const task = { status: 'pending', due: '2099-12-31T00:00:00Z', tags: ['urgent'] };
                const style = TaskColors.getTaskColorStyle(task, rulesWithTag);
                expect(style.color).toBe('#ffffff');
                expect(style.textDecoration).toBe('underline');
            });
        });
    });
});
