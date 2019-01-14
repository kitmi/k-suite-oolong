"use strict";

const Util = require('rk-utils');
const { _ } = Util;

const validator = require('validator');

module.exports = _.pick(validator, [ 
    'equals',
    'contains',
    'matches',
    'isEmail',
    'isURL',
    'isMACAddress',
    'isIP',
    'isFQDN',
    'isBoolean',
    'isAlpha',
    'isAlphanumeric',
    'isNumeric',
    'isPort',
    'isLowercase',
    'isUppercase',
    'isAscii',
    'isFullWidth',
    'isHalfWidth',
    'isVariableWidth',
    'isMultibyte',
    'isSurrogatePair',
    'isInt',
    'isFloat',
    'isDecimal',
    'isHexadecimal',
    'isDivisibleBy',
    'isHexColor',
    'isISRC',
    'isMD5',
    'isHash',
    'isJSON',
    'isEmpty',
    'isLength',
    'isByteLength',
    'isUUID',
    'isMongoId',
    'isAfter',
    'isBefore',
    'isIn',
    'isCreditCard',
    'isISIN',
    'isISBN',
    'isISSN',
    'isMobilePhone',
    'isPostalCode',
    'isCurrency',
    'isISO8601',
    'isISO31661Alpha2',
    'isBase64',
    'isDataURI',
    'isMimeType',
    'isLatLong'
]);

module.exports.min = function (value, minValue) {
    return value >= minValue;
};

module.exports.max = function (value, maxValue) {
    return value <= maxValue;
};

module.exports.gt = function (value, minValue) {
    return value > minValue;
};

module.exports.lt = function (value, maxValue) {
    return value < maxValue;
};

module.exports.maxLength = function (value, maxLength) {
    return value.length <= maxLength;
};