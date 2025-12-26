const winston = require('winston');
const path = require('path');
const fs = require('fs');

// Ensure logs directory exists
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
    fs.mkdirSync(logsDir, { recursive: true });
}

/**
 * Creates and configures a Winston logger instance
 * 
 * @param {string} logLevel - Logging level (error, warn, info, debug)
 * @returns {winston.Logger} Configured logger instance
 */
function createLogger(logLevel = 'info') {
    const logger = winston.createLogger({
        level: logLevel,
        format: winston.format.combine(
            winston.format.timestamp({
                format: 'YYYY-MM-DD HH:mm:ss'
            }),
            winston.format.errors({ stack: true }),
            winston.format.json()
        ),
        defaultMeta: { service: 'taskwarrior-web' },
        transports: [
            // Error log - only errors
            new winston.transports.File({
                filename: path.join(logsDir, 'error.log'),
                level: 'error',
                maxsize: 10485760, // 10MB
                maxFiles: 5,
                tailable: true
            }),
            // Combined log - all levels
            new winston.transports.File({
                filename: path.join(logsDir, 'combined.log'),
                maxsize: 10485760, // 10MB
                maxFiles: 5,
                tailable: true
            })
        ],
        // Don't exit on handled exceptions
        exitOnError: false
    });
    
    // Add console output in development
    if (process.env.NODE_ENV !== 'production') {
        logger.add(new winston.transports.Console({
            format: winston.format.combine(
                winston.format.colorize(),
                winston.format.simple()
            )
        }));
    }
    
    return logger;
}

/**
 * Express middleware for logging HTTP requests
 * 
 * @param {winston.Logger} logger - Winston logger instance
 * @returns {Function} Express middleware function
 */
function requestLogger(logger) {
    return (req, res, next) => {
        const start = Date.now();
        
        // Log when response is sent
        res.on('finish', () => {
            const duration = Date.now() - start;
            const logData = {
                method: req.method,
                path: req.path,
                status: res.statusCode,
                duration: `${duration}ms`,
                ip: req.ip || req.connection.remoteAddress,
                userAgent: req.get('user-agent') || 'unknown'
            };
            
            // Log based on status code
            if (res.statusCode >= 500) {
                logger.error('HTTP Request Failed', logData);
            } else if (res.statusCode >= 400) {
                logger.warn('HTTP Request Client Error', logData);
            } else {
                logger.info('HTTP Request', logData);
            }
        });
        
        next();
    };
}

/**
 * Express error handling middleware for logging errors
 * 
 * @param {winston.Logger} logger - Winston logger instance
 * @returns {Function} Express error middleware function
 */
function errorLogger(logger) {
    return (err, req, res, next) => {
        logger.error('Application Error', {
            error: err.message,
            stack: err.stack,
            path: req.path,
            method: req.method,
            ip: req.ip || req.connection.remoteAddress,
            body: req.body,
            query: req.query
        });
        
        next(err);
    };
}

module.exports = {
    createLogger,
    requestLogger,
    errorLogger
};
