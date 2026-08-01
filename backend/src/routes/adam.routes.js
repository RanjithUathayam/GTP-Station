'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/adam.controller');

// ── Device selector ────────────────────────────────────────────────────────────
router.get('/devices', ctrl.listDevices);   // configured device codes, for the dropdown

// ── Status & diagnostics ──────────────────────────────────────────────────────
router.get('/status',     ctrl.getStatus);       // polling cache (sync)
router.get('/check',      ctrl.checkConnection); // ping + TCP port probe
router.get('/connection', ctrl.getConnection);   // runtime state

// ── Read ──────────────────────────────────────────────────────────────────────
router.get('/input',  ctrl.readInput);   // live FC02 — 12 DI channels
router.get('/output', ctrl.readOutput);  // live FC01 — 8 DO channels

// ── Write ─────────────────────────────────────────────────────────────────────
// POST /api/adam/output          { channel, state } | { value: 0-255 }
// POST /api/adam/output/all      { value: 0-255 }   | { hex: "FF" }
// POST /api/adam/output/:ch/on
// POST /api/adam/output/:ch/off
router.post('/output',               ctrl.writeOutput);
router.post('/output/all',           ctrl.setAll);
router.post('/output/:channel/on',   ctrl.channelOn);
router.post('/output/:channel/off',  ctrl.channelOff);

module.exports = router;
