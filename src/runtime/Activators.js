"use strict";

const { _ } = require('rk-utils');
const { OolongUsageError } = require('./Errors');

module.exports = {
    datetimeAdd: function (model, context, startTime, duration) {
        return startTime.plus(duration);
    },

    isEqual: function (model, context, value1, value2) {
        return value1 === value2;
    },

    triggerUpdate: function (model, context, value, condition) {
        return condition ? value : null;
    },

    sum: (model, context, ...args) => args.reduce((sum, v) => sum += v, 0),

    multiply: (model, context, multiplier, multiplicand) => multiplier*multiplicand,

    populate: async (model, context, assoc) => {
        let parts = assoc.split('.');
        assert: parts.length > 1;

        let selectedField = parts.pop();
        let remoteAssoc = parts.join('.');
        let localAssoc = parts.shift();
        let interAssoc;
        
        if (parts.length > 0) {
            interAssoc = parts.join('.');
        }
        
        if (!context.latest.hasOwnProperty(localAssoc)) {
            return undefined;
        }

        let assocValue = context.latest[localAssoc];
        if (_.isNil(assocValue)) {
            throw new OolongUsageError(`The value of referenced association "${localAssoc}" of entity "${model.meta.name}" should not be null.`);
        }

        let assocMeta = model.meta.associations[localAssoc];
        if (!assocMeta) {
            throw new OolongUsageError(`"${localAssoc}" is not an association field of entity "${model.meta.name}".`);
        }

        if (assocMeta.list) {
            throw new OolongUsageError(`"${localAssoc}" entity "${model.meta.name}" is a list-style association which is not supported by the built-in populate Activators.`);
        }

        let remoteEntity = context.populated && context.populated[remoteAssoc];
        if (!remoteEntity) {
            let findOptions = { $query: { [assocMeta.key]: assocValue } };

            if (interAssoc) {
                findOptions.$associations = [ interAssoc ];
            }

            await model.ensureTransaction_(context);

            remoteEntity = await model.db.model(assocMeta.entity).findOne_(findOptions, context.connOptions);
            context.populated || (context.populated = {});
            context.populated[localAssoc] = remoteEntity;

            let currentAssoc = localAssoc;
            while (parts.length > 0) {
                let nextAssoc = parts.shift();
                remoteEntity = remoteEntity[':'+nextAssoc];
                assert: !Array.isArray(remoteEntity);

                currentAssoc = currentAssoc+'.'+nextAssoc;
                context.populated[currentAssoc] = remoteEntity;                
            }
        }

        if (!remoteEntity.hasOwnProperty(selectedField)) {
            throw new OolongUsageError(`"${selectedField}" is not a field of remote association "${remoteAssoc}" of entity "${model.meta.name}".`);
        }

        return remoteEntity[selectedField];
    }
};