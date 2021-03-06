"use strict";

const { _, quote } = require('rk-utils');
const { isNothing } = require('../../utils/lang');
const any = require('./any');
const { DataValidationError } = require('../../runtime/Errors');

module.exports = {
    name: 'array',

    alias: [ 'list' ],

    sanitize: (value, info, i18n) => {
        if (Array.isArray(value)) return value;

        if (typeof value === 'string') {
            let trimmed = value.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                return JSON.parse(trimmed);
            }       
            
            throw new DataValidationError(`Invalid array format: ${value}`);
        }

        return [ value ];
    },

    defaultValue: [],

    generate: (info, i18n) => null,

    serialize: (value) => isNothing(value) ? null : JSON.stringify(value),

    qualifiers: any.qualifiers.concat([
        'csv',
        'of'
    ]),

    toCsv: (data, separator = ',') => data.map(
        elem => { elem = elem.toString(); return elem.indexOf(separator) != -1 ? quote(elem, '"') : elem; }
        ).join(separator)
};