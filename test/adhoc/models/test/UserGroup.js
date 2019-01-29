const { _ } = require('rk-utils');

const { 
    Types,
    Validators, 
    Processors, 
    Generators, 
    Errors: { BusinessError, DataValidationError, DsOperationError }, 
    Utils: { Lang: { isNothing } } 
} = require('@k-suite/oolong');
 

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
            "user",
            "group"
        ],
        "fields": {
            "createdAt": {
                "type": "datetime",
                "auto": true,
                "readOnly": true,
                "writeOnce": true,
                "displayName": "Created At",
                "isCreateTimestamp": true,
                "createByDb": true
            },
            "user": {
                "type": "integer",
                "displayName": "userId",
                "createByDb": true
            },
            "group": {
                "type": "integer",
                "displayName": "groupId",
                "createByDb": true
            }
        },
        "features": {
            "createTimestamp": {
                "field": "createdAt"
            }
        },
        "uniqueKeys": [
            [
                "user",
                "group"
            ]
        ],
        "associations": {
            "user": {
                "entity": "user"
            },
            "group": {
                "entity": "group"
            }
        },
        "fieldDependencies": {
            "createdAt": [
                "createdAt"
            ]
        }
    };

    return Object.assign(UserGroupSpec, {});
};