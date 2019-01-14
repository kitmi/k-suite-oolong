const { _ } = require('rk-utils');

const { Validators, Processors, Generators, Errors: { DataValidationError, DsOperationError }, Utils: { Lang: { isNothing } } } = require('@k-suite/oolong');
 

module.exports = (db, BaseEntityModel) => {
    const UserGroupSpec = class extends BaseEntityModel {    
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

    UserGroupSpec.db = db;
    UserGroupSpec.meta = {
    "schemaName": "test",
    "name": "userGroup",
    "keyField": [
        "group",
        "user"
    ],
    "fields": {
        "createdAt": {
            "type": "datetime",
            "auto": true,
            "readOnly": true,
            "writeOnce": true,
            "displayName": "Created At",
            "isCreateTimestamp": true,
            "defaultByDb": true
        },
        "group": {
            "type": "integer",
            "auto": true,
            "readOnly": true,
            "writeOnce": true,
            "displayName": "Id"
        },
        "user": {
            "type": "integer",
            "auto": true,
            "readOnly": true,
            "writeOnce": true,
            "startFrom": 100000,
            "displayName": "Id"
        }
    },
    "indexes": [],
    "features": {
        "createTimestamp": {
            "field": "createdAt"
        }
    },
    "uniqueKeys": [
        [
            "group",
            "user"
        ]
    ],
    "fieldDependencies": {}
};

    return Object.assign(UserGroupSpec, );
};