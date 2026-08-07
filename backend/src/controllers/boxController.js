const svc = require('../services/boxManagementService');

// ── Box Types + capacity matrix (single source of truth for box capacity) ──
async function listBoxTypes(req, res, next) {
    try {
        const data = await svc.listBoxTypes();
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function upsertBoxType(req, res, next) {
    try {
        const { label, sizeLWH } = req.body;
        const data = await svc.upsertBoxType(label, sizeLWH);
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function deleteBoxType(req, res, next) {
    try {
        const data = await svc.deleteBoxType(parseInt(req.params.boxTypeId));
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function getBoxTypeMatrix(req, res, next) {
    try {
        const data = await svc.getBoxTypeMatrix();
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function upsertBoxTypeCapacity(req, res, next) {
    try {
        const { itemGroupName, capacity } = req.body;
        const data = await svc.upsertBoxTypeCapacity(parseInt(req.params.boxTypeId), itemGroupName, capacity);
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function deleteBoxTypeCapacity(req, res, next) {
    try {
        const data = await svc.deleteBoxTypeCapacity(parseInt(req.params.boxTypeId), req.params.itemGroupName);
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

// ── Box lifecycle ────────────────────────────────────────────────
async function completeBox(req, res, next) {
    try {
        const { operatorId } = req.body;
        const box = await svc.completeBoxManually(
            parseInt(req.params.boxId),
            operatorId ? parseInt(operatorId) : null,
        );
        res.json({ success: true, data: box });
    } catch (err) { next(err); }
}

async function getBoxIdLabel(req, res, next) {
    try {
        const data = await svc.getBoxIdentificationLabelData(parseInt(req.params.boxId));
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function getBoxContentsByNumber(req, res, next) {
    try {
        const data = await svc.getBoxContentsLabelData(req.params.boxNumber);
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

async function getSessionBoxes(req, res, next) {
    try {
        const data = await svc.getBoxesForSession(parseInt(req.params.sessionId));
        res.json({ success: true, data });
    } catch (err) { next(err); }
}

module.exports = {
    listBoxTypes, upsertBoxType, deleteBoxType,
    getBoxTypeMatrix, upsertBoxTypeCapacity, deleteBoxTypeCapacity,
    completeBox, getBoxIdLabel, getBoxContentsByNumber, getSessionBoxes,
};
