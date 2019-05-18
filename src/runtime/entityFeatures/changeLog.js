"use strict";

const { _ } = require('rk-utils');
const Rules = require('../../enum/Rules');
const { DATETIME } = require('../types');
const { OolongUsageError } = require('../Errors')

function getConnector(entityModel, feature) {
    let app = entityModel.db.app;
        
    if (!app) {
        entityModel.db.connector.log('warn', `"changeLog" feature does not work when used without a service container app.`)
        return true;
    }

    return app.getService(feature.dataSource);
}

async function createLogEntry_(entityModel, feature, context, operation) {
    let logEntry = {
        entity: entityModel.meta.name,
        operation,
        which: context.queryKey, 
        changedAt: DATETIME.typeObject.local()
    };

    if (operation !== 'delete') {
        logEntry.data = context.raw;
    }

    if (feature.withUser) {
        let user = entityModel.getValueFromContext(context, feature.withUser);
        if (_.isNil(user)) {
            throw new OolongUsageError(`Cannot get value of [${feature.withUser}] from context.`);
        }

        logEntry.changedBy = user;
    }

    let clConnector = getConnector(entityModel, feature);
    await clConnector.insertOne_(feature.storeEntity, logEntry);
}

/**
 * A rule specifies the change of state will be tracked automatically.
 * @module EntityFeatureRuntime_ChangeLog
 */

module.exports = {
    [Rules.RULE_AFTER_CREATE]: (feature, entityModel, context) => createLogEntry_(entityModel, feature, context, 'create'),
    [Rules.RULE_AFTER_UPDATE]: (feature, entityModel, context) => createLogEntry_(entityModel, feature, context, 'update'),
    [Rules.RULE_AFTER_DELETE]: (feature, entityModel, context) => createLogEntry_(entityModel, feature, context, 'delete')
};