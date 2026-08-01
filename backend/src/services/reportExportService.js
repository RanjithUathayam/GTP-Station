const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const { formatDuration } = require('../utils/duration');

// ── Shared column definitions — single source of truth for CSV/Excel/PDF ────
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad2 = n => String(n).padStart(2, '0');

function formatDateLabel(dateStr) {
    if (!dateStr) return '';
    const [y, m, d] = dateStr.split('-').map(Number);
    return `${pad2(d)}-${MONTHS[m - 1]}-${y}`;
}

function formatDateTimeLabel(iso) {
    if (!iso) return '-';
    const d = new Date(iso);
    return `${pad2(d.getDate())}-${MONTHS[d.getMonth()]}-${d.getFullYear()} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

const COLUMNS = [
    { key: 'reportDate',                     header: 'Report Date',               format: formatDateLabel },
    { key: 'gtpStation',                     header: 'GTP Station',                format: v => v || '' },
    { key: 'totalPicklists',                 header: 'Picklists Processed',        format: v => v },
    { key: 'totalOrders',                    header: 'Orders Processed',           format: v => v },
    { key: 'totalItemsPicked',               header: 'Items Picked',               format: v => v },
    { key: 'totalPickedQty',                 header: 'Picked Quantity',            format: v => v },
    { key: 'completedPicklists',             header: 'Completed Picklists',        format: v => v },
    { key: 'pendingPicklists',                header: 'Pending Picklists',          format: v => v },
    { key: 'abandonedPicklists',             header: 'Abandoned Picklists',        format: v => v },
    { key: 'processingStartTime',            header: 'Processing Start Time',      format: formatDateTimeLabel },
    { key: 'processingEndTime',              header: 'Processing End Time',        format: formatDateTimeLabel },
    { key: 'totalProcessingDurationSeconds', header: 'Total Processing Duration',  format: formatDuration },
    { key: 'avgPickingTimeSeconds',          header: 'Avg Picking Time/Picklist',  format: v => v == null ? '-' : formatDuration(v) },
    { key: 'operatorNames',                  header: 'Operator / User',            format: v => v || '-' },
];

const SUMMARY_LABELS = [
    ['totalStations',      'Total Stations'],
    ['totalPicklists',     'Total Picklists'],
    ['totalOrders',        'Total Orders'],
    ['totalItemsPicked',   'Total Items Picked'],
    ['totalPickedQty',     'Total Picked Quantity'],
    ['completedPicklists', 'Total Completed Picklists'],
    ['pendingPicklists',   'Total Pending Picklists'],
    ['abandonedPicklists', 'Total Abandoned Picklists'],
];

// Fixed cell values for the grand-total row, in COLUMNS order — kept separate from the
// per-row `format` functions so blank/duration columns render as '' instead of "00:00:00".
function buildGrandTotalCells(summary) {
    return [
        'GRAND TOTAL', '',
        summary.totalPicklists, summary.totalOrders, summary.totalItemsPicked, summary.totalPickedQty,
        summary.completedPicklists, summary.pendingPicklists, summary.abandonedPicklists,
        '', '', '', '', '',
    ];
}

function buildFilename(filters, format) {
    const from = (filters.fromDate || '').replace(/-/g, '');
    const to = (filters.toDate || '').replace(/-/g, '');
    const station = filters.stationId || 'ALL';
    const now = new Date();
    const stamp = `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
    return `picking-report_${from}-${to}_${station}_${stamp}.${format}`;
}

// ── CSV (hand-rolled, no dependency) ────────────────────────────────────────
function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function streamCsv(res, rows, summary) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.write(COLUMNS.map(c => csvCell(c.header)).join(',') + '\r\n');
    for (const row of rows) {
        res.write(COLUMNS.map(c => csvCell(c.format(row[c.key]))).join(',') + '\r\n');
    }
    res.write(buildGrandTotalCells(summary).map(csvCell).join(',') + '\r\n');
    res.end();
}

