'use strict';

function mmToDots(mm, dpi) {
    return Math.max(1, Math.round((Number(mm) || 0) * (Number(dpi) || 203) / 25.4));
}

// Strip control chars and the language's own field delimiters so injected
// label data (customer names, item groups, etc.) can never break out of a
// text field into a new command.
function escapeText(value) {
    return String(value ?? '')
        .replace(/[\r\n\x00-\x1f]/g, ' ')
        .replace(/[\^~]/g, ' ')
        .trim();
}

module.exports = { mmToDots, escapeText };
