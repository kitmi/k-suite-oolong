"use strict";

const { Helpers: { withExpose, withName, withExtraInfo } } = require('@k-suite/app');
const HttpCode = require('http-status-codes');

/**
 * Adds a status property to the class.
 * @mixin
 * @param {*} Base 
 * @param {*} STATUS 
 */
const withStatus = (Base, STATUS) => class extends Base {
    /**
     * Status code.
     * @member {number}
     */
    status = STATUS;
};

/**
 * Expected business errors upon wrong request.
 * @class Errors:BusinessError
 * @extends Error
 * @mixes withName
 * @mixes withExtraInfo
 */
class BusinessError extends withExpose(withExtraInfo(withName(Error))) {    
    constructor(message, status, ...others) {
        if (arguments.length === 1 && typeof message === 'number') {
            super(HttpCode.getStatusText(message));
        } else {
            super(message, ...others);
        }        

        this.status = status || HttpCode.BAD_REQUEST;
    }
}

/**
 * Errors caused by failing to pass input validation
 * @class Errors:DataValidationError
 * @extends Error
 * @mixes withName
 */
class DataValidationError extends BusinessError {
    constructor(message, ...others) {
        super(message, HttpCode.BAD_REQUEST, ...others);
    }
}

/**
 * Errors caused by wrongly usage patterns, e.g. called with invalid options.
 * @class Errors:OolongUsageError
 * @extends Error
 * @mixes withName
 */
class OolongUsageError extends withStatus(withExtraInfo(withName(Error)), HttpCode.INTERNAL_SERVER_ERROR) {
}

/**
 * Errors occurred during performing operations against a data source.
 * @class Errors:DsOperationError
 * @extends Error
 * @mixes withName
 * @mixes withExtraInfo
 */
class DsOperationError extends withStatus(withExtraInfo(withName(Error)), HttpCode.INTERNAL_SERVER_ERROR) {    
}

module.exports = {
    DataValidationError,
    OolongUsageError,
    DsOperationError,
    BusinessError
};