const svc        = require('../services/recheckService');
const pickingSvc = require('../services/gtpPickingService');

// POST /api/picking/session/:sessionId/recheck/reset
// body: { cardCode, docEntry, itemCode?, reason?, operatorId? } — omit itemCode to reset the whole group
async function resetForRepick(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        const { cardCode, docEntry, itemCode, reason, operatorId } = req.body;
        if (isNaN(sessionId) || !cardCode || docEntry == null || isNaN(parseInt(docEntry)))
            return res.status(400).json({ success: false, message: 'sessionId, cardCode and docEntry required' });

        const result = await svc.resetForRepick(sessionId, {
            cardCode,
            docEntry:   parseInt(docEntry),
            itemCode:   itemCode || null,
            reason:     reason ? String(reason).trim() || null : null,
            operatorId: operatorId ? parseInt(operatorId) : null,
        });
        const session = await pickingSvc.getSession(sessionId);
        res.json({ success: true, data: { ...result, session } });
    } catch (err) { next(err); }
}

// GET /api/picking/session/:sessionId/recheck/history
async function getHistory(req, res, next) {
    try {
        const sessionId = parseInt(req.params.sessionId);
        if (isNaN(sessionId)) return res.status(400).json({ success: false, message: 'Invalid sessionId' });
        const history = await svc.getRecheckHistory(sessionId);
        res.json({ success: true, data: history });
    } catch (err) { next(err); }
}

module.exports = { resetForRepick, getHistory };
