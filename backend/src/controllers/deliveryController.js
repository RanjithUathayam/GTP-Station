const svc = require('../services/deliveryService');

// GET /api/picking/session/:sessionId/deliveries
async function getDeliveries(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        if (isNaN(sessionId)) return res.status(400).json({ success: false, message: 'Invalid sessionId' });

        const records = await svc.getSessionDeliveries(sessionId);
        res.json({ success: true, data: records });
    } catch (err) { next(err); }
}

// POST /api/picking/session/:sessionId/deliveries/:cardCode/:docEntry/retry
async function retryDelivery(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        const docEntry  = parseInt(req.params.docEntry);
        const { cardCode } = req.params;
        if (isNaN(sessionId) || !cardCode || isNaN(docEntry))
            return res.status(400).json({ success: false, message: 'sessionId, cardCode and docEntry required' });

        // Guarded post: refuses an already-posted or not-fully-picked group, and releases an OnHold one.
        const result = await svc.releaseDocumentDelivery(sessionId, cardCode, docEntry);
        const status = result.success ? 200 : 502;
        res.status(status).json({ success: result.success, data: result, message: result.error });
    } catch (err) { next(err); }
}

// POST /api/picking/session/:sessionId/deliveries/release — every OnHold group in the session
async function releaseAll(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        if (isNaN(sessionId)) return res.status(400).json({ success: false, message: 'Invalid sessionId' });
        const results = await svc.releaseSessionDeliveries(sessionId);
        res.json({
            success: results.every(r => r.success),
            data: {
                results,
                released: results.filter(r => r.success).length,
                failed:   results.filter(r => !r.success).length,
            },
        });
    } catch (err) { next(err); }
}

module.exports = { getDeliveries, retryDelivery, releaseAll };
