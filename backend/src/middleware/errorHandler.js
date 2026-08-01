function errorHandler(err, req, res, next) {
    console.error('❌', err.stack || err.message);
    const status = err.status || err.statusCode || 500;
    res.status(status).json({
        success: false,
        message: err.message || 'Internal Server Error',
        ...(err.code && { code: err.code }),
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}

module.exports = errorHandler;
