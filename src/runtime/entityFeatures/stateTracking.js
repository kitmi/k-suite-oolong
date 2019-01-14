"use strict";

const Rules = require('../../enum/Rules');
const Generators = require('../Generators');

/**
 * A rule specifies the change of state will be tracked automatically.
 * @module EntityFeatureRuntime_StateTracking
 */

module.exports = {
    [Rules.RULE_AFTER_VALIDATION]: ({ feature, entityModel, context }, next) => {
        feature.forEach(featureItem => {
            if (featureItem.field in context.latest) {
                let targetState = context.latest[featureItem.field];
                let timestampFieldName = featureItem.stateMapping[targetState];
                context.latest[timestampFieldName] = Generators.default(entityModel.meta.fields[timestampFieldName], context.i18n);
            }
        });        

        return next();
    }
};