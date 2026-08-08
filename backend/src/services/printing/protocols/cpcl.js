'use strict';

// CPCL — used by Honeywell/Zebra mobile & some SATO label printers.
const { mmToDots, escapeText } = require('./_util');

function render(labelSpec) {
    const { widthMm, heightMm, dpi, fields = [], qrData, table = [] } = labelSpec;
    const widthDots  = mmToDots(widthMm, dpi);
    const heightDots = mmToDots(heightMm, dpi);

    const lines = [`! 0 200 200 ${heightDots} 1`, `PW ${widthDots}`];

    let y = 20;
    const lineHeight = Math.round(dpi / 7);
    for (const f of fields) {
        lines.push(`TEXT 4 0 20 ${y} ${escapeText(f.label)}: ${escapeText(f.value)}`);
        y += lineHeight;
    }
    for (const row of table) {
        lines.push(`TEXT 4 0 20 ${y} ${escapeText(row)}`);
        y += Math.round(lineHeight * 0.85);
    }
    if (qrData) {
        lines.push(`BARCODE QR ${widthDots - Math.round(dpi * 0.9)} 20 M 2 U 4`);
        lines.push(`MA,${escapeText(qrData)}`);
        lines.push('ENDQR');
    }
    lines.push('FORM');
    lines.push('PRINT');

    return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

module.exports = { render };
