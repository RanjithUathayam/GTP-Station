'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/printerController');

router.get('/',                        ctrl.listAll);
router.post('/',                       ctrl.create);
router.put('/:id',                     ctrl.update);
router.delete('/:id',                  ctrl.remove);
router.get('/:deviceCode/status',      ctrl.getStatus);
router.post('/:deviceCode/test-print', ctrl.testPrint);
router.get('/:deviceCode/logs',        ctrl.getLogs);

module.exports = router;
