'use strict';

const ModbusRTU    = require('modbus-serial');
const EventEmitter = require('events');
const net          = require('net');
const { exec }     = require('child_process');
const logger       = require('../utils/logger');

// ─── Config (env defaults — used when a device is built with no overrides) ────
const ENV_ADAM_IP      = (process.env.ADAM_IP      || '10.0.210.87').trim();
const ENV_ADAM_PORT    = parseInt((process.env.ADAM_PORT    || '502').trim(),  10);
const ENV_ADAM_UNIT_ID = parseInt((process.env.ADAM_UNIT_ID || '1').trim(),   10);
const ENV_POLL_MS      = parseInt((process.env.ADAM_POLL_MS || '1000').trim(), 10);
const ENV_TIMEOUT_MS   = parseInt((process.env.ADAM_TIMEOUT || '5000').trim(), 10);

const RECONNECT_BASE = 2000;
const RECONNECT_MAX  = 60000;

// ─── ADAM-6052 Modbus Register Map ────────────────────────────────────────────
//   DI (Discrete Inputs):  FC02  addresses 0x0000–0x000B  (12 channels)
//   DO (Coils):            FC01  addresses 0x0010–0x0017  (8 channels)
//   Write single DO:       FC05  writeCoil(0x0010 + ch, true/false)
//   Write all DO:          FC15  writeCoils(0x0010, [bool×8])
const DI_START = 0x0000;
const DI_COUNT = 12;
const DO_START = 0x0010;
const DO_COUNT = 8;

class Adam6052Service extends EventEmitter {
  constructor(options = {}) {
    super();
    this.ip        = String(options.ip || ENV_ADAM_IP).trim();
    this.port      = parseInt(options.port      ?? ENV_ADAM_PORT,    10);
    this.unitId    = parseInt(options.unitId    ?? ENV_ADAM_UNIT_ID, 10);
    this.pollMs    = parseInt(options.pollMs    ?? ENV_POLL_MS,      10);
    this.timeoutMs = parseInt(options.timeoutMs ?? ENV_TIMEOUT_MS,   10);

    this._client         = new ModbusRTU();
    this._client.setTimeout(this.timeoutMs);

    this._connected      = false;
    this._destroyed      = false;
    this._busy           = false;   // shared lock: poll + writes both use this
    this._reconnAttempts = 0;
    this._reconnTimer    = null;
    this._pollTimer      = null;
    this._lastError      = null;
    this._lastStatus     = this._emptyStatus();
  }

  // ─── Mutex for Modbus operations ─────────────────────────────────────────────
  // Modbus TCP is serial — only one request at a time on a single client.
  // Both _poll() and writeSingleOutput() share the _busy flag as a mutex.
  async _withLock(fn) {
    const deadline = Date.now() + this.timeoutMs;
    while (this._busy) {
      if (Date.now() > deadline) {
        logger.warn('[ADAM] Lock wait timeout — forcing proceed');
        break;
      }
      await new Promise(r => setTimeout(r, 25));
    }
    this._busy = true;
    try {
      return await fn();
    } finally {
      this._busy = false;
    }
  }

  _emptyStatus() {
    return {
      connected:         false,
      ts:                null,
      di:                Array(DI_COUNT).fill(false),
      do:                Array(DO_COUNT).fill(false),
      diCount:           DI_COUNT,
      doCount:           DO_COUNT,
      ip:                this.ip,
      port:              this.port,
      unitId:            this.unitId,
      reconnectAttempts: 0,
      error:             null,
    };
  }

  get isConnected()       { return this._connected; }
  get reconnectAttempts() { return this._reconnAttempts; }
  get lastError()         { return this._lastError; }

  // ─── Public startup ─────────────────────────────────────────────────────────

