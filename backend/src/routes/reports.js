const router = require('express').Router();
const ctrl = require('../controllers/reportController');

router.get('/picking',           ctrl.getPickingReport);
router.get('/picking/export',    ctrl.exportPickingReport);
router.get('/filters/stations',  ctrl.getStationFilters);
router.get('/filters/operators', ctrl.getOperatorFilters);

module.exports = router;
