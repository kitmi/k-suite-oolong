"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const Util = require('rk-utils');

const {
  _
} = Util._;

const Errors = require('./Errors');

const Generators = require('./Generators');

const Types = require('./types');

const {
  DataValidationError,
  OolongUsageError,
  DsOperationError,
  BusinessError
} = Errors;

const Features = require('./entityFeatures');

const Rules = require('../enum/Rules');

const {
  isNothing
} = require('../utils/lang');

const NEED_OVERRIDE = 'Should be overrided by driver-specific subclass.';

class EntityModel {
  constructor(rawData) {
    if (rawData) {
      Object.assign(this, rawData);
    }
  }

  get $pkValues() {
    return _.pick(this, _.castArray(this.constructor.meta.keyField));
  }

  static populate(data) {
    let ModelClass = this;
    return new ModelClass(data);
  }

  static getUniqueKeyFieldsFrom(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }

  static getUniqueKeyValuePairsFrom(data) {
    if (!_.isPlainObject(data)) {
      throw new Error("Function  precondition failed: _.isPlainObject(data)");
    }

    let ukFields = this.getUniqueKeyFieldsFrom(data);
    return _.pick(data, ukFields);
  }

  static async findOne_(findOptions, connOptions) {
    if (!findOptions) {
      throw new Error("Function  precondition failed: findOptions");
    }

    findOptions = this._prepareQueries(findOptions, true);
    let context = {
      findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions.$association);
    }

    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$association);
      } else if (records.length === 0) {
        return undefined;
      }

      if (!(records.length === 1)) {
        throw new Error("Assertion failed: records.length === 1");
      }

      let result = records[0];
      if (context.findOptions.$unboxing) return result;
      return this.populate(result);
    }, context);
  }

  static async findAll_(findOptions, connOptions) {
    findOptions = this._prepareQueries(findOptions);
    let context = {
      findOptions,
      connOptions
    };
    console.log(findOptions);
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions.$association);
    }

    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association) {
        records = this._mapRecordsToObjects(records, findOptions.$association);
      }

      if (context.findOptions.$unboxing) return records;
      return records.map(row => this.populate(row));
    }, context);
  }

  static async create_(data, createOptions, connOptions) {
    createOptions || (createOptions = {});

    let [raw, associations] = this._extractAssociations(data);

    let context = {
      raw,
      createOptions,
      connOptions
    };
    let needCreateAssocs = false;

    if (!_.isEmpty(associations)) {
      needCreateAssocs = true;
    }

    return this._safeExecute_(async context => {
      if (needCreateAssocs) {
        if (!context.connOptions || !context.connOptions.connection) {
          context.connOptions || (context.connOptions = {});
          context.connOptions.connection = await this.db.connector.beginTransaction_();
        }
      }

      await this._prepareEntityData_(context);
      await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context);
      context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
      await this.afterCreate_(context);

      if (needCreateAssocs) {
        await this._createAssocs_(context, associations);
      }

      return createOptions.$unboxing ? context.latest : this.populate(context.latest);
    }, context);
  }

  static async update_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$byPassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$byPassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions);
  }

  static async _update_(data, updateOptions, connOptions) {
    if (!updateOptions) {
      let conditionFields = this.getUniqueKeyFieldsFrom(data);

      if (_.isEmpty(conditionFields)) {
        throw new OolongUsageError('Primary key value(s) or at least one group of unique key value(s) is required for updating an entity.');
      }

      updateOptions = {
        $query: _.pick(data, conditionFields)
      };
      data = _.omit(data, conditionFields);
    }

    updateOptions = this._prepareQueries(updateOptions, true);
    let context = {
      raw: data,
      updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);
      await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.updateOptions.$query, context.connOptions);
      await this.afterUpdate_(context);
      return updateOptions.$unboxing ? context.latest : this.populate(context.latest);
    }, context);
  }

  static async delete_(deleteOptions, connOptions) {
    if (!deleteOptions) {
      throw new Error("Function  precondition failed: deleteOptions");
    }

    deleteOptions = this._prepareQueries(deleteOptions, true);

    if (_.isEmpty(deleteOptions.$query)) {
      throw new OolongUsageError('Empty condition is not allowed for deleting an entity.');
    }

    let context = {
      deleteOptions,
      connOptions
    };
    let notFinished = await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context);

    if (!notFinished) {
      return context.latest;
    }

    return this._safeExecute_(async context => {
      await this.beforeDelete_(context);
      context.result = await this.db.connector.delete_(this.meta.name, context.deleteOptions.$query, context.connOptions);
      return deleteOptions.$unboxing ? context.existing : this.populate(context.existing);
    }, context);
  }

  static _containsUniqueKey(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }

  static _ensureContainsUniqueKey(condition) {
    let containsUniqueKey = this._containsUniqueKey(condition);

    if (!containsUniqueKey) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: 'Single record operation requires condition to be containing unique key.',
        condition
      });
    }
  }

  static async _prepareEntityData_(context, isUpdating = false) {
    let meta = this.meta;
    let i18n = this.i18n;
    let {
      name,
      fields
    } = meta;
    let {
      raw
    } = context;
    let latest = {},
        existing;
    context.latest = latest;

    if (!context.i18n) {
      context.i18n = i18n;
    }

    let opOptions = isUpdating ? context.updateOptions : context.createOptions;

    if (isUpdating && this._dependsOnExistingData(raw)) {
      if (!context.connOptions || !context.connOptions.connection) {
        context.connOptions || (context.connOptions = {});
        context.connOptions.connection = await this.db.connector.beginTransaction_();
      }

      existing = await this.findOne_({
        $query: opOptions.$query,
        $unboxing: true
      }, context.connOptions);
      context.existing = existing;
    }

    await Util.eachAsync_(fields, async (fieldInfo, fieldName) => {
      if (fieldName in raw) {
        if (fieldInfo.readOnly) {
          if (!isUpdating || !opOptions.$byPassReadOnly.has(fieldName)) {
            throw new DataValidationError(`Read-only field "${fieldName}" is not allowed to be set by manual input.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }
        }

        if (isUpdating && fieldInfo.freezeAfterNonDefault) {
          if (!existing) {
            throw new Error('"freezeAfterNonDefault" qualifier requires existing data.');
          }

          if (existing[fieldName] !== fieldInfo.default) {
            throw new DataValidationError(`FreezeAfterNonDefault field "${fieldName}" is not allowed to be changed.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }
        }

        if (isUpdating && fieldInfo.writeOnce) {
          if (!existing) {
            throw new Error('"writeOnce" qualifier requires existing data.');
          }

          if (!_.isNil(existing[fieldName])) {
            throw new DataValidationError(`Write-once field "${fieldName}" is not allowed to be update once it was set.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }
        }

        if (isNothing(raw[fieldName])) {
          if (!fieldInfo.optional) {
            throw new DataValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }

          latest[fieldName] = null;
        } else {
          latest[fieldName] = Types.sanitize(raw[fieldName], fieldInfo, i18n);
        }

        return;
      }

      if (isUpdating) {
        if (fieldInfo.forceUpdate) {
          if (fieldInfo.updateByDb) {
            return;
          }

          if (fieldInfo.auto) {
            latest[fieldName] = await Generators.default(fieldInfo, i18n);
            return;
          }

          throw new DataValidationError(`"${fieldName}" of "${name}" enttiy is required for each update.`, {
            entity: name,
            fieldInfo: fieldInfo
          });
        }

        return;
      }

      if (!fieldInfo.createByDb) {
        if (fieldInfo.hasOwnProperty('default')) {
          latest[fieldName] = fieldInfo.default;
        } else if (fieldInfo.optional) {
          return;
        } else if (fieldInfo.auto) {
          latest[fieldName] = await Generators.default(fieldInfo, i18n);
        } else {
          throw new DataValidationError(`"${fieldName}" of "${name}" entity is required.`, {
            entity: name,
            fieldInfo: fieldInfo
          });
        }
      }
    });
    await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);
    await this.applyModifiers_(context, isUpdating);
    context.latest = this.translateValue(latest, opOptions.$variables);
    return context;
  }

  static async _safeExecute_(executor, context) {
    executor = executor.bind(this);

    if (context.connOptions && context.connOptions.connection) {
      return executor(context);
    }

    try {
      let result = await executor(context);
      context.connOptions && context.connOptions.connection && (await this.db.connector.commit_(context.connOptions.connection));
      return result;
    } catch (error) {
      context.connOptions && context.connOptions.connection && (await this.db.connector.rollback_(context.connOptions.connection));
      throw error;
    }
  }

  static _dependsOnExistingData(input) {
    let deps = this.meta.fieldDependencies;
    let hasDepends = false;

    if (deps) {
      hasDepends = _.find(deps, (dep, fieldName) => {
        if (fieldName in input) {
          return _.find(dep, d => {
            let [stage, field] = d.split('.');
            return (stage === 'latest' || stage === 'existng') && _.isNil(input[field]);
          });
        }

        return false;
      });

      if (hasDepends) {
        return true;
      }
    }

    let atLeastOneNotNull = this.meta.features.atLeastOneNotNull;

    if (atLeastOneNotNull) {
      hasDepends = _.find(atLeastOneNotNull, fields => _.find(fields, field => field in input && _.isNil(input[field])));

      if (hasDepends) {
        return true;
      }
    }

    return false;
  }

  static _hasReservedKeys(obj) {
    return _.find(obj, (v, k) => k[0] === '$');
  }

  static _prepareQueries(options, forSingleRecord = false) {
    if (!_.isPlainObject(options)) {
      if (forSingleRecord && Array.isArray(this.meta.keyField)) {
        throw new OolongUsageError('Cannot use a singular value as condition to query against a entity with combined primary key.');
      }

      return options ? {
        $query: {
          [this.meta.keyField]: this.translateValue(options)
        }
      } : {};
    }

    let normalizedOptions = {},
        query = {};

    _.forOwn(options, (v, k) => {
      if (k[0] === '$') {
        normalizedOptions[k] = v;
      } else {
        query[k] = v;
      }
    });

    normalizedOptions.$query = { ...query,
      ...normalizedOptions.$query
    };

    if (forSingleRecord) {
      this._ensureContainsUniqueKey(normalizedOptions.$query);
    }

    normalizedOptions.$query = this.translateValue(normalizedOptions.$query, normalizedOptions.$variables);
    return normalizedOptions;
  }

  static _prepareAssociations() {
    throw new Error(NEED_OVERRIDE);
  }

  static _mapRecordsToObjects() {
    throw new Error(NEED_OVERRIDE);
  }

  static _extractAssociations(data) {
    throw new Error(NEED_OVERRIDE);
  }

  static async _createAssocs_(context, assocs) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateSymbolToken(name) {
    throw new Error(NEED_OVERRIDE);
  }

  static _serialize(value) {
    throw new Error(NEED_OVERRIDE);
  }

  static translateValue(value, variables) {
    if (_.isPlainObject(value)) {
      if (value.oorType) {
        if (value.oorType === 'SessionVariable') {
          if (!variables) {
            throw new OolongUsageError('Variables context missing.');
          }

          let refValue = variables[value.name];

          if (isNothing(refValue) && !value.optional) {
            let errArgs = [];

            if (value.missingMessage) {
              errArgs.push(value.missingMessage);
            }

            if (value.missingStatus) {
              errArgs.push(value.missingStatus || HttpCode.BAD_REQUEST);
            }

            throw new BusinessError(...errArgs);
          }

          return refValue;
        } else if (value.oorType === 'SymbolToken') {
          return this._translateSymbolToken(value.name);
        }

        throw new Error('Not impletemented yet. ' + value.oolType);
      }

      return _.mapValues(value, v => this.translateValue(v, variables));
    }

    if (Array.isArray(value)) {
      return value.map(v => this.translateValue(v, variables));
    }

    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIlV0aWwiLCJfIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJEc09wZXJhdGlvbkVycm9yIiwiQnVzaW5lc3NFcnJvciIsIkZlYXR1cmVzIiwiUnVsZXMiLCJpc05vdGhpbmciLCJORUVEX09WRVJSSURFIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCIkcGtWYWx1ZXMiLCJwaWNrIiwiY2FzdEFycmF5IiwibWV0YSIsImtleUZpZWxkIiwicG9wdWxhdGUiLCJkYXRhIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJjb250ZXh0IiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwiJGFzc29jaWF0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImRiIiwiY29ubmVjdG9yIiwiZmluZF8iLCJuYW1lIiwibGVuZ3RoIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyZXN1bHQiLCIkdW5ib3hpbmciLCJmaW5kQWxsXyIsImNvbnNvbGUiLCJsb2ciLCJtYXAiLCJyb3ciLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsImFzc29jaWF0aW9ucyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImlzRW1wdHkiLCJjb25uZWN0aW9uIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwibGF0ZXN0IiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVfIiwidXBkYXRlT3B0aW9ucyIsIiRieVBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5Iiwib21pdCIsIlJVTEVfQkVGT1JFX1VQREFURSIsImFmdGVyVXBkYXRlXyIsImRlbGV0ZV8iLCJkZWxldGVPcHRpb25zIiwibm90RmluaXNoZWQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJiZWZvcmVEZWxldGVfIiwiZXhpc3RpbmciLCJfY29udGFpbnNVbmlxdWVLZXkiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleSIsImlzVXBkYXRpbmciLCJpMThuIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsImVhY2hBc3luY18iLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJyZWFkT25seSIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJ3cml0ZU9uY2UiLCJvcHRpb25hbCIsInNhbml0aXplIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsImFwcGx5TW9kaWZpZXJzXyIsInRyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJlcnJvciIsInJvbGxiYWNrXyIsImlucHV0IiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaGFzRGVwZW5kcyIsImRlcCIsImQiLCJzdGFnZSIsImZpZWxkIiwic3BsaXQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrIiwib3B0aW9ucyIsImZvclNpbmdsZVJlY29yZCIsIkFycmF5IiwiaXNBcnJheSIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInZhcmlhYmxlcyIsIm9vclR5cGUiLCJyZWZWYWx1ZSIsImVyckFyZ3MiLCJtaXNzaW5nTWVzc2FnZSIsInB1c2giLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCJvb2xUeXBlIiwibWFwVmFsdWVzIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUUsRUFBQUE7QUFBRixJQUFRRCxJQUFJLENBQUNDLENBQW5COztBQUNBLE1BQU1DLE1BQU0sR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBQ0EsTUFBTUksVUFBVSxHQUFHSixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNSyxLQUFLLEdBQUdMLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsbUJBQUY7QUFBdUJDLEVBQUFBLGdCQUF2QjtBQUF5Q0MsRUFBQUEsZ0JBQXpDO0FBQTJEQyxFQUFBQTtBQUEzRCxJQUE2RU4sTUFBbkY7O0FBQ0EsTUFBTU8sUUFBUSxHQUFHVixPQUFPLENBQUMsa0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsZUFBRCxDQUFyQjs7QUFFQSxNQUFNO0FBQUVZLEVBQUFBO0FBQUYsSUFBZ0JaLE9BQU8sQ0FBQyxlQUFELENBQTdCOztBQUVBLE1BQU1hLGFBQWEsR0FBRyxr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LEtBQUssQ0FBQ0ssY0FBVixFQUEwQjtBQUN0QkQsY0FBQUEsT0FBTyxDQUFDRSxJQUFSLENBQWFOLEtBQUssQ0FBQ0ssY0FBbkI7QUFDSDs7QUFDRCxnQkFBSUwsS0FBSyxDQUFDTyxhQUFWLEVBQXlCO0FBQ3JCSCxjQUFBQSxPQUFPLENBQUNFLElBQVIsQ0FBYU4sS0FBSyxDQUFDTyxhQUFOLElBQXVCL0osUUFBUSxDQUFDZ0ssV0FBN0M7QUFDSDs7QUFFRCxrQkFBTSxJQUFJdEosYUFBSixDQUFrQixHQUFHa0osT0FBckIsQ0FBTjtBQUNIOztBQUVELGlCQUFPRCxRQUFQO0FBQ0gsU0FwQkQsTUFvQk8sSUFBSUgsS0FBSyxDQUFDRSxPQUFOLEtBQWtCLGFBQXRCLEVBQXFDO0FBQ3hDLGlCQUFPLEtBQUtKLHFCQUFMLENBQTJCRSxLQUFLLENBQUNwRyxJQUFqQyxDQUFQO0FBQ0g7O0FBRUQsY0FBTSxJQUFJZ0csS0FBSixDQUFVLDRCQUE0QkksS0FBSyxDQUFDUyxPQUE1QyxDQUFOO0FBQ0g7O0FBRUQsYUFBTzlKLENBQUMsQ0FBQytKLFNBQUYsQ0FBWVYsS0FBWixFQUFvQmIsQ0FBRCxJQUFPLEtBQUtwQixjQUFMLENBQW9Cb0IsQ0FBcEIsRUFBdUJjLFNBQXZCLENBQTFCLENBQVA7QUFDSDs7QUFFRCxRQUFJVixLQUFLLENBQUNDLE9BQU4sQ0FBY1EsS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLGFBQU9BLEtBQUssQ0FBQzNGLEdBQU4sQ0FBVThFLENBQUMsSUFBSSxLQUFLcEIsY0FBTCxDQUFvQm9CLENBQXBCLEVBQXVCYyxTQUF2QixDQUFmLENBQVA7QUFDSDs7QUFFRCxXQUFPLEtBQUtGLFVBQUwsQ0FBZ0JDLEtBQWhCLENBQVA7QUFDSDs7QUFob0JhOztBQW1vQmxCVyxNQUFNLENBQUNDLE9BQVAsR0FBaUJySixXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXyB9ID0gVXRpbC5fO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIEdldCBhbiBvYmplY3Qgb2YgdGhlIHByaW1hcnkga2V5IHZhbHVlcy5cbiAgICAgKi9cbiAgICBnZXQgJHBrVmFsdWVzKCkge1xuICAgICAgICByZXR1cm4gXy5waWNrKHRoaXMsIF8uY2FzdEFycmF5KHRoaXMuY29uc3RydWN0b3IubWV0YS5rZXlGaWVsZCkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICAvL3RoaXMuc2VyaWFsaXplKGNvbnRleHQuZmluZE9wdGlvbnMuJHF1ZXJ5KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuZmluZE9wdGlvbnMuJHVuYm94aW5nKSByZXR1cm4gcmVzdWx0O1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5wb3B1bGF0ZShyZXN1bHQpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiBtb2RlbCBvYmplY3Qgb3IgYW4gYXJyYXkgb2YgcmVjb3JkcyBkaXJlY3RseSBpZiAkdW5ib3hpbmcgPSB0cnVlLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGNvbnNvbGUubG9nKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIC8vdGhpcy5zZXJpYWxpemUoY29udGV4dC5maW5kT3B0aW9ucy4kcXVlcnkpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5maW5kT3B0aW9ucy4kdW5ib3hpbmcpIHJldHVybiByZWNvcmRzO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVjb3Jkcy5tYXAocm93ID0+IHRoaXMucG9wdWxhdGUocm93KSk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdW5ib3hpbmc9ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY3JlYXRlT3B0aW9ucy4kdW5ib3hpbmcgPyBjb250ZXh0LmxhdGVzdCA6IHRoaXMucG9wdWxhdGUoY29udGV4dC5sYXRlc3QpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2VcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHVwZGF0ZU9wdGlvbnMuJHVuYm94aW5nID8gY29udGV4dC5sYXRlc3QgOiB0aGlzLnBvcHVsYXRlKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZVxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBwcmU6IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgbm90RmluaXNoZWQgPSBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG4gICAgICAgIGlmICghbm90RmluaXNoZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGRlbGV0ZU9wdGlvbnMuJHVuYm94aW5nID8gY29udGV4dC5leGlzdGluZyA6IHRoaXMucG9wdWxhdGUoY29udGV4dC5leGlzdGluZyk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBjb250YWluc1VuaXF1ZUtleSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7XG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbjogJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGNvbmRpdGlvbiB0byBiZSBjb250YWluaW5nIHVuaXF1ZSBrZXkuJyxcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGlzVXBkYXRpbmcgPyBjb250ZXh0LnVwZGF0ZU9wdGlvbnMgOiBjb250ZXh0LmNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgdGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykpIHtcbiAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnksICR1bmJveGluZzogdHJ1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgVXRpbC5lYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieVBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHJhd1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZShyYXdbZmllbGROYW1lXSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudHRpeSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcykge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlZlZhbHVlID0gdmFyaWFibGVzW3ZhbHVlLm5hbWVdO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcocmVmVmFsdWUpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVmVmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vbFR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2KSA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUubWFwKHYgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=