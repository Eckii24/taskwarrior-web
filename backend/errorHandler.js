/**
 * Custom application error class
 */
class AppError extends Error {
    /**
     * Creates an application error
     * 
     * @param {string} message - Error message
     * @param {number} statusCode - HTTP status code
     * @param {boolean} isOperational - Whether error is operational (expected) or programming error
     */
    constructor(message, statusCode = 500, isOperational = true) {
        super(message);
        this.statusCode = statusCode;
        this.isOperational = isOperational;
        this.name = this.constructor.name;
        
        Error.captureStackTrace(this, this.constructor);
    }
}

/**
 * Express error handling middleware
 * Catches all errors and sends appropriate response
 * 
 * @param {winston.Logger} logger - Winston logger instance
 * @returns {Function} Express error middleware function
 */
function errorHandler(logger) {
    return (err, req, res, next) => {
        // Default to 500 server error
        const statusCode = err.statusCode || 500;
        
        // Determine if we should expose the error message
        const isProduction = process.env.NODE_ENV === 'production';
        const shouldExposeError = err.isOperational || !isProduction;
        
        // Prepare error response
        const errorResponse = {
            success: false,
            error: shouldExposeError 
                ? err.message 
                : 'Internal server error'
        };
        
        // Add stack trace in development
        if (!isProduction && err.stack) {
            errorResponse.stack = err.stack;
        }
        
        // Log the error
        if (logger) {
            logger.error('Error Handler', {
                message: err.message,
                stack: err.stack,
                statusCode,
                isOperational: err.isOperational,
                path: req.path,
                method: req.method
            });
        }
        
        // Send error response
        res.status(statusCode).json(errorResponse);
    };
}

/**
 * Async handler wrapper to catch errors in async route handlers
 * 
 * @param {Function} fn - Async route handler function
 * @returns {Function} Wrapped function that catches errors
 */
function asyncHandler(fn) {
    return (req, res, next) => {
        Promise.resolve(fn(req, res, next)).catch(next);
    };
}

/**
 * 404 Not Found handler
 * 
 * @returns {Function} Express middleware function
 */
function notFoundHandler() {
    return (req, res, next) => {
        const error = new AppError(
            `Route not found: ${req.method} ${req.path}`,
            404
        );
        next(error);
    };
}

module.exports = {
    AppError,
    errorHandler,
    asyncHandler,
    notFoundHandler
};
