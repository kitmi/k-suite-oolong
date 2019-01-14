const { _ } = require('rk-utils');

const { 
    Types,
    Validators, 
    Processors, 
    Generators, 
    Errors: { DataValidationError, DsOperationError }, 
    Utils: { Lang: { isNothing } } 
} = require('@k-suite/oolong');
{{ imports|safe }} 

module.exports = (db, BaseEntityModel) => {
    const {{ className }}Spec = class extends BaseEntityModel {    
        {{ classBody|safe }}
    };

    {{ className }}Spec.db = db;
    {{ className }}Spec.meta = {{ entityMeta|safe }};

    return Object.assign({{ className }}Spec, {{ functors|safe }});
};