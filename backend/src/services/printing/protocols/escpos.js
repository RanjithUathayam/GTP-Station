'use strict';

// ESC/POS — Epson's language, also used by many Brother/Citizen thermal models.
const { escapeText } = require('./_util');

const ESC = 0x1b;
const GS  = 0x1d;

function qrCommands(data) {
    const bytes = [];
    const payload = Buffer.from(String(data), 'utf8');
    const storeLen = payload.length + 3;
    const pL = storeLen & 0xff;
    const pH = (storeLen >> 8) & 0xff;

    // Model 2, size 4, error-correction M, then store + print the data.
    bytes.push(GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00);       // select model
    bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, 0x04);             // module size
    bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31);             // error correction M
    bytes.push(GS, 0x28, 0x6b, pL, pH, 0x31, 0x50, 0x30, ...payload);     // store data
    bytes.push(GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30);             // print

    return Buffer.from(bytes);
}

function render(labelSpec) {
    const { fields = [], qrData, table = [] } = labelSpec;
    const parts = [Buffer.from([ESC, 0x40])]; // ESC @ — initialize

    for (const f of fields) {
        parts.push(Buffer.from(`${escapeText(f.label)}: ${escapeText(f.value)}\n`, 'utf8'));
    }
    for (const row of table) {
        parts.push(Buffer.from(`${escapeText(row)}\n`, 'utf8'));
    }
    if (qrData) {
        parts.push(Buffer.from('\n', 'utf8'));
        parts.push(qrCommands(qrData));
    }
    parts.push(Buffer.from([ESC, 0x64, 0x03])); // ESC d 3 — feed 3 lines

    return Buffer.concat(parts);
}

module.exports = { render };
