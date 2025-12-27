// TaskWarrior Color Parser
// Converts TaskWarrior color rules to CSS color and style values

(function (root, factory) {
    const isCommonJs = typeof module !== 'undefined' && module.exports && typeof require === 'function';
    if (isCommonJs) {
        module.exports = factory();
    } else {
        root.TaskColors = factory();
    }
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

    // Basic color mapping
    const BASIC_COLORS = {
        'black': '#000000',
        'red': '#ff0000',
        'green': '#00ff00',
        'yellow': '#ffff00',
        'blue': '#0000ff',
        'magenta': '#ff00ff',
        'cyan': '#00ffff',
        'white': '#ffffff',
    };

    // RGB cube colors (rgb000 - rgb555)
    // Red/Green/Blue values from 0-5 each
    function parseRgbCube(colorStr) {
        const match = colorStr.match(/^rgb([0-5])([0-5])([0-5])$/);
        if (!match) return null;

        const r = parseInt(match[1], 10);
        const g = parseInt(match[2], 10);
        const b = parseInt(match[3], 10);

        // Convert 0-5 range to 0-255
        const toHex = (val) => {
            const scaled = Math.round((val / 5) * 255);
            return scaled.toString(16).padStart(2, '0');
        };

        return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
    }

    // Grayscale colors (gray0 - gray23)
    function parseGrayscale(colorStr) {
        const match = colorStr.match(/^gray(\d+)$/);
        if (!match) return null;

        const level = parseInt(match[1], 10);
        if (level < 0 || level > 23) return null;

        // Convert 0-23 range to 0-255
        const value = Math.round((level / 23) * 255);
        const hex = value.toString(16).padStart(2, '0');
        return `#${hex}${hex}${hex}`;
    }

    // Color codes (color0 - color255) - ANSI 256 color palette
    function parseColorCode(colorStr) {
        const match = colorStr.match(/^color(\d+)$/);
        if (!match) return null;

        const code = parseInt(match[1], 10);
        if (code < 0 || code > 255) return null;

        // ANSI 256 color palette approximation
        if (code < 16) {
            // Standard colors
            const standardColors = [
                '#000000', '#800000', '#008000', '#808000',
                '#000080', '#800080', '#008080', '#c0c0c0',
                '#808080', '#ff0000', '#00ff00', '#ffff00',
                '#0000ff', '#ff00ff', '#00ffff', '#ffffff',
            ];
            return standardColors[code] || '#ffffff';
        }

        if (code >= 16 && code <= 231) {
            // 216 color cube (6x6x6)
            const idx = code - 16;
            const r = Math.floor(idx / 36);
            const g = Math.floor((idx % 36) / 6);
            const b = idx % 6;

            const toHex = (val) => {
                const scaled = val === 0 ? 0 : 55 + val * 40;
                return scaled.toString(16).padStart(2, '0');
            };

            return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
        }

        // Grayscale ramp (232-255)
        const grayLevel = code - 232;
        const value = 8 + grayLevel * 10;
        const hex = value.toString(16).padStart(2, '0');
        return `#${hex}${hex}${hex}`;
    }

    /**
     * Parse a single TaskWarrior color token
     * @param {string} token - Color token (e.g., 'red', 'rgb500', 'gray12', 'color42')
     * @returns {string|null} - CSS color value or null if invalid
     */
    function parseColorToken(token) {
        const normalized = String(token || '').trim().toLowerCase();
        if (!normalized) return null;

        // Check basic colors
        if (BASIC_COLORS[normalized]) {
            return BASIC_COLORS[normalized];
        }

        // Check RGB cube
        const rgb = parseRgbCube(normalized);
        if (rgb) return rgb;

        // Check grayscale
        const gray = parseGrayscale(normalized);
        if (gray) return gray;

        // Check color codes
        const colorCode = parseColorCode(normalized);
        if (colorCode) return colorCode;

        return null;
    }

    /**
     * Parse a TaskWarrior color rule (e.g., "rgb500 on rgb005", "bold red", "underline on blue")
     * @param {string} rule - TaskWarrior color rule
     * @returns {Object} - { color, backgroundColor, bold, underline, inverse }
     */
    function parseColorRule(rule) {
        const normalized = String(rule || '').trim().toLowerCase();
        if (!normalized) return {};

        const result = {
            color: null,
            backgroundColor: null,
            bold: false,
            underline: false,
            inverse: false,
        };

        // Split by 'on' keyword to separate foreground and background
        const parts = normalized.split(/\s+on\s+/);
        const foregroundPart = parts[0] || '';
        const backgroundPart = parts[1] || '';

        // Parse foreground (can include effects like bold, underline)
        const fgTokens = foregroundPart.split(/\s+/).filter(Boolean);
        for (const token of fgTokens) {
            if (token === 'bold') {
                result.bold = true;
            } else if (token === 'underline') {
                result.underline = true;
            } else if (token === 'inverse') {
                result.inverse = true;
            } else {
                const color = parseColorToken(token);
                if (color) {
                    result.color = color;
                }
            }
        }

        // Parse background
        if (backgroundPart) {
            const bgTokens = backgroundPart.split(/\s+/).filter(Boolean);
            for (const token of bgTokens) {
                if (token === 'bold') {
                    result.bold = true;
                } else if (token === 'underline') {
                    result.underline = true;
                } else if (token === 'inverse') {
                    result.inverse = true;
                } else {
                    const color = parseColorToken(token);
                    if (color) {
                        result.backgroundColor = color;
                    }
                }
            }
        }

        return result;
    }

    /**
     * Convert parsed color rule to CSS style object
     * @param {Object} colorRule - Parsed color rule from parseColorRule
     * @returns {Object} - CSS style object
     */
    function colorRuleToCss(colorRule) {
        if (!colorRule) return {};

        const styles = {};

        if (colorRule.inverse) {
            // Swap foreground and background
            if (colorRule.color) {
                styles.backgroundColor = colorRule.color;
            }
            if (colorRule.backgroundColor) {
                styles.color = colorRule.backgroundColor;
            }
        } else {
            if (colorRule.color) {
                styles.color = colorRule.color;
            }
            if (colorRule.backgroundColor) {
                styles.backgroundColor = colorRule.backgroundColor;
            }
        }

        if (colorRule.bold) {
            styles.fontWeight = 'bold';
        }

        if (colorRule.underline) {
            styles.textDecoration = 'underline';
        }

        return styles;
    }

    /**
     * Parse taskrc content and extract color rules
     * @param {string} taskrcContent - Content of taskrc file
     * @returns {Object} - Map of rule names to parsed color rules
     */
    function parseTaskrcColors(taskrcContent) {
        const content = String(taskrcContent || '');
        const lines = content.split(/\r?\n/);
        const colorRules = {};

        for (const line of lines) {
            const trimmed = line.trim();

            // Skip comments and empty lines
            if (!trimmed || trimmed.startsWith('#')) continue;

            // Match color.* rules
            const match = trimmed.match(/^color\.([a-zA-Z0-9_.]+)\s*=\s*(.+)$/);
            if (match) {
                const ruleName = match[1].trim();
                const ruleValue = match[2].trim();

                colorRules[ruleName] = parseColorRule(ruleValue);
            }
        }

        return colorRules;
    }

    /**
     * Get color style for a task based on its attributes and taskrc color rules
     * @param {Object} task - Task object
     * @param {Object} colorRules - Parsed color rules from parseTaskrcColors
     * @returns {Object} - CSS style object
     */
    function getTaskColorStyle(task, colorRules) {
        if (!task || !colorRules || Object.keys(colorRules).length === 0) {
            return {};
        }

        // Priority: Most specific rules take precedence
        // Order: tag-specific > project-specific > priority-specific > status-specific
        // (Later assignments override earlier ones)

        const status = String(task?.status || 'pending').toLowerCase();
        const priority = String(task?.priority || '').toUpperCase();
        const project = String(task?.project || '');
        const tags = Array.isArray(task?.tags) ? task.tags : [];

        let matchedRule = null;

        // Check status-specific colors
        if (colorRules[status]) {
            matchedRule = colorRules[status];
        }

        // Check priority-specific colors (overrides status)
        if (priority && colorRules[`priority.${priority}`]) {
            matchedRule = colorRules[`priority.${priority}`];
        }

        // Check project-specific colors (overrides priority)
        if (project && colorRules[`project.${project}`]) {
            matchedRule = colorRules[`project.${project}`];
        }

        // Check tag-specific colors (overrides project)
        for (const tag of tags) {
            if (colorRules[`tag.${tag}`]) {
                matchedRule = colorRules[`tag.${tag}`];
                break; // Use first matching tag
            }
        }

        return matchedRule ? colorRuleToCss(matchedRule) : {};
    }

    return {
        parseColorToken,
        parseColorRule,
        colorRuleToCss,
        parseTaskrcColors,
        getTaskColorStyle,
    };
}));
