"use strict";

const Rules = require('../../enum/Rules');
const { mergeCondition } = require('../../utils/lang');
const Generators = require('../Generators');

/**
 * A rule specifies the entity will not be deleted physically.
 * @module EntityFeatureRuntime_LogicalDeletion
 */

module.exports = {
    [Rules.RULE_BEFORE_FIND]: (feature, entityModel, context) => {
        let findOptions = context.findOptions;
        if (!findOptions.$includeDeleted) {
            findOptions.$query = mergeCondition(findOptions.$query, { [feature.field]: { $ne: feature.value } });
        }

        return true;
    },
    [Rules.RULE_BEFORE_DELETE]: (feature, entityModel, context) => {
        let options = context.options;
        if (!options.$physicalDeletion) {
            let { field, value, timestampField } = feature;
            let updateTo = {
                [field]: value
            };

            if (timestampField) {
                updateTo[timestampField] = Generators.default(entityModel.meta.fields[timestampField], context.i18n);
            }

            context.latest = entityModel._update_(updateTo, { 
                $query: options.$query, 
                $retrieveUpdated: options.$retrieveDeleted,
                $byPassReadOnly: new Set([field, timestampField])
            });

            return false;
        }

        return true;
    }
};