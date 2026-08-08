'use strict';

// Eltron/EPL2 — legacy Zebra language still used by some Godex/Citizen models.
const { mmToDots, escapeText } = require('./_util');

function render(labelSpec) {
    const { widthMm, heightMm, dpi, fields = [], qrData, table = [] } = labelSpec;
    const widthDots  = mmToDots(widthMm, dpi);
    const heightDots = mmToDots(heightMm, dpi);

    const lines = ['N', `q${widthDots}`, `Q${heightDots},24`];

    let y = 20;
    const lineHeight = Math.round(dpi / 7);
    for (const f of fields) {
        lines.push(`A20,${y},0,3,1,1,N,"${escapeText(f.label)}: ${escapeText(f.value)}"`);
        y += lineHeight;
    }
    for (const row of table) {
        lines.push(`A20,${y},0,2,1,1,N,"${escapeText(row)}"`);
        y += Math.round(lineHeight * 0.85);
    }
    if (qrData) {
        // EPL2 "b" barcode command with QR symbology (firmware-dependent syntax).
        lines.push(`b${widthDots - Math.round(dpi * 0.9)},20,Q,m2,${escapeText(qrData)}`);
    }
    lines.push('P1');

    return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

module.exports = { render };
