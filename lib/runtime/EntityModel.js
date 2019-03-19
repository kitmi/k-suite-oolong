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

    if (findOptions.$association && !findOptions.$relationships) {
      findOptions.$relationships = this._prepareAssociations(findOptions);
    }

    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$relationships && !findOptions.$skipOrm) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$relationships);
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

    if (findOptions.$association && !findOptions.$relationships) {
      findOptions.$relationships = this._prepareAssociations(findOptions);
    }

    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$relationships) {
        if (findOptions.$totalCount) {
          totalCount = records[3];
        }

        if (!findOptions.$skipOrm) {
          records = this._mapRecordsToObjects(records, findOptions.$relationships);
        } else {
          records = records[0];
        }
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
          records = records[0];
        }
      }

      return this.afterFindAll_(context, records);
    }, context);

    if (findOptions.$totalCount) {
      let ret = {
        totalItems: totalCount,
        items: rows
      };

      if (!isNothing(findOptions.$offset)) {
        ret.offset = findOptions.$offset;
      }

      if (!isNothing(findOptions.$limit)) {
        ret.limit = findOptions.$limit;
      }

      return ret;
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

  static async updateOne_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$byPassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$byPassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, true);
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

    if (updateOptions.$association && !updateOptions.$relationships) {
      updateOptions.$relationships = this._prepareAssociations(updateOptions);
    }

    let context = {
      raw: data,
      updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);
      await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.updateOptions.$query, context.updateOptions, context.connOptions);
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
    let hasKeyNameOnly = false;

    let hasNotNullKey = _.find(this.meta.uniqueKeys, fields => {
      let hasKeys = _.every(fields, f => f in data);

      hasKeyNameOnly = hasKeyNameOnly || hasKeys;
      return _.every(fields, f => !_.isNil(data[f]));
    });

    return [hasNotNullKey, hasKeyNameOnly];
  }

  static _ensureContainsUniqueKey(condition) {
    let [containsUniqueKeyAndValue, containsUniqueKeyOnly] = this._containsUniqueKey(condition);

    if (!containsUniqueKeyAndValue) {
      if (containsUniqueKeyOnly) {
        throw new DataValidationError('One of the unique field as query condition is null.');
      }

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

    if (forSingleRecord && !options.$byPassEnsureUnique) {
      this._ensureContainsUniqueKey(normalizedOptions.$query);
    }

    normalizedOptions.$query = this.translateValue(normalizedOptions.$query, normalizedOptions.$variables);

    if (normalizedOptions.$groupBy) {
      if (_.isPlainObject(normalizedOptions.$groupBy)) {
        if (normalizedOptions.$groupBy.having) {
          normalizedOptions.$groupBy.having = this.translateValue(normalizedOptions.$groupBy.having, normalizedOptions.$variables);
        }
      }
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

        throw new Error('Not impletemented yet. ' + value.oorType);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJEc09wZXJhdGlvbkVycm9yIiwiQnVzaW5lc3NFcnJvciIsIkZlYXR1cmVzIiwiUnVsZXMiLCJpc05vdGhpbmciLCJORUVEX09WRVJSSURFIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCIkcGtWYWx1ZXMiLCJwaWNrIiwiY2FzdEFycmF5IiwibWV0YSIsImtleUZpZWxkIiwicG9wdWxhdGUiLCJkYXRhIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJjYWNoZWRfIiwiX2NhY2hlZERhdGEiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJjb250ZXh0IiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwiJGFzc29jaWF0aW9uIiwiJHJlbGF0aW9uc2hpcHMiLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZGIiLCJjb25uZWN0b3IiLCJmaW5kXyIsIm5hbWUiLCIkc2tpcE9ybSIsImxlbmd0aCIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsImFzc29jaWF0aW9ucyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImlzRW1wdHkiLCJjb25uZWN0aW9uIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwibGF0ZXN0IiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieVBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwidXBkYXRlXyIsImFmdGVyVXBkYXRlXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsIm5vdEZpbmlzaGVkIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiYmVmb3JlRGVsZXRlXyIsImRlbGV0ZV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsInN0YXR1cyIsImFwcGx5TW9kaWZpZXJzXyIsInRyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsInNwbGl0IiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2IiwiayIsIm9wdGlvbnMiLCJBcnJheSIsImlzQXJyYXkiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5UGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJ2YWx1ZSIsInZhcmlhYmxlcyIsIm9vclR5cGUiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwicHVzaCIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIm1hcFZhbHVlcyIsIm1hcCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBb0JGLE9BQU8sQ0FBQyxVQUFELENBQWpDOztBQUNBLE1BQU1HLE1BQU0sR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBQ0EsTUFBTUksVUFBVSxHQUFHSixPQUFPLENBQUMsY0FBRCxD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LFNBQXZCLENBQTFCLENBQVA7QUFDSDs7QUFFRCxRQUFJZCxLQUFLLENBQUNDLE9BQU4sQ0FBY1ksS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLGFBQU9BLEtBQUssQ0FBQ1UsR0FBTixDQUFVMUIsQ0FBQyxJQUFJLEtBQUtuQixjQUFMLENBQW9CbUIsQ0FBcEIsRUFBdUJpQixTQUF2QixDQUFmLENBQVA7QUFDSDs7QUFFRCxXQUFPLEtBQUtGLFVBQUwsQ0FBZ0JDLEtBQWhCLENBQVA7QUFDSDs7QUFoMEJhOztBQW0wQmxCVyxNQUFNLENBQUNDLE9BQVAsR0FBaUI5SyxXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18gfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IsIE9vbG9uZ1VzYWdlRXJyb3IsIERzT3BlcmF0aW9uRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogR2V0IGFuIG9iamVjdCBvZiB0aGUgcHJpbWFyeSBrZXkgdmFsdWVzLlxuICAgICAqL1xuICAgIGdldCAkcGtWYWx1ZXMoKSB7XG4gICAgICAgIHJldHVybiBfLnBpY2sodGhpcywgXy5jYXN0QXJyYXkodGhpcy5jb25zdHJ1Y3Rvci5tZXRhLmtleUZpZWxkKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9wdWxhdGUgZGF0YSBmcm9tIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcmV0dXJuIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgcG9wdWxhdGUoZGF0YSkge1xuICAgICAgICBsZXQgTW9kZWxDbGFzcyA9IHRoaXM7XG4gICAgICAgIHJldHVybiBuZXcgTW9kZWxDbGFzcyhkYXRhKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiBfLmlzUGxhaW5PYmplY3QoZGF0YSk7ICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKCkge1xuICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHRvRGljdGlvbmFyeTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9jYWNoZWREYXRhO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgLypcbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlTWFueV8ocmVjb3JkcywgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICByZWNvcmRzLmZvckVhY2goZGF0YSA9PiB7XG4gICAgICAgICAgICBcblxuXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfSovXG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhdXBkYXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnModXBkYXRlT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBwcmU6IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBub3RGaW5pc2hlZCA9IGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCk7ICAgICBcbiAgICAgICAgaWYgKCFub3RGaW5pc2hlZCkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5kZWxldGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5leGlzdGluZztcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBpZiAoZXJyb3Iuc3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgIGBFcnJvciBvY2N1cnJlZCBkdXJpbmcgYXBwbHlpbmcgZmVhdHVyZXMgcnVsZXMgdG8gZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi4gRGV0YWlsOiBgICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICB7IGVycm9yOiBlcnJvciB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieVBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGV0ZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodikgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19