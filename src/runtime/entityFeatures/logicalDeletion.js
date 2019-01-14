"use strict";

const Rules = require('../../enum/Rules');

/**
 * A rule specifies the entity will not be deleted physically.
 * @module EntityFeatureRuntime_LogicalDeletion
 */

module.exports = {
    [Rules.RULE_BEFORE_FIND]: ({ feature, entityModel, context }, next) => {
        let findOptions = context.findOptions;
        if (!findOptions.$includeDeleted) {
            findOptions.$where = entityModel.mergeCondition(findOptions.$where, { [feature.field]: { $ne: feature.value } });
        }

        return next();
    }
};