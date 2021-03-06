"use strict";

const { tryRequire } = require('@k-suite/app/lib/utils/Helpers');

module.exports = function (info, i18n, options) {
    const uuidv4 = tryRequire('uuid/v4');
    
    return uuidv4();
}