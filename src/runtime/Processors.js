"use strict";

const { _ } = require('rk-utils');

module.exports = {
    trim : (s, chars) => _.trim(s, chars),
    stringDasherize : s => _.words(s).join('-'),
    upperCase : s => s.toUpperCase(),
    lowerCase : s => s.toLowerCase(),
    ifNullSetTo : (v, other) => _.isNil(v) ? other : v
};