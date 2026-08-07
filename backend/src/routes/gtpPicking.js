const router      = require('express').Router();
const ctrl        = require('../controllers/gtpPickingController');
const delivCtrl   = require('../controllers/deliveryController');
const statusCtrl  = require('../controllers/picklistStatusController');
const boxCtrl     = require('../controllers/boxController');

router.get('/picklist/:headerId',                               ctrl.loadPicklist);
router.get('/picklist/:headerId/resume',                        ctrl.resumeSession);
router.post('/session/start',                                   ctrl.startSession);
router.get('/session/:sessionId',                               ctrl.getSession);
router.post('/session/:sessionId/scan',                         ctrl.processScan);

// Delivery log + retry (one SAP Delivery Note per Party + DocNumber)
router.get('/session/:sessionId/deliveries',                              delivCtrl.getDeliveries);
router.post('/session/:sessionId/deliveries/:cardCode/:docEntry/retry',   delivCtrl.retryDelivery);

// Delivery Status overview (formerly "Pick Status")
router.get('/sessions',                                         statusCtrl.getSessions);

// Box management (box completion, labels)
router.post('/box/:boxId/complete',                             boxCtrl.completeBox);
router.get('/box/:boxId/id-label',                              boxCtrl.getBoxIdLabel);
router.get('/box-lookup/:boxNumber/contents',                   boxCtrl.getBoxContentsByNumber);
router.get('/session/:sessionId/boxes',                         boxCtrl.getSessionBoxes);

// Box Types + per-item-group capacity matrix
router.get('/box-types',                                        boxCtrl.listBoxTypes);
router.post('/box-types',                                       boxCtrl.upsertBoxType);
router.delete('/box-types/:boxTypeId',                          boxCtrl.deleteBoxType);
router.get('/box-types/matrix',                                 boxCtrl.getBoxTypeMatrix);
router.post('/box-types/:boxTypeId/capacity',                   boxCtrl.upsertBoxTypeCapacity);
router.delete('/box-types/:boxTypeId/capacity/:itemGroupName',  boxCtrl.deleteBoxTypeCapacity);

module.exports = router;
