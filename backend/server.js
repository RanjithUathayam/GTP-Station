if (typeof TextDecoder !== 'undefined') {
    const NativeTextDecoder = TextDecoder;
    const toBuffer = (input) => {
        if (Buffer.isBuffer(input)) return input;
        if (input instanceof ArrayBuffer) return Buffer.from(input);
        return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    };

    global.TextDecoder = class TextDecoder {
        constructor(encoding = 'utf-8', options) {
            this.encoding = encoding;
            try {
                this._native = new NativeTextDecoder(encoding, options);
            } catch (err) {
                if (err.code !== 'ERR_ENCODING_NOT_SUPPORTED') throw err;
                // pkg's bundled Node lacks ICU data for legacy single-byte encodings
                // (e.g. 'ascii'/'windows-1252') that fontkit needs when pdfkit loads.
                this._native = null;
            }
        }

        decode(input, options) {
            if (this._native) return this._native.decode(input, options);
            return toBuffer(input).toString('latin1');
        }
    };
}

if (!AbortSignal.any) {
    AbortSignal.any = function (signals) {
        const controller = new AbortController();

        function onAbort() {
            controller.abort();
            cleanup();
        }

        function cleanup() {
            for (const s of signals) {
                s.removeEventListener("abort", onAbort);
            }
        }

        for (const s of signals) {
            s.addEventListener("abort", onAbort);
        }

        if (signals.some(s => s.aborted)) {
            controller.abort();
        }

        return controller.signal;
    };
}
require('dotenv').config();
const http     = require('http');
const express  = require('express');
const cors     = require('cors');
const helmet   = require('helmet');
const morgan   = require('morgan');
const { Server } = require('socket.io');

const routes          = require('./src/routes');
const { initDb }      = require('./src/config/db');
const wsService       = require('./src/services/websocketService');
const adamDeviceManager = require('./src/services/adamDeviceManager');
const adamService     = adamDeviceManager.getLegacyDevice();
const adamSocket      = require('./src/socket/adam.socket');
const lightService    = require('./src/services/lightControlService');
const errorHandler    = require('./src/middleware/errorHandler');

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*', exposedHeaders: ['Content-Disposition'] }));
app.use(morgan('dev'));
app.use(express.json());

app.use('/api', routes);
app.use(errorHandler);

const PORT = process.env.PORT || 4501;

async function start() {
    try {
        await initDb();
        console.log('✅ Database connected');

        // Sync light DB state with ADAM hardware (all OFF on every startup)
        await lightService.resetAllLightStates();

        wsService.init(server);
        console.log('✅ WebSocket attached to HTTP server');

        adamSocket.init(io);
        await adamService.start();   // diagnostics + Modbus TCP connect (legacy debug dashboard device)
        console.log('✅ ADAM-6052 Modbus TCP service started');

        await adamDeviceManager.init();   // per-station devices from GTP_AdamDevices config
        console.log('✅ ADAM per-station device manager started');

        server.listen(PORT, () => {
            console.log(`🚀 GTP Station API  → http://localhost:${PORT}/api`);
            console.log(`🔌 WebSocket        → ws://localhost:${PORT}`);
            console.log(`📡 ADAM Socket.IO   → http://localhost:${PORT} (namespace /adam)`);
        });
    } catch (err) {
        console.error('❌ Startup failed:', err.message);
        process.exit(1);
    }
}

start();