  async start() {
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.info('[ADAM] Starting Modbus TCP service');
    logger.info(`[ADAM]   IP:      ${this.ip}`);
    logger.info(`[ADAM]   Port:    ${this.port}  (Modbus TCP)`);
    logger.info(`[ADAM]   Unit ID: ${this.unitId}`);
    logger.info(`[ADAM]   Poll:    every ${this.pollMs} ms`);
    logger.info(`[ADAM]   Timeout: ${this.timeoutMs} ms`);
    logger.info(`[ADAM]   DI:      ${DI_COUNT} channels  (FC02 addr 0x${DI_START.toString(16).toUpperCase().padStart(4,'0')})`);
    logger.info(`[ADAM]   DO:      ${DO_COUNT} channels  (FC01/05/15 addr 0x${DO_START.toString(16).toUpperCase().padStart(4,'0')})`);

    const tcpOpen = await this._testTcpPort(this.ip, this.port, 3000);
    if (tcpOpen) {
      logger.info(`[ADAM] ✅ Port ${this.port} open — initiating Modbus TCP connection`);
    } else {
      logger.warn(`[ADAM] ⚠  Port ${this.port} not responding at startup`);
      logger.warn('[ADAM]    Will connect with exponential backoff (2 s → 4 s → … → 60 s)');
      logger.warn(`[ADAM]    Windows test: Test-NetConnection ${this.ip} -Port ${this.port}`);
    }
    logger.info('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    this._connect();
  }

  // ─── Connection ─────────────────────────────────────────────────────────────

  async _connect() {
    if (this._destroyed) return;

    clearTimeout(this._reconnTimer);
    this._reconnTimer = null;

    logger.info(`[ADAM] Connecting → ${this.ip}:${this.port} (attempt #${this._reconnAttempts + 1})`);

    try {
      if (this._client.isOpen) {
        try { await this._client.close(); } catch (_) {}
      }

      await this._client.connectTCP(this.ip, { port: this.port });
      this._client.setID(this.unitId);

      this._connected      = true;
      this._reconnAttempts = 0;
      this._lastError      = null;

      logger.info(`[ADAM] ✅ Modbus TCP connected — ${this.ip}:${this.port}  unit ${this.unitId}`);
      this.emit('connected');
      this._startPolling();
    } catch (err) {
      this._connected  = false;
      this._lastError  = err.message;
      this._lastStatus = {
        ...this._lastStatus,
        connected: false,
        error:     err.message,
        ts:        new Date().toISOString(),
      };
      this._logConnectError(err);
      this.emit('status', this._lastStatus);   // tell Angular the connection failed
      this._scheduleReconnect();
    }
  }

  _logConnectError(err) {
    const code = String(err.errno || err.code || '');
    if (code === 'ECONNREFUSED' || code === '-4078') {
      logger.error(`[ADAM] ❌ ECONNREFUSED  ${this.ip}:${this.port}`);
      logger.error('[ADAM]    Modbus TCP server is not listening on this port.');
      logger.error(`[ADAM]    Check: Test-NetConnection ${this.ip} -Port ${this.port}`);
    } else if (code === 'ETIMEDOUT' || code === '-4039') {
      logger.error(`[ADAM] ❌ ETIMEDOUT  ${this.ip}:${this.port}`);
      logger.error('[ADAM]    No response — verify IP, subnet, cable, power.');
    } else {
      logger.error(`[ADAM] ❌ Connect error [${code}]: ${err.message}`);
    }
  }

  _scheduleReconnect() {
    if (this._destroyed) return;
    this._reconnAttempts++;
    // Keep Angular informed of each retry attempt
    this._lastStatus = {
      ...this._lastStatus,
      connected:         false,
      reconnectAttempts: this._reconnAttempts,
      ts:                new Date().toISOString(),
    };
    this.emit('status', this._lastStatus);
    const exponent = Math.min(this._reconnAttempts - 1, 5);
    const base     = RECONNECT_BASE * Math.pow(2, exponent);
    const jitter   = Math.floor(Math.random() * 1000);
    const delay    = Math.min(base + jitter, RECONNECT_MAX);
    logger.warn(`[ADAM] Reconnect #${this._reconnAttempts} in ${Math.round(delay / 1000)} s`);
    this._reconnTimer = setTimeout(() => this._connect(), delay);
  }

  destroy() {
    this._destroyed = true;
    clearTimeout(this._reconnTimer);
    this._stopPolling();
    if (this._client.isOpen) {
      this._client.close().catch(() => {});
    }
    this._connected = false;
    logger.info('[ADAM] Service destroyed');
  }

  // ─── Polling ─────────────────────────────────────────────────────────────────

  _startPolling() {
    this._stopPolling();
    this._poll();
    this._pollTimer = setInterval(() => this._poll(), this.pollMs);
  }

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  async _poll() {
    if (!this._connected || this._busy) return;   // skip if write holding the lock
    try {
      await this._withLock(async () => {
        const diResp = await this._client.readDiscreteInputs(DI_START, DI_COUNT);
        const doResp = await this._client.readCoils(DO_START, DO_COUNT);
        const status = {
          connected: true,
          ts:        new Date().toISOString(),
          di:        Array.from(diResp.data.slice(0, DI_COUNT)),
          do:        Array.from(doResp.data.slice(0, DO_COUNT)),
          diCount:   DI_COUNT,
          doCount:   DO_COUNT,
          ip:        this.ip,
          port:      this.port,
          unitId:    this.unitId,
          error:     null,
        };
        this._lastStatus = status;
        this.emit('status', status);
      });
    } catch (err) {
      logger.error(`[ADAM] Poll error: ${err.message}`);
      this._connected  = false;
      this._busy       = false;   // ensure lock released on poll failure
      this._lastError  = err.message;
      this._lastStatus = { ...this._lastStatus, connected: false, error: err.message };
      this.emit('status', this._lastStatus);
      this._stopPolling();
      try { if (this._client.isOpen) await this._client.close(); } catch (_) {}
      this._scheduleReconnect();
    }
  }

  // ─── Read operations ─────────────────────────────────────────────────────────

  /** Synchronous — returns polling cache. Never triggers a Modbus request. */
  getStatus() {
    return { ...this._lastStatus };
  }

  /** Live FC02 read — 12 DI channels */
  async readInputs() {
    this._assertConnected();
    const resp = await this._client.readDiscreteInputs(DI_START, DI_COUNT);
    return {
      channels:  Array.from(resp.data.slice(0, DI_COUNT)),
      count:     DI_COUNT,
      startAddr: `0x${DI_START.toString(16).toUpperCase().padStart(4,'0')}`,
      fc:        'FC02',
      ts:        new Date().toISOString(),
    };
  }

  /** Live FC01 read — 8 DO channels */
  async readOutputs() {
    this._assertConnected();
    const resp = await this._client.readCoils(DO_START, DO_COUNT);
    return {
      channels:  Array.from(resp.data.slice(0, DO_COUNT)),
      count:     DO_COUNT,
      startAddr: `0x${DO_START.toString(16).toUpperCase().padStart(4,'0')}`,
      fc:        'FC01',
      ts:        new Date().toISOString(),
    };
  }

  // ─── Write operations ─────────────────────────────────────────────────────────

  /** FC05 — write single DO channel (0–7). Serialised through _withLock(). */
  async writeSingleOutput(channel, state) {
    this._assertConnected();
    if (channel < 0 || channel >= DO_COUNT) {
      throw new RangeError(`Channel ${channel} out of range 0–${DO_COUNT - 1}`);
    }
    return this._withLock(async () => {
      this._assertConnected();   // re-check after waiting for lock
      const address = DO_START + channel;
      const value   = Boolean(state);
      logger.info(`[ADAM] FC05  ch${channel} → ${value ? 'ON ' : 'OFF'}  (addr 0x${address.toString(16).toUpperCase().padStart(4,'0')})`);
      await this._client.writeCoil(address, value);
      if (this._lastStatus.do) {
        this._lastStatus.do[channel] = value;
        this._lastStatus.ts = new Date().toISOString();
      }
      return {
        channel,
        state:   value,
        address: `0x${address.toString(16).toUpperCase().padStart(4,'0')}`,
        fc:      'FC05',
        ts:      new Date().toISOString(),
      };
    });
  }

  /** FC15 — write all 8 DO channels from bitmask (0–255). Serialised through _withLock(). */
  async writeAllOutputs(value) {
    this._assertConnected();
    return this._withLock(async () => {
      this._assertConnected();
      const mask   = (value >>> 0) & 0xFF;
      const states = Array.from({ length: DO_COUNT }, (_, i) => Boolean(mask & (1 << i)));
      logger.info(`[ADAM] FC15  all DO → 0x${mask.toString(16).toUpperCase().padStart(2,'0')}  [${states.map(v => v ? '1' : '0').join(' ')}]`);
      await this._client.writeCoils(DO_START, states);
      if (this._lastStatus.do) {
        this._lastStatus.do = [...states];
        this._lastStatus.ts = new Date().toISOString();
      }
      return {
        value:  mask,
        hex:    `0x${mask.toString(16).toUpperCase().padStart(2,'0')}`,
        states,
        fc:     'FC15',
        ts:     new Date().toISOString(),
      };
    });
  }

  _assertConnected() {
    if (!this._connected) {
      throw Object.assign(
        new Error('ADAM device not connected — Modbus TCP offline'),
        { code: 'ADAM_NOT_CONNECTED', reconnectAttempts: this._reconnAttempts }
      );
    }
  }

  // ─── Network diagnostics ─────────────────────────────────────────────────────

  async checkConnection() {
    const result = {
      ip:        this.ip,
      port:      this.port,
      unitId:    this.unitId,
      protocol:  'Modbus TCP',
      reachable: false,
      tcpOpen:   false,
      pingMs:    null,
      tcpMs:     null,
      hints:     [],
    };

    const t0         = Date.now();
    result.reachable = await this._ping(this.ip);
    result.pingMs    = Date.now() - t0;

    const t1         = Date.now();
    result.tcpOpen   = await this._testTcpPort(this.ip, this.port, 3000);
    result.tcpMs     = Date.now() - t1;

    if (!result.reachable) {
      result.hints.push('Device not responding to ping — check IP, cable, power');
    }
    if (result.reachable && !result.tcpOpen) {
      result.hints.push(`Port ${this.port} closed — Modbus TCP not enabled on device`);
      result.hints.push('In ADAM Utility: set Protocol = Modbus TCP, enable TCP Server');
    }
    if (result.tcpOpen) {
      result.hints.push('Modbus TCP port is open — device ready');
    }

    return result;
  }

  _ping(ip, timeoutMs = 3000) {
    return new Promise((resolve) => {
      const isWin = process.platform === 'win32';
      const cmd   = isWin
        ? `ping -n 1 -w ${timeoutMs} ${ip}`
        : `ping -c 1 -W ${Math.ceil(timeoutMs / 1000)} ${ip}`;
      exec(cmd, { timeout: timeoutMs + 1000 }, (err, stdout) => {
        if (err) return resolve(false);
        resolve(isWin ? /TTL=/i.test(stdout) : /time=/i.test(stdout));
      });
    });
  }

  _testTcpPort(ip, port, timeoutMs = 3000) {
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
}

module.exports = Adam6052Service;
