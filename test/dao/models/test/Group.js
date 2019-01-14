const { _ } = require('rk-utils');

const { Validators, Processors, Generators, Errors: { DataValidationError, DsOperationError }, Utils: { Lang: { isNothing } } } = require('@k-suite/oolong');
 

module.exports = (db, BaseEntityModel) => {
    const GroupSpec = class extends BaseEntityModel {    
        /**
         * Applying predefined modifiers to entity fields.
         * @param context
         * @param isUpdating
         * @returns {*}
         */
        static async applyModifiers_(context, isUpdating) {
            let {raw, latest, existing, i18n} = context;
            existing || (existing = {});
            return context;
        }
    };

    GroupSpec.db = db;
    GroupSpec.meta = {
    "schemaName": "test",
    "name": "group",
    "keyField": "id",
    "fields": {
        "id": {
            "type": "integer",
            "auto": true,
            "readOnly": true,
            "writeOnce": true,
            "displayName": "Id",
            "autoIncrementId": true,
            "defaultByDb": true
        },
        "name": {
            "type": "text",
            "maxLength": 255,
            "optional": true,
            "comment": "Group Name",
            "displayName": "Group Name"
        }
    },
    "indexes": [],
    "features": {
        "autoId": {
            "field": "id"
        }
    },
    "uniqueKeys": [
        [
            "id"
        ]
    ],
    "fieldDependencies": {}
};

    return Object.assign(GroupSpec, );
};