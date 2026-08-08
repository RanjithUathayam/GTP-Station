'use strict';

// Raw TCP transport — reuses the exact net.Socket + timeout pattern already
// proven in Adam6052Service.js's _testTcpPort, extended to also write a
// buffer and give the printer a moment to accept it before closing.
const net = require('net');

function checkPort(ip, port, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done   = false;
        const fin  = (v) => { if (!done) { done = true; sock.destroy(); resolve(v); } };
        sock.setTimeout(timeoutMs);
        sock.on('connect', () => fin(true));
        sock.on('timeout', () => fin(false));
        sock.on('error',   () => fin(false));
        sock.connect(port, ip);
    });
}

function sendRaw(ip, port, buffer, timeoutMs = 3000) {
    return new Promise((resolve) => {
        const sock = new net.Socket();
        let done   = false;
        const finish = (result) => {
            if (done) return;
            done = true;
            sock.destroy();
            resolve(result);
        };

        sock.setTimeout(timeoutMs);
        sock.on('timeout', () => finish({ success: false, error: 'Connection timed out' }));
        sock.on('error',   (err) => finish({ success: false, error: err.message }));

        sock.connect(port, ip, () => {
            sock.write(buffer, (err) => {
                if (err) return finish({ success: false, error: err.message });
                // Give the printer a brief moment to accept the bytes before we
                // close the socket — most label printers don't send an ack.
                setTimeout(() => finish({ success: true }), 150);
            });
        });
    });
}

function sendWindowsDriver() {
    throw Object.assign(
        new Error('Windows Print Driver protocol is not implemented yet — use a TCP/IP label language instead'),
        { code: 'NOT_IMPLEMENTED' },
    );
}

module.exports = { checkPort, sendRaw, sendWindowsDriver };
