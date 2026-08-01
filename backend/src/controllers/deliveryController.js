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

// POST /api/picking/session/:sessionId/deliveries/:cardCode/retry
async function retryDelivery(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        const { cardCode } = req.params;
        if (isNaN(sessionId) || !cardCode)
            return res.status(400).json({ success: false, message: 'sessionId and cardCode required' });

        const result = await svc.triggerPartyDelivery(sessionId, cardCode);
        const status = result.success ? 200 : 502;
        res.status(status).json({ success: result.success, data: result });
    } catch (err) { next(err); }
}

module.exports = { getDeliveries, retryDelivery };
