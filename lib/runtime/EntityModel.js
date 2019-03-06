"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const {
  _,
  eachAsync_
} = require('rk-utils');

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

  static async cached_() {
    if (!this._cachedData) {
      this._cachedData = await this.findAll_({
        $toDictionary: true
      });
    }

    return this._cachedData;
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
      findOptions.$association = this._prepareAssociations(findOptions);
    }

    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association && !findOptions.$skipOrm) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$association);
      } else if (records.length === 0) {
        return undefined;
      }

      if (!(records.length === 1)) {
        throw new Error("Assertion failed: records.length === 1");
      }

      let result = records[0];
      return result;
    }, context);
  }

  static async findAll_(findOptions, connOptions) {
    findOptions = this._prepareQueries(findOptions);
    let context = {
      findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions);
    }

    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association && !findOptions.$skipOrm) {
        if (findOptions.$totalCount) {
          totalCount = records[3];
        }

        records = this._mapRecordsToObjects(records, findOptions.$association);
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
          records = records[0];
        }
      }

      return this.afterFindAll_(context, records);
    }, context);

    if (findOptions.$totalCount) {
      return {
        totalItems: totalCount,
        items: rows
      };
    }

    return rows;
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

      return context.latest;
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

  static async updateMany_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$byPassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$byPassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, false);
  }

  static async _update_(data, updateOptions, connOptions, forSingleRecord) {
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

    updateOptions = this._prepareQueries(updateOptions, forSingleRecord);
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
      return context.latest;
    }, context);
  }

  static async deleteOne_(deleteOptions, connOptions) {
    return this._delete_(deleteOptions, connOptions, true);
  }

  static async deleteMany_(deleteOptions, connOptions) {
    return this._delete_(deleteOptions, connOptions, false);
  }

  static async _delete_(deleteOptions, connOptions, forSingleRecord) {
    if (!deleteOptions) {
      throw new Error("Function  precondition failed: deleteOptions");
    }

    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);

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
      return context.existing;
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
        $query: opOptions.$query
      }, context.connOptions);
      context.existing = existing;
    }

    await eachAsync_(fields, async (fieldInfo, fieldName) => {
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

        if (isNothing(raw[fieldName])) {
          if (!fieldInfo.optional) {
            throw new DataValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }

          latest[fieldName] = null;
        } else {
          try {
            latest[fieldName] = Types.sanitize(raw[fieldName], fieldInfo, i18n);
          } catch (error) {
            throw new DataValidationError(`Invalid "${fieldName}" value of "${name}" entity.`, {
              entity: name,
              fieldInfo: fieldInfo,
              error: error.message || error.stack
            });
          }
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

    try {
      await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);
    } catch (error) {
      if (error.status) {
        throw error;
      }

      throw new DsOperationError(`Error occurred during applying features rules to entity "${this.meta.name}". Detail: ` + error.message, {
        error: error
      });
    }

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

    if (normalizedOptions.$having) {
      normalizedOptions.$having = this.translateValue(normalizedOptions.$having, normalizedOptions.$variables);
    }

    if (normalizedOptions.$projection) {
      normalizedOptions.$projection = this.translateValue(normalizedOptions.$projection, normalizedOptions.$variables);
    }

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

          if ((!variables.session || !(value.name in variables.session)) && !value.optional) {
            let errArgs = [];

            if (value.missingMessage) {
              errArgs.push(value.missingMessage);
            }

            if (value.missingStatus) {
              errArgs.push(value.missingStatus || HttpCode.BAD_REQUEST);
            }

            throw new BusinessError(...errArgs);
          }

          return variables.session[value.name];
        } else if (value.oorType === 'QueryVariable') {
          if (!variables) {
            throw new OolongUsageError('Variables context missing.');
          }

          if (!variables.query || !(value.name in variables.query)) {
            throw new OolongUsageError(`Query parameter "${value.name}" in configuration not found.`);
          }

          return variables.query[value.name];
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJEc09wZXJhdGlvbkVycm9yIiwiQnVzaW5lc3NFcnJvciIsIkZlYXR1cmVzIiwiUnVsZXMiLCJpc05vdGhpbmciLCJORUVEX09WRVJSSURFIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCIkcGtWYWx1ZXMiLCJwaWNrIiwiY2FzdEFycmF5IiwibWV0YSIsImtleUZpZWxkIiwicG9wdWxhdGUiLCJkYXRhIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJjYWNoZWRfIiwiX2NhY2hlZERhdGEiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJjb250ZXh0IiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwiJGFzc29jaWF0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImRiIiwiY29ubmVjdG9yIiwiZmluZF8iLCJuYW1lIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwidG90YWxJdGVtcyIsIml0ZW1zIiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJhc3NvY2lhdGlvbnMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJpc0VtcHR5IiwiY29ubmVjdGlvbiIsImJlZ2luVHJhbnNhY3Rpb25fIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsImxhdGVzdCIsImFmdGVyQ3JlYXRlXyIsIl9jcmVhdGVBc3NvY3NfIiwidXBkYXRlXyIsInVwZGF0ZU9wdGlvbnMiLCIkYnlQYXNzUmVhZE9ubHkiLCJlbnRpdHkiLCJyZWFzb24iLCJfdXBkYXRlXyIsInVwZGF0ZU1hbnlfIiwiZm9yU2luZ2xlUmVjb3JkIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5Iiwib21pdCIsIlJVTEVfQkVGT1JFX1VQREFURSIsImFmdGVyVXBkYXRlXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsIm5vdEZpbmlzaGVkIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiYmVmb3JlRGVsZXRlXyIsImRlbGV0ZV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsInN0YXR1cyIsImFwcGx5TW9kaWZpZXJzXyIsInRyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsInNwbGl0IiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2IiwiayIsIm9wdGlvbnMiLCJBcnJheSIsImlzQXJyYXkiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGhhdmluZyIsIiRwcm9qZWN0aW9uIiwiRXJyb3IiLCJhc3NvY3MiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJfc2VyaWFsaXplIiwidmFsdWUiLCJ2YXJpYWJsZXMiLCJvb3JUeXBlIiwic2Vzc2lvbiIsImVyckFyZ3MiLCJtaXNzaW5nTWVzc2FnZSIsInB1c2giLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCJvb2xUeXBlIiwibWFwVmFsdWVzIiwibWFwIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFBTCxJQUFvQkYsT0FBTyxDQUFDLFVBQUQsQ0FBakM7O0FBQ0EsTUFBTUcsTUFBTSxHQUFHSCxPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFDQSxNQUFNSSxVQUFVLEdBQUdKLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1LLEtBQUssR0FBR0wsT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxtQkFBRjtBQUF1QkMsRUFBQUEsZ0JBQXZCO0FBQXlDQyxFQUFBQSxnQkFBekM7QUFBMkRDLEVBQUFBO0FBQTNELElBQTZFTixNQUFuRjs7QUFDQSxNQUFNTyxRQUFRLEdB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QUFJN0osZ0JBQUosQ0FBcUIsNEJBQXJCLENBQU47QUFDSDs7QUFFRCxjQUFJLENBQUM2SixTQUFTLENBQUNULEtBQVgsSUFBb0IsRUFBRVEsS0FBSyxDQUFDNUcsSUFBTixJQUFjNkcsU0FBUyxDQUFDVCxLQUExQixDQUF4QixFQUEwRDtBQUN0RCxrQkFBTSxJQUFJcEosZ0JBQUosQ0FBc0Isb0JBQW1CNEosS0FBSyxDQUFDNUcsSUFBSywrQkFBcEQsQ0FBTjtBQUNIOztBQUVELGlCQUFPNkcsU0FBUyxDQUFDVCxLQUFWLENBQWdCUSxLQUFLLENBQUM1RyxJQUF0QixDQUFQO0FBQ0gsU0FWTSxNQVVBLElBQUk0RyxLQUFLLENBQUNFLE9BQU4sS0FBa0IsYUFBdEIsRUFBcUM7QUFDeEMsaUJBQU8sS0FBS0oscUJBQUwsQ0FBMkJFLEtBQUssQ0FBQzVHLElBQWpDLENBQVA7QUFDSDs7QUFFRCxjQUFNLElBQUl3RyxLQUFKLENBQVUsNEJBQTRCSSxLQUFLLENBQUNTLE9BQTVDLENBQU47QUFDSDs7QUFFRCxhQUFPM0ssQ0FBQyxDQUFDNEssU0FBRixDQUFZVixLQUFaLEVBQW9CZCxDQUFELElBQU8sS0FBS25CLGNBQUwsQ0FBb0JtQixDQUFwQixFQUF1QmUsU0FBdkIsQ0FBMUIsQ0FBUDtBQUNIOztBQUVELFFBQUlaLEtBQUssQ0FBQ0MsT0FBTixDQUFjVSxLQUFkLENBQUosRUFBMEI7QUFDdEIsYUFBT0EsS0FBSyxDQUFDVyxHQUFOLENBQVV6QixDQUFDLElBQUksS0FBS25CLGNBQUwsQ0FBb0JtQixDQUFwQixFQUF1QmUsU0FBdkIsQ0FBZixDQUFQO0FBQ0g7O0FBRUQsV0FBTyxLQUFLRixVQUFMLENBQWdCQyxLQUFoQixDQUFQO0FBQ0g7O0FBN3RCYTs7QUFndUJsQlksTUFBTSxDQUFDQyxPQUFQLEdBQWlCbEssV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIEdldCBhbiBvYmplY3Qgb2YgdGhlIHByaW1hcnkga2V5IHZhbHVlcy5cbiAgICAgKi9cbiAgICBnZXQgJHBrVmFsdWVzKCkge1xuICAgICAgICByZXR1cm4gXy5waWNrKHRoaXMsIF8uY2FzdEFycmF5KHRoaXMuY29uc3RydWN0b3IubWV0YS5rZXlGaWVsZCkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXygpIHtcbiAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICR0b0RpY3Rpb25hcnk6IHRydWUgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fY2FjaGVkRGF0YTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIHByZTogZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikge1xuICAgICAgICAgICAgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICByZXR1cm4geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIHByZTogZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IG5vdEZpbmlzaGVkID0gYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuICAgICAgICBpZiAoIW5vdEZpbmlzaGVkKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmV4aXN0aW5nO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgY29udGFpbnNVbmlxdWVLZXkgPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pO1xuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICByZWFzb246ICdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBjb25kaXRpb24gdG8gYmUgY29udGFpbmluZyB1bmlxdWUga2V5LicsXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBpc1VwZGF0aW5nID8gY29udGV4dC51cGRhdGVPcHRpb25zIDogY29udGV4dC5jcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpKSB7XG4gICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieVBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3lcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHJhd1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUocmF3W2ZpZWxkTmFtZV0sIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8IGVycm9yLnN0YWNrIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnR0aXkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmIChlcnJvci5zdGF0dXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgYEVycm9yIG9jY3VycmVkIGR1cmluZyBhcHBseWluZyBmZWF0dXJlcyBydWxlcyB0byBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLiBEZXRhaWw6IGAgKyBlcnJvci5tZXNzYWdlLFxuICAgICAgICAgICAgICAgIHsgZXJyb3I6IGVycm9yIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcblxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiBpbnB1dCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgWyBzdGFnZSwgZmllbGQgXSA9IGQuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAoc3RhZ2UgPT09ICdsYXRlc3QnIHx8IHN0YWdlID09PSAnZXhpc3RuZycpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnRyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kaGF2aW5nKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kaGF2aW5nID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxldGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29sVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYpID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS5tYXAodiA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==