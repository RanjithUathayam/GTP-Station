const svc = require('../services/picklistStatusService');

// GET /api/picking/sessions
async function getSessions(req, res, next) {
    try {
        const sessions = await svc.listSessions();
        res.json({ success: true, data: sessions });
    } catch (err) { next(err); }
}

module.exports = { getSessions };
