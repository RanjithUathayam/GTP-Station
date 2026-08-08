'use strict';

const svc = require('../services/printerService');

async function listAll(req, res, next) {
    try {
        res.json({ success: true, data: await svc.listAll() });
    } catch (err) { next(err); }
}

async function create(req, res, next) {
    try {
        res.json({ success: true, data: await svc.create(req.body) });
    } catch (err) { next(err); }
}

async function update(req, res, next) {
    try {
        res.json({ success: true, data: await svc.update(parseInt(req.params.id, 10), req.body) });
    } catch (err) { next(err); }
}

async function remove(req, res, next) {
    try {
        await svc.remove(parseInt(req.params.id, 10));
        res.json({ success: true });
    } catch (err) { next(err); }
}

async function getStatus(req, res, next) {
    try {
        res.json({ success: true, data: await svc.checkStatus(req.params.deviceCode) });
    } catch (err) { next(err); }
}

async function testPrint(req, res, next) {
    try {
        res.json({ success: true, data: await svc.testPrint(req.params.deviceCode) });
    } catch (err) { next(err); }
}

async function getLogs(req, res, next) {
    try {
        res.json({ success: true, data: await svc.getLogs(req.params.deviceCode, req.query.limit) });
    } catch (err) { next(err); }
}

module.exports = { listAll, create, update, remove, getStatus, testPrint, getLogs };
