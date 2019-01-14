const { _ } = require('rk-utils');

const { Validators, Processors, Generators, Errors: { DataValidationError, DsOperationError }, Utils: { Lang: { isNothing } } } = require('@k-suite/oolong');
 

module.exports = (db, BaseEntityModel) => {
    const GenderSpec = class extends BaseEntityModel {    
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

    GenderSpec.db = db;
    GenderSpec.meta = {
    "schemaName": "test",
    "name": "gender",
    "keyField": "code",
    "fields": {
        "code": {
            "type": "text",
            "maxLength": 1,
            "comment": "Gender Code",
            "displayName": "Gender Code",
            "defaultByDb": true
        },
        "name": {
            "type": "text",
            "maxLength": 20,
            "optional": true,
            "comment": "Gender Name",
            "displayName": "Gender Name"
        }
    },
    "indexes": [],
    "features": [],
    "uniqueKeys": [
        [
            "code"
        ]
    ],
    "fieldDependencies": {}
};

    return Object.assign(GenderSpec, );
};