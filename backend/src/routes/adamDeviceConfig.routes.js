'use strict';

const router = require('express').Router();
const ctrl   = require('../controllers/adamDeviceConfig.controller');

// Static-path routes must be registered before '/:deviceCode' so they aren't
// swallowed by the param route.
router.get('/detect-mac', ctrl.detectMac);   // ARP-based MAC detection helper

router.get('/',                        ctrl.listAll);
router.get('/:deviceCode/status',      ctrl.getRuntimeStatus);   // config + live MAC/connected state
router.get('/:deviceCode',             ctrl.getByCode);
router.post('/',                       ctrl.create);
router.put('/:id',                     ctrl.update);
router.delete('/:id',                  ctrl.remove);

module.exports = router;
