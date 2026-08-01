const svc = require('../services/gtpPickingService');

async function loadPicklist(req, res, next) {
    try {
        const { headerId } = req.params;
        const rows = await svc.loadPicklistData(headerId);
        if (!rows.length)
            return res.status(404).json({ success: false, message: `Picklist "${headerId}" not found`, code: 'PICKLIST_NOT_FOUND' });

        const countofOrder = rows[0].CountofOrder;
        const joinOrderRow = rows.find(r => r.JoinOrder != null && String(r.JoinOrder).trim() !== '');
        const joinOrder    = joinOrderRow ? String(joinOrderRow.JoinOrder).trim() : null;

        // Group by party for preview (no session yet)
        const partyMap = {};
        for (const r of rows) {
            if (!partyMap[r.CardCode]) {
                partyMap[r.CardCode] = {
                    cardCode: r.CardCode, cardName: r.CardName,
                    orderCount: new Set(), itemCount: 0, totalRequiredQty: 0,
                };
            }
            partyMap[r.CardCode].orderCount.add(r.DocEntry);
            partyMap[r.CardCode].itemCount++;
            partyMap[r.CardCode].totalRequiredQty += Number(r.ReqQty);
        }
        const parties = Object.values(partyMap).map(p => ({
            ...p, orderCount: p.orderCount.size,
        }));

        // Check for existing active session
        const existing = await svc.resumeSession(headerId);

        res.json({
            success: true,
            data: {
                headerId,
                countofOrder,
                joinOrder,
                parties,
                totalParties:      parties.length,
                totalItems:        rows.length,
                existingSessionId: existing?.SessionID || null,
            },
        });
    } catch (err) { next(err); }
}

async function startSession(req, res, next) {
    try {
        const { headerId, operatorId, stationId } = req.body;
        if (!headerId) return res.status(400).json({ success: false, message: 'headerId required' });
        const session = await svc.startSession(
            headerId,
            operatorId ? parseInt(operatorId) : null,
            stationId  || 'STN-01',
        );
        res.json({ success: true, data: session });
    } catch (err) { next(err); }
}

async function getSession(req, res, next) {
    try {
        const session = await svc.getSession(parseInt(req.params.sessionId));
        res.json({ success: true, data: session });
    } catch (err) { next(err); }
}

async function processScan(req, res, next) {
    try {
        const { barcode, cardCode } = req.body;
        if (!barcode || !cardCode)
            return res.status(400).json({ success: false, message: 'barcode and cardCode required' });
        const result = await svc.processScan(parseInt(req.params.sessionId), barcode, cardCode);
        res.json({ success: true, data: result });
    } catch (err) { next(err); }
}

async function resumeSession(req, res, next) {
    try {
        const existing = await svc.resumeSession(req.params.headerId);
        if (!existing)
            return res.status(404).json({ success: false, message: 'No active session', code: 'NO_SESSION' });
        const session = await svc.getSession(existing.SessionID);
        res.json({ success: true, data: session });
    } catch (err) { next(err); }
}

module.exports = { loadPicklist, startSession, getSession, processScan, resumeSession };
