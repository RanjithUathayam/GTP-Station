const router      = require('express').Router();
const ctrl        = require('../controllers/gtpPickingController');
const delivCtrl   = require('../controllers/deliveryController');
const statusCtrl  = require('../controllers/picklistStatusController');

router.get('/picklist/:headerId',                               ctrl.loadPicklist);
router.get('/picklist/:headerId/resume',                        ctrl.resumeSession);
router.post('/session/start',                                   ctrl.startSession);
router.get('/session/:sessionId',                               ctrl.getSession);
router.post('/session/:sessionId/scan',                         ctrl.processScan);

// Delivery log + retry
router.get('/session/:sessionId/deliveries',                    delivCtrl.getDeliveries);
router.post('/session/:sessionId/deliveries/:cardCode/retry',   delivCtrl.retryDelivery);

// Delivery Status overview (formerly "Pick Status")
router.get('/sessions',                                         statusCtrl.getSessions);

module.exports = router;
