'use strict';

const isDev = process.env.NODE_ENV !== 'production';

const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const current = isDev ? 3 : 2;

const ts = () => new Date().toISOString();

const logger = {
  error: (...a) => current >= 0 && console.error(`[${ts()}] ERROR`, ...a),
  warn:  (...a) => current >= 1 && console.warn (`[${ts()}] WARN `, ...a),
  info:  (...a) => current >= 2 && console.info (`[${ts()}] INFO `, ...a),
  debug: (...a) => current >= 3 && console.debug(`[${ts()}] DEBUG`, ...a),
};

module.exports = logger;
