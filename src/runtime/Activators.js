"use strict";

const { _ } = require('rk-utils');

module.exports = {
    datetimeBetween: function (startTime, endTime) {
        
    },

    isEqual: function (value1, value2) {
        return value1 === value2;
    },

    select: function () {
        
    },

    triggerUpdate: function (value, condition) {
        return condition ? value : null;
    },

    sum: (...args) => args.reduce((sum, v) => sum += v, 0),

    multiply: (multiplier, multiplicand) => multiplier*multiplicand
};