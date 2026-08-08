'use strict';

// Protocol registry — `printerService.printLabel` looks up a config's
// `Protocol` here to pick the renderer. Adding a new protocol later is one
// new file in this directory + one line here; nothing else in the framework
// (transport, queueing, retry, logging) needs to change.
module.exports = {
    ZPL:    require('./zpl'),
    EPL:    require('./epl'),
    TSPL:   require('./tspl'),
    CPCL:   require('./cpcl'),
    ESCPOS: require('./escpos'),
    RAW:    require('./raw'),
};
