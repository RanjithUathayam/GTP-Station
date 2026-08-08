'use strict';

// Zebra Programming Language — used by Zebra + most Zebra-compatible printers
// (Godex/Citizen also ship ZPL emulation modes).
const { mmToDots, escapeText } = require('./_util');

function render(labelSpec) {
    const { widthMm, heightMm, dpi, fields = [], qrData, table = [] } = labelSpec;
    const widthDots  = mmToDots(widthMm, dpi);
    const heightDots = mmToDots(heightMm, dpi);

    const lines = ['^XA', `^PW${widthDots}`, `^LL${heightDots}`, '^CI28'];

    let y = 20;
    const lineHeight = Math.round(dpi / 7); // ~28 dots @203dpi
    for (const f of fields) {
        lines.push(`^FO20,${y}^A0N,${Math.round(lineHeight * 0.85)},${Math.round(lineHeight * 0.85)}^FD${escapeText(f.label)}: ${escapeText(f.value)}^FS`);
        y += lineHeight;
    }
    for (const row of table) {
        lines.push(`^FO20,${y}^A0N,${Math.round(lineHeight * 0.75)},${Math.round(lineHeight * 0.75)}^FD${escapeText(row)}^FS`);
        y += Math.round(lineHeight * 0.85);
    }
    if (qrData) {
        lines.push(`^FO${widthDots - Math.round(dpi * 0.9)},20^BQN,2,4^FDMA,${escapeText(qrData)}^FS`);
    }
    lines.push('^XZ');

    return Buffer.from(lines.join('\n'), 'utf8');
}

module.exports = { render };
