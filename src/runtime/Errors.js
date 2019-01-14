"use strict";

const { withName, withExtraInfo } = require('@k-suite/app/lib/utils/Helpers');
const HttpCode = require('http-status-codes');

/**
 * Adds a status property to the class.
 * @mixin
 * @param {*} Base 
 * @param {*} STATUS 
 */
const withHttpStatus = (Base, STATUS) => class extends Base {
    /**
     * Http status code.
     * @member {number}
     */
    status = STATUS;
};

/**
 * Expected business errors upon wrong request.
 * @class Errors:BusinessError
 * @extends Error
 */
class BusinessError extends Error {    
}

/**
 * Errors caused by failing to pass input validation
 * @class Errors:DataValidationError
 * @extends Error
 * @mixes withName
 */
class DataValidationError extends withExtraInfo(withName(withHttpStatus(Error, HttpCode.BAD_REQUEST))) {
}

/**
 * Errors caused by wrongly usage patterns, e.g. called with invalid options.
 * @class Errors:OolongUsageError
 * @extends Error
 * @mixes withName
 */
class OolongUsageError extends withName(withHttpStatus(Error, HttpCode.INTERNAL_SERVER_ERROR)) {
}

/**
 * Errors occurred during performing operations against a data source.
 * @class Errors:DsOperationError
 * @extends Error
 * @mixes withName
 * @mixes withExtraInfo
 */
class DsOperationError extends withExtraInfo(withName(withHttpStatus(Error, HttpCode.INTERNAL_SERVER_ERROR))) {    
}

module.exports = {
    DataValidationError,
    OolongUsageError,
    DsOperationError,
    BusinessError
};