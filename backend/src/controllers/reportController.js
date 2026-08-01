const svc = require('../services/reportService');
const exportSvc = require('../services/reportExportService');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseFilters(req) {
    const { fromDate, toDate, stationId, headerId, operatorId } = req.query;

    if (!fromDate || !DATE_RE.test(fromDate)) throw Object.assign(
        new Error('fromDate is required (format: YYYY-MM-DD)'), { status: 400 }
    );
    if (!toDate || !DATE_RE.test(toDate)) throw Object.assign(
        new Error('toDate is required (format: YYYY-MM-DD)'), { status: 400 }
    );
    if (fromDate > toDate) throw Object.assign(
        new Error('fromDate must be on or before toDate'), { status: 400 }
    );

    const station = stationId && stationId !== 'ALL' ? stationId : null;
    const header = headerId && headerId.trim() ? headerId.trim() : null;
    const operator = operatorId != null && operatorId !== '' ? parseInt(operatorId, 10) : null;
    if (operator != null && Number.isNaN(operator)) throw Object.assign(
        new Error('operatorId must be numeric'), { status: 400 }
    );

    return { fromDate, toDate, stationId: station, headerId: header, operatorId: operator };
}

async function getPickingReport(req, res, next) {
    try {
        const filters = parseFilters(req);
        const rows = await svc.getPickingReport(filters);
        const summary = svc.computeSummary(rows);
        res.json({ success: true, data: { rows, summary } });
    } catch (err) { next(err); }
}

async function exportPickingReport(req, res, next) {
    try {
        const filters = parseFilters(req);
        const format = req.query.format;
        if (!['csv', 'xlsx', 'pdf'].includes(format)) throw Object.assign(
            new Error('format must be one of: csv, xlsx, pdf'), { status: 400 }
        );

        const rows = await svc.getPickingReport(filters);
        const summary = svc.computeSummary(rows);
        const meta = {
            fromDate:       filters.fromDate,
            toDate:         filters.toDate,
            stationLabel:   filters.stationId || 'All Stations',
            headerId:       filters.headerId  || 'All',
            operatorLabel:  filters.operatorId != null ? `#${filters.operatorId}` : 'All Operators',
        };
        const filename = exportSvc.buildFilename(filters, format);
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

        if (format === 'csv')       return exportSvc.streamCsv(res, rows, summary);
        if (format === 'xlsx')      return await exportSvc.streamExcel(res, rows, summary, meta);
        /* format === 'pdf' */      return exportSvc.streamPdf(res, rows, summary, meta);
    } catch (err) { next(err); }
}

async function getStationFilters(req, res, next) {
    try {
        const stations = await svc.getFilterStations();
        res.json({ success: true, data: stations });
    } catch (err) { next(err); }
}

async function getOperatorFilters(req, res, next) {
    try {
        const operators = await svc.getFilterOperators();
        res.json({ success: true, data: operators });
    } catch (err) { next(err); }
}

module.exports = { getPickingReport, exportPickingReport, getStationFilters, getOperatorFilters };
