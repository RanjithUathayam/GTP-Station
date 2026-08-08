'use strict';

// TSPL/TSPL2 — TSC's language, also emulated by many Godex/Citizen printers.
const { escapeText } = require('./_util');

function render(labelSpec) {
    const { widthMm, heightMm, fields = [], qrData, table = [] } = labelSpec;

    const lines = [
        `SIZE ${widthMm} mm,${heightMm} mm`,
        'GAP 2 mm,0 mm',
        'DIRECTION 1',
        'CLS',
    ];

    let y = 20;
    const lineHeight = 30;
    for (const f of fields) {
        lines.push(`TEXT 20,${y},"3",0,1,1,"${escapeText(f.label)}: ${escapeText(f.value)}"`);
        y += lineHeight;
    }
    for (const row of table) {
        lines.push(`TEXT 20,${y},"2",0,1,1,"${escapeText(row)}"`);
        y += Math.round(lineHeight * 0.85);
    }
    if (qrData) {
        lines.push(`QRCODE 20,${y + 10},L,4,A,0,"${escapeText(qrData)}"`);
    }
    lines.push('PRINT 1,1');

    return Buffer.from(lines.join('\r\n') + '\r\n', 'utf8');
}

module.exports = { render };