// ── Excel (exceljs streaming writer) ────────────────────────────────────────
async function streamExcel(res, rows, summary, meta) {
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');

    const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res });
    const sheet = workbook.addWorksheet('Picking Report');
    sheet.columns = COLUMNS.map(() => ({ width: 20 }));

    const titleRow = sheet.addRow([`GTP Picking Report  (${meta.fromDate} to ${meta.toDate})`]);
    titleRow.font = { bold: true, size: 14 };
    sheet.addRow([`Station: ${meta.stationLabel}    Picklist: ${meta.headerId}    Operator: ${meta.operatorLabel}`]);
    sheet.addRow([]);

    sheet.addRow(['Summary']).font = { bold: true };
    for (const [key, label] of SUMMARY_LABELS) sheet.addRow([label, summary[key]]);
    sheet.addRow([]);

    const headerRow = sheet.addRow(COLUMNS.map(c => c.header));
    headerRow.font = { bold: true };
    headerRow.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDDDDD' } }; });

    for (const row of rows) sheet.addRow(COLUMNS.map(c => c.format(row[c.key])));

    const totalRow = sheet.addRow(buildGrandTotalCells(summary));
    totalRow.font = { bold: true };
    totalRow.eachCell(cell => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF0F0F0' } }; });

    sheet.commit();
    await workbook.commit();
}

// ── PDF (pdfkit, hand-rolled table layout) ──────────────────────────────────
const COLUMN_WEIGHTS = [70, 60, 50, 55, 55, 60, 60, 55, 60, 80, 80, 65, 65, 90];

function streamPdf(res, rows, summary, meta) {
    res.setHeader('Content-Type', 'application/pdf');

    const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 30 });
    doc.pipe(res);

    doc.font('Helvetica-Bold').fontSize(14).text('GTP Picking Report');
    doc.moveDown(0.3);
    doc.font('Helvetica').fontSize(9)
        .text(`Date Range: ${meta.fromDate} to ${meta.toDate}    Station: ${meta.stationLabel}    Picklist: ${meta.headerId}    Operator: ${meta.operatorLabel}`);
    doc.moveDown(0.5);

    doc.font('Helvetica-Bold').fontSize(10).text('Summary');
    doc.font('Helvetica').fontSize(9)
        .text(SUMMARY_LABELS.map(([key, label]) => `${label}: ${summary[key]}`).join('    |    '),
            { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
    doc.moveDown(0.8);

    const startX = doc.page.margins.left;
    const usableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const totalWeight = COLUMN_WEIGHTS.reduce((a, b) => a + b, 0);
    const colWidths = COLUMN_WEIGHTS.map(w => (w / totalWeight) * usableWidth);
    const rowHeight = 16;
    const bottomLimit = doc.page.height - doc.page.margins.bottom;

    let y = doc.y;

    function drawRow(cells, { bold = false, shade = null } = {}) {
        if (shade) doc.rect(startX, y, usableWidth, rowHeight).fill(shade);
        doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(7).fillColor('#000');
        let x = startX;
        cells.forEach((val, i) => {
            doc.text(val == null ? '' : String(val), x, y, { width: colWidths[i], height: rowHeight, ellipsis: true });
            x += colWidths[i];
        });
    }

    function drawHeaderRow() {
        drawRow(COLUMNS.map(c => c.header), { bold: true });
        doc.moveTo(startX, y + rowHeight).lineTo(startX + usableWidth, y + rowHeight).strokeColor('#999').stroke();
        y += rowHeight;
    }

    function ensureSpace(neededRows = 1) {
        if (y + rowHeight * neededRows > bottomLimit) {
            doc.addPage();
            y = doc.page.margins.top;
            drawHeaderRow();
        }
    }

    drawHeaderRow();
    rows.forEach((row, idx) => {
        ensureSpace(1);
        drawRow(COLUMNS.map(c => c.format(row[c.key])), { shade: idx % 2 === 1 ? '#f7f7f7' : null });
        y += rowHeight;
    });

    ensureSpace(2); // grand-total row + a little buffer so it's never orphaned alone on a fresh page
    drawRow(buildGrandTotalCells(summary), { bold: true, shade: '#eeeeee' });
    y += rowHeight;

    doc.end();
}

module.exports = { streamCsv, streamExcel, streamPdf, buildFilename };
