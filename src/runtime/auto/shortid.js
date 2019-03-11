"use strict";

const { tryRequire } = require('@k-suite/app/lib/utils/Helpers');

module.exports = function (info, i18n, options) {
    const shortid = tryRequire('shortid');

    return shortid.generate();
}