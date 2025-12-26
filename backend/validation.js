const Joi = require('joi');

/**
 * Validation schemas for API requests
 */
const schemas = {
    /**
     * Schema for creating a new filter
     */
    createFilter: Joi.object({
        name: Joi.string()
            .trim()
            .min(1)
            .max(100)
            .required()
            .messages({
                'string.empty': 'Filter name is required',
                'string.max': 'Filter name must be at most 100 characters'
            }),
        filter: Joi.string()
            .trim()
            .min(1)
            .max(500)
            .required()
            // More permissive pattern - allows taskwarrior syntax including parens, quotes, operators
            .pattern(/^[a-zA-Z0-9_.:+\-\s()"'<>=!]+$/)
            .messages({
                'string.empty': 'Filter query is required',
                'string.pattern.base': 'Filter contains potentially dangerous characters',
                'string.max': 'Filter query must be at most 500 characters'
            })
    }),
    
    /**
     * Schema for updating an existing filter
     */
    updateFilter: Joi.object({
        name: Joi.string()
            .trim()
            .min(1)
            .max(100)
            .optional(),
        filter: Joi.string()
            .trim()
            .min(1)
            .max(500)
            .pattern(/^[a-zA-Z0-9_.:+\-\s()"'<>=!]+$/)
            .optional(),
        order: Joi.number()
            .integer()
            .min(0)
            .optional()
    }).min(1),
    
    /**
     * Schema for reordering filters
     */
    reorderFilters: Joi.object({
        ids: Joi.array()
            .items(Joi.number().integer().positive())
            .min(1)
            .required()
            .messages({
                'array.min': 'At least one filter ID is required',
                'array.base': 'IDs must be provided as an array'
            })
    }),
    
    /**
     * Schema for executing task commands
     */
    executeTask: Joi.object({
        args: Joi.alternatives()
            .try(
                Joi.string().trim().min(1).max(2000),
                Joi.array().items(Joi.string().trim().min(1).max(200)).min(1)
            )
            .required()
            .messages({
                'alternatives.match': 'args must be a string or array of strings',
                'any.required': 'args parameter is required'
            })
    }),
    
    /**
     * Schema for taskrc content validation
     */
    taskrcContent: Joi.string()
        .max(256 * 1024) // 256KB max
        .custom((value, helpers) => {
            // Validate each line
            const lines = value.split('\n');
            const dangerousPatterns = [
                /^hooks\./i,            // Prevent hook execution (hooks.*)
                /^on-\w+=/i,            // Prevent event handlers
                /\$\(.*\)/,             // Prevent command substitution
                /`.*`/,                 // Prevent backtick command execution
                /;\s*\w+/,              // Prevent command chaining
            ];
            
            for (let i = 0; i < lines.length; i++) {
                const line = lines[i].trim();
                
                // Skip empty lines and comments
                if (!line || line.startsWith('#')) continue;
                
                // Check for dangerous patterns
                for (const pattern of dangerousPatterns) {
                    if (pattern.test(line)) {
                        return helpers.error('any.custom', {
                            message: `Line ${i + 1} contains forbidden directive: ${line.substring(0, 50)}`
                        });
                    }
                }
                
                // Validate line format: key=value or key.subkey=value
                // Taskwarrior keys can contain letters, numbers, dots, underscores, colons
                if (!/^[\w.:-]+=.*$/.test(line)) {
                    return helpers.error('any.custom', {
                        message: `Line ${i + 1} has invalid format: ${line.substring(0, 50)}`
                    });
                }
            }
            
            return value;
        })
        .messages({
            'string.max': 'Configuration file too large (max 256KB)',
            'any.custom': '{{#message}}'
        }),
    
    /**
     * Schema for completion query parameters
     */
    completeQuery: Joi.object({
        token: Joi.string()
            .trim()
            .max(100)
            .default(''),
        limit: Joi.number()
            .integer()
            .min(1)
            .max(50)
            .default(20)
    })
};

/**
 * Middleware factory for validating request body against a schema
 * 
 * @param {Joi.Schema} schema - Joi schema to validate against
 * @returns {Function} Express middleware function
 */
function validateBody(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.body, {
            abortEarly: false,
            stripUnknown: true
        });
        
        if (error) {
            const messages = error.details.map(d => d.message);
            return res.status(400).json({
                success: false,
                error: messages.join('; ')
            });
        }
        
        req.body = value;
        next();
    };
}

/**
 * Middleware factory for validating query parameters against a schema
 * 
 * @param {Joi.Schema} schema - Joi schema to validate against
 * @returns {Function} Express middleware function
 */
function validateQuery(schema) {
    return (req, res, next) => {
        const { error, value } = schema.validate(req.query, {
            abortEarly: false,
            stripUnknown: true
        });
        
        if (error) {
            const messages = error.details.map(d => d.message);
            return res.status(400).json({
                success: false,
                error: messages.join('; ')
            });
        }
        
        req.query = value;
        next();
    };
}

/**
 * Validates that task arguments don't contain shell metacharacters or command injection patterns
 * Note: Allows parentheses and brackets for legitimate taskwarrior syntax (date calc, UDAs)
 * 
 * @param {string|string[]} args - Task arguments to validate
 * @throws {Error} If args contain dangerous characters or patterns
 */
function validateTaskArgs(args) {
    const argsArray = Array.isArray(args) ? args : [args];
    
    // Block only the most dangerous shell metacharacters
    // Allow ( ) [ ] for taskwarrior syntax but block command execution chars
    const dangerousPatterns = /[;&|`$\\]/;
    
    for (const arg of argsArray) {
        if (typeof arg === 'string') {
            if (dangerousPatterns.test(arg)) {
                throw new Error(
                    'Arguments contain forbidden shell metacharacters: ' + arg.substring(0, 50)
                );
            }
            // Also check for command substitution patterns
            if (/\$\(/.test(arg) || /`/.test(arg)) {
                throw new Error('Arguments contain command substitution: ' + arg.substring(0, 50));
            }
        }
    }
}

module.exports = {
    schemas,
    validateBody,
    validateQuery,
    validateTaskArgs
};
