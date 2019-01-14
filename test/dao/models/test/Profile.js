const { _ } = require('rk-utils');

const { Validators, Processors, Generators, Errors: { DataValidationError, DsOperationError }, Utils: { Lang: { isNothing } } } = require('@k-suite/oolong');
 

module.exports = (db, BaseEntityModel) => {
    const ProfileSpec = class extends BaseEntityModel {    
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

    ProfileSpec.db = db;
    ProfileSpec.meta = {
    "schemaName": "test",
    "name": "profile",
    "keyField": "id",
    "fields": {
        "id": {
            "type": "text",
            "maxLength": 32,
            "comment": "Profile Id",
            "displayName": "Profile Id",
            "defaultByDb": true
        },
        "gender": {
            "type": "text",
            "maxLength": 1,
            "comment": "Gender Code",
            "displayName": "Gender Code",
            "defaultByDb": true
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
    "indexes": [
        {
            "fields": [
                "user"
            ],
            "unique": true
        },
        {
            "fields": [
                "gender"
            ]
        }
    ],
    "features": [],
    "uniqueKeys": [
        [
            "id"
        ],
        [
            "user"
        ]
    ],
    "fieldDependencies": {}
};

    return Object.assign(ProfileSpec, );
};