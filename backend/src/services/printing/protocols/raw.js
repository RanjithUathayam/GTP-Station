'use strict';

// Generic RAW/plain-text fallback for any TCP/IP printer that doesn't speak
// one of the specific label languages — no command syntax, just readable text.
const { escapeText } = require('./_util');

function render(labelSpec) {
    const { fields = [], qrData, table = [] } = labelSpec;
    const lines = [];

    for (const f of fields) {
        lines.push(`${escapeText(f.label)}: ${escapeText(f.value)}`);
    }
    for (const row of table) {
        lines.push(escapeText(row));
    }
    if (qrData) {
        lines.push(`QR: ${escapeText(qrData)}`);
    }
    lines.push('', '');

    return Buffer.from(lines.join('\r\n'), 'utf8');
}

module.exports = { render };
