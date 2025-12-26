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
 * @returns {string} The validated absolute path
 * @throws {Error} If path contains traversal or is outside allowed directories
 */
function validatePath(configuredPath, defaultPath, name) {
    if (!configuredPath) return defaultPath;
    
    const resolved = path.resolve(configuredPath);
    const normalized = path.normalize(resolved);
    
    // Ensure path doesn't contain traversal sequences
    if (resolved !== normalized) {
        throw new Error(`Invalid ${name}: contains path traversal`);
    }
    
    // Ensure it's within allowed directories
    const home = os.homedir();
    const allowedPaths = [
        home,
        '/var/lib/taskwarrior',
        '/app/.task',
        '/app/data'  // For Docker environments
    ];
    
    const isAllowed = allowedPaths.some(allowed => {
        const resolvedAllowed = path.resolve(allowed);
        return resolved.startsWith(resolvedAllowed);
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
    
    try {
        value.TASKDATA_PATH = validatePath(
            value.TASKDATA,
            DEFAULT_TASKDATA_PATH,
            'TASKDATA'
        );
        
        value.TASKRC_PATH = validatePath(
            value.TASKRC,
            DEFAULT_TASKRC_PATH,
            'TASKRC'
        );
        
        value.SETTINGS_DB_PATH = validatePath(
            value.SETTINGS_DB,
            DEFAULT_SETTINGS_DB_PATH,
            'SETTINGS_DB'
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
