const Joi = require('joi');
const path = require('path');
const os = require('os');

/**
 * Configuration schema for environment variables
 */
const configSchema = Joi.object({
    PORT: Joi.number().port().default(3000),
    NODE_ENV: Joi.string()
        .valid('development', 'production', 'test')
        .default('development'),
    TASKDATA: Joi.string().optional(),
    TASKRC: Joi.string().optional(),
    SETTINGS_DB: Joi.string().optional(),
    ALLOWED_TASK_PATHS: Joi.string()
        .optional()
        .description('Comma-separated list of allowed base paths for task data'),
    LOG_LEVEL: Joi.string()
        .valid('error', 'warn', 'info', 'debug')
        .default('info'),
    ALLOWED_ORIGINS: Joi.string()
        .default('http://localhost:3000'),
    SESSION_SECRET: Joi.string().min(32).when('NODE_ENV', {
        is: 'production',
        then: Joi.required(),
        otherwise: Joi.optional()
    })
}).unknown(true);

/**
 * Validates a filesystem path to prevent path traversal attacks
 * 
 * @param {string} configuredPath - The path to validate
 * @param {string} defaultPath - Default path if configuredPath is not provided
 * @param {string} name - Name of the path for error messages
 * @param {string[]} allowedPaths - List of allowed base paths
 * @returns {string} The validated absolute path
 * @throws {Error} If path contains traversal or is outside allowed directories
 */
function validatePath(configuredPath, defaultPath, name, allowedPaths) {
    if (!configuredPath) return defaultPath;
    
    const resolved = path.resolve(configuredPath);
    
    // Check for path traversal sequences before and after resolution
    if (configuredPath.includes('..')) {
        throw new Error(`Invalid ${name}: contains path traversal sequence`);
    }
    
    // Additional check: ensure no '..' components in normalized path
    const parts = resolved.split(path.sep);
    if (parts.includes('..')) {
        throw new Error(`Invalid ${name}: contains path traversal`);
    }
    
    // Ensure it's within allowed directories
    const isAllowed = allowedPaths.some(allowed => {
        const resolvedAllowed = path.resolve(allowed);
        return resolved.startsWith(resolvedAllowed + path.sep) || resolved === resolvedAllowed;
    });
    
    if (!isAllowed) {
        throw new Error(
            `Invalid ${name}: outside allowed directories. ` +
            `Path must be within: ${allowedPaths.join(', ')}`
        );
    }
    
    return resolved;
}

/**
 * Loads and validates configuration from environment variables
 * 
 * @returns {Object} Validated configuration object
 * @throws {Error} If configuration is invalid
 */
function loadConfig() {
    const { error, value } = configSchema.validate(process.env, {
        abortEarly: false
    });
    
    if (error) {
        console.error('Configuration validation failed:');
        error.details.forEach(detail => {
            console.error(`  - ${detail.message}`);
        });
        throw new Error('Invalid configuration');
    }
    
    // Validate and set paths
    const DEFAULT_TASKDATA_PATH = path.join(os.homedir(), '.task');
    const DEFAULT_TASKRC_PATH = path.join(DEFAULT_TASKDATA_PATH, 'taskrc');
    const DEFAULT_SETTINGS_DB_PATH = path.join(DEFAULT_TASKDATA_PATH, 'taskwarrior-web.sqlite');
    
    // Get allowed paths from config or use defaults
    const defaultAllowedPaths = [
        os.homedir(),
        '/var/lib/taskwarrior',
        '/app/.task',
        '/app/data'  // For Docker environments
    ];
    
    const allowedPaths = value.ALLOWED_TASK_PATHS 
        ? value.ALLOWED_TASK_PATHS.split(',').map(p => p.trim())
        : defaultAllowedPaths;
    
    try {
        value.TASKDATA_PATH = validatePath(
            value.TASKDATA,
            DEFAULT_TASKDATA_PATH,
            'TASKDATA',
            allowedPaths
        );
        
        value.TASKRC_PATH = validatePath(
            value.TASKRC,
            DEFAULT_TASKRC_PATH,
            'TASKRC',
            allowedPaths
        );
        
        value.SETTINGS_DB_PATH = validatePath(
            value.SETTINGS_DB,
            DEFAULT_SETTINGS_DB_PATH,
            'SETTINGS_DB',
            allowedPaths
        );
    } catch (pathError) {
        console.error('Path validation failed:', pathError.message);
        throw pathError;
    }
    
    return value;
}

module.exports = {
    loadConfig,
    validatePath
};
