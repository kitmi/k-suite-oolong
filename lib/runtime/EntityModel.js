"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const {
  _,
  eachAsync_,
  getValueByPath
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

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath.split('.').map(p => ':' + p).join('.'));
  }

  static async cached_(key) {
    if (key) {
      let cachedData;

      if (!this._cachedDataAltKey) {
        this._cachedDataAltKey = {};
      } else if (this._cachedDataAltKey[key]) {
        cachedData = this._cachedDataAltKey[key];
      }

      if (!cachedData) {
        cachedData = this._cachedDataAltKey[key] = await this.findAll_({
          $toDictionary: key
        });
      }

      return cachedData;
    }

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
      await this.beforeCreate_(context);

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

      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }

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
      if (forSingleRecord) {
        await this.beforeDelete_(context);
      } else {
        await this.beforeDeleteMany_(context);
      }

      context.result = await this.db.connector.delete_(this.meta.name, context.deleteOptions.$query, context.connOptions);

      if (forSingleRecord) {
        await this.afterDelete_(context);
      } else {
        await this.afterDeleteMany_(context);
      }

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
        throw new DataValidationError('One of the unique key field as query condition is null.');
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
    latest = context.latest = this.translateValue(latest, opOptions.$variables, true);

    try {
      await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);
    } catch (error) {
      if (error.status) {
        throw error;
      }

      throw new DsOperationError(`Error occurred during applying feature rules to entity "${this.meta.name}". Detail: ` + error.message, {
        error: error
      });
    }

    await this.applyModifiers_(context, isUpdating);
    context.latest = _.mapValues(latest, (value, key) => {
      let fieldInfo = fields[key];

      if (!fieldInfo) {
        throw new Error("Assertion failed: fieldInfo");
      }

      return this._serializeByType(value, fieldInfo);
    });
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

  static translateValue(value, variables, skipSerialize) {
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

    if (skipSerialize) return value;
    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsIiRwa1ZhbHVlcyIsInBpY2siLCJjYXN0QXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwb3B1bGF0ZSIsImRhdGEiLCJNb2RlbENsYXNzIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsImZpbmQiLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzUGxhaW5PYmplY3QiLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJzcGxpdCIsIm1hcCIsInAiLCJqb2luIiwiY2FjaGVkXyIsImtleSIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YUFsdEtleSIsImZpbmRBbGxfIiwiJHRvRGljdGlvbmFyeSIsIl9jYWNoZWREYXRhIiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsImNvbm5PcHRpb25zIiwiX3ByZXBhcmVRdWVyaWVzIiwiY29udGV4dCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIiRhc3NvY2lhdGlvbiIsIiRyZWxhdGlvbnNoaXBzIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImRiIiwiY29ubmVjdG9yIiwiZmluZF8iLCJuYW1lIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJhc3NvY2lhdGlvbnMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJpc0VtcHR5IiwiYmVmb3JlQ3JlYXRlXyIsImNvbm5lY3Rpb24iLCJiZWdpblRyYW5zYWN0aW9uXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJsYXRlc3QiLCJhZnRlckNyZWF0ZV8iLCJfY3JlYXRlQXNzb2NzXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsIm9taXQiLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJ1cGRhdGVfIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsIm5vdEZpbmlzaGVkIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsInRyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsInN0YXR1cyIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsInZhbHVlIiwiX3NlcmlhbGl6ZUJ5VHlwZSIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwiQXJyYXkiLCJpc0FycmF5Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieVBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiRXJyb3IiLCJhc3NvY3MiLCJfdHJhbnNsYXRlU3ltYm9sVG9rZW4iLCJfc2VyaWFsaXplIiwidmFyaWFibGVzIiwic2tpcFNlcmlhbGl6ZSIsIm9vclR5cGUiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwicHVzaCIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DSCxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNSSxNQUFNLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLG1CQUFGO0FBQXVCQyxFQUFBQSxnQkFBdkI7QUFBeUNDLEVBQUFBLGdCQUF6QztBQUEyREMsRUFBQUE7QUFBM0QsSUFBNkVOLE1BQW5GOztBQUNBLE1BQU1PLFFBQVEsR0FBR1gsT0FBTyxDQUFDLGtCQUFELENBQXhCOztBQUNBLE1BQU1ZLEtBQUssR0FBR1osT0FBTyxDQUFDLGVBQUQsQ0FBckI7O0FBRUEsTUFBTTtBQUFFYSxFQUFBQTtBQUFGLElBQWdCYixPQUFPLENBQUMsZUFBRCxDQUE3Qjs7QUFFQSxNQUFNYyxhQUFhLEdBQUcsa0RBQXRCOztBQU1BLE1BQU1DLFdBQU4sQ0FBa0I7QUFJZEMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVU7QUFDakIsUUFBSUEsT0FBSixFQUFhO0FBRVRDLE1BQUFBLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjLElBQWQsRUFBb0JGLE9BQXBCO0FBQ0g7QUFDSjs7QUFLRCxNQUFJRyxTQUFKLEdBQWdCO0FBQ1osV0FBT25CLENBQUMsQ0FBQ29CLElBQUYsQ0FBTyxJQUFQLEVBQWFwQixDQUFDLENBQUNxQixTQUFGLENBQVksS0FBS04sV0FBTCxDQUFpQk8sSUFBakIsQ0FBc0JDLFFBQWxDLENBQWIsQ0FBUDtBQUNIOztBQU9ELFNBQU9DLFFBQVAsQ0FBZ0JDLElBQWhCLEVBQXNCO0FBQ2xCLFFBQUlDLFVBQVUsR0FBRyxJQUFqQjtBQUNBLFdBQU8sSUFBSUEsVUFBSixDQUFlRCxJQUFmLENBQVA7QUFDSDs7QUFNRCxTQUFPRSxzQkFBUCxDQUE4QkYsSUFBOUIsRUFBb0M7QUFDaEMsV0FBT3pCLENBQUMsQ0FBQzRCLElBQUYsQ0FBTyxLQUFLTixJQUFMLENBQVVPLFVBQWpCLEVBQTZCQyxNQUFNLElBQUk5QixDQUFDLENBQUMrQixLQUFGLENBQVFELE1BQVIsRUFBZ0JFLENBQUMsSUFBSSxDQUFDaEMsQ0FBQyxDQUFDaUMsS0FBRixDQUFRUixJQUFJLENBQUNPLENBQUQsQ0FBWixDQUF0QixDQUF2QyxDQUFQO0FBQ0g7O0FBTUQsU0FBT0UsMEJBQVAsQ0FBa0NULElBQWxDLEVBQXdDO0FBQUEsU0FDL0J6QixDQUFDLENBQUNtQyxhQUFGLENBQWdCVixJQUFoQixDQUQrQjtBQUFBO0FBQUE7O0FBR3BDLFFBQUlXLFFBQVEsR0FBRyxLQUFLVCxzQkFBTCxDQUE0QkYsSUFBNUIsQ0FBZjtBQUNBLFdBQU96QixDQUFDLENBQUNvQixJQUFGLENBQU9LLElBQVAsRUFBYVcsUUFBYixDQUFQO0FBQ0g7O0FBRUQsU0FBT0MsZUFBUCxDQUF1QkMsU0FBdkIsRUFBa0NDLE9BQWxDLEVBQTJDO0FBQ3ZDLFdBQU9yQyxjQUFjLENBQUNvQyxTQUFELEVBQVlDLE9BQU8sQ0FBQ0MsS0FBUixDQUFjLEdBQWQsRUFBbUJDLEdBQW5CLENBQXVCQyxDQUFDLElBQUksTUFBSUEsQ0FBaEMsRUFBbUNDLElBQW5DLENBQXdDLEdBQXhDLENBQVosQ0FBckI7QUFDSDs7QUFLRCxlQUFhQyxPQUFiLENBQXFCQyxHQUFyQixFQUEwQjtBQUN0QixRQUFJQSxHQUFKLEVBQVM7QUFDTCxVQUFJQyxVQUFKOztBQUVBLFVBQUksQ0FBQyxLQUFLQyxpQkFBVixFQUE2QjtBQUN6QixhQUFLQSxpQkFBTCxHQUF5QixFQUF6QjtBQUNILE9BRkQsTUFFTyxJQUFJLEtBQUtBLGlCQUFMLENBQXVCRixHQUF2QixDQUFKLEVBQWlDO0FBQ3BDQyxRQUFBQSxVQUFVLEdBQUcsS0FBS0MsaUJBQUwsQ0FBdUJGLEdBQXZCLENBQWI7QUFDSDs7QUFFRCxVQUFJLENBQUNDLFVBQUwsRUFBaUI7QUFDYkEsUUFBQUEsVUFBVSxHQUFHLEtBQUtDLGlCQUFMLENBQXVCRixHQUF2QixJQUE4QixNQUFNLEtBQUtHLFFBQUwsQ0FBYztBQUFFQyxVQUFBQSxhQUFhLEVBQUVKO0FBQWpCLFNBQWQsQ0FBakQ7QUFDSDs7QUFFRCxhQUFPQyxVQUFQO0FBQ0g7O0FBRUQsUUFBSSxDQUFDLEtBQUtJLFdBQVYsRUFBdUI7QUFDbkIsV0FBS0EsV0FBTCxHQUFtQixNQUFNLEtBQUtGLFFBQUwsQ0FBYztBQUFFQyxRQUFBQSxhQUFhLEVBQUU7QUFBakIsT0FBZCxDQUF6QjtBQUNIOztBQUVELFdBQU8sS0FBS0MsV0FBWjtBQUNIOztBQWtCRCxlQUFhQyxRQUFiLENBQXNCQyxXQUF0QixFQUFtQ0MsV0FBbkMsRUFBZ0Q7QUFBQSxTQUN2Q0QsV0FEdUM7QUFBQTtBQUFBOztBQUc1Q0EsSUFBQUEsV0FBVyxHQUFHLEtBQUtFLGVBQUwsQ0FBcUJGLFdBQXJCLEVBQWtDLElBQWxDLENBQWQ7QUFFQSxRQUFJRyxPQUFPLEdBQUc7QUFDVkgsTUFBQUEsV0FEVTtBQUVWQyxNQUFBQTtBQUZVLEtBQWQ7QUFLQSxVQUFNM0MsUUFBUSxDQUFDOEMsV0FBVCxDQUFxQjdDLEtBQUssQ0FBQzhDLGdCQUEzQixFQUE2QyxJQUE3QyxFQUFtREYsT0FBbkQsQ0FBTjs7QUFFQSxRQUFJSCxXQUFXLENBQUNNLFlBQVosSUFBNEIsQ0FBQ04sV0FBVyxDQUFDTyxjQUE3QyxFQUE2RDtBQUN6RFAsTUFBQUEsV0FBVyxDQUFDTyxjQUFaLEdBQTZCLEtBQUtDLG9CQUFMLENBQTBCUixXQUExQixDQUE3QjtBQUNIOztBQUVELFdBQU8sS0FBS1MsYUFBTCxDQUFtQixNQUFPTixPQUFQLElBQW1CO0FBQ3pDLFVBQUlPLE9BQU8sR0FBRyxNQUFNLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsS0FBbEIsQ0FDaEIsS0FBSzNDLElBQUwsQ0FBVTRDLElBRE0sRUFFaEJYLE9BQU8sQ0FBQ0gsV0FGUSxFQUdoQkcsT0FBTyxDQUFDRixXQUhRLENBQXBCO0FBS0EsVUFBSSxDQUFDUyxPQUFMLEVBQWMsTUFBTSxJQUFJdEQsZ0JBQUosQ0FBcUIsa0RBQXJCLENBQU47O0FBRWQsVUFBSTRDLFdBQVcsQ0FBQ08sY0FBWixJQUE4QixDQUFDUCxXQUFXLENBQUNlLFFBQS9DLEVBQXlEO0FBRXJELFlBQUlMLE9BQU8sQ0FBQyxDQUFELENBQVAsQ0FBV00sTUFBWCxLQUFzQixDQUExQixFQUE2QixPQUFPQyxTQUFQO0FBRTdCUCxRQUFBQSxPQUFPLEdBQUcsS0FBS1Esb0JBQUwsQ0FBMEJSLE9BQTFCLEVBQW1DVixXQUFXLENBQUNPLGNBQS9DLENBQVY7QUFDSCxPQUxELE1BS08sSUFBSUcsT0FBTyxDQUFDTSxNQUFSLEtBQW1CLENBQXZCLEVBQTBCO0FBQzdCLGVBQU9DLFNBQVA7QUFDSDs7QUFmd0MsWUFpQmpDUCxPQUFPLENBQUNNLE1BQVIsS0FBbUIsQ0FqQmM7QUFBQTtBQUFBOztBQWtCekMsVUFBSUcsTUFBTSxHQUFHVCxPQUFPLENBQUMsQ0FBRCxDQUFwQjtBQUVBLGFBQU9TLE1BQVA7QUFDSCxLQXJCTSxFQXFCSmhCLE9BckJJLENBQVA7QUFzQkg7O0FBa0JELGVBQWFQLFFBQWIsQ0FBc0JJLFdBQXRCLEVBQW1DQyxXQUFuQyxFQUFnRDtBQUM1Q0QsSUFBQUEsV0FBVyxHQUFHLEtBQUtFLGVBQUwsQ0FBcUJGLFdBQXJCLENBQWQ7QUFFQSxRQUFJRyxPQUFPLEdBQUc7QUFDVkgsTUFBQUEsV0FEVTtBQUVWQyxNQUFBQTtBQUZVLEtBQWQ7QUFLQSxVQUFNM0MsUUFBUSxDQUFDOEMsV0FBVCxDQUFxQjdDLEtBQUssQ0FBQzhDLGdCQUEzQixFQUE2QyxJQUE3QyxFQUFtREYsT0FBbkQsQ0FBTjs7QUFFQSxRQUFJSCxXQUFXLENBQUNNLFlBQVosSUFBNEIsQ0FBQ04sV0FBVyxDQUFDTyxjQUE3QyxFQUE2RDtBQUN6RFAsTUFBQUEsV0FBVyxDQUFDTyxjQUFaLEdBQTZCLEtBQUtDLG9CQUFMLENBQTBCUixXQUExQixDQUE3QjtBQUNIOztBQUVELFFBQUlvQixVQUFKO0FBRUEsUUFBSUMsSUFBSSxHQUFHLE1BQU0sS0FBS1osYUFBTCxDQUFtQixNQUFPTixPQUFQLElBQW1CO0FBQ25ELFVBQUlPLE9BQU8sR0FBRyxNQUFNLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsS0FBbEIsQ0FDaEIsS0FBSzNDLElBQUwsQ0FBVTRDLElBRE0sRUFFaEJYLE9BQU8sQ0FBQ0gsV0FGUSxFQUdoQkcsT0FBTyxDQUFDRixXQUhRLENBQXBCO0FBTUEsVUFBSSxDQUFDUyxPQUFMLEVBQWMsTUFBTSxJQUFJdEQsZ0JBQUosQ0FBcUIsa0RBQXJCLENBQU47O0FBRWQsVUFBSTRDLFdBQVcsQ0FBQ08sY0FBaEIsRUFBZ0M7QUFDNUIsWUFBSVAsV0FBVyxDQUFDc0IsV0FBaEIsRUFBNkI7QUFDekJGLFVBQUFBLFVBQVUsR0FBR1YsT0FBTyxDQUFDLENBQUQsQ0FBcEI7QUFDSDs7QUFFRCxZQUFJLENBQUNWLFdBQVcsQ0FBQ2UsUUFBakIsRUFBMkI7QUFDdkJMLFVBQUFBLE9BQU8sR0FBRyxLQUFLUSxvQkFBTCxDQUEwQlIsT0FBMUIsRUFBbUNWLFdBQVcsQ0FBQ08sY0FBL0MsQ0FBVjtBQUNILFNBRkQsTUFFTztBQUNIRyxVQUFBQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQyxDQUFELENBQWpCO0FBQ0g7QUFDSixPQVZELE1BVU87QUFDSCxZQUFJVixXQUFXLENBQUNzQixXQUFoQixFQUE2QjtBQUN6QkYsVUFBQUEsVUFBVSxHQUFHVixPQUFPLENBQUMsQ0FBRCxDQUFwQjtBQUNBQSxVQUFBQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQyxDQUFELENBQWpCO0FBQ0g7QUFDSjs7QUFFRCxhQUFPLEtBQUthLGFBQUwsQ0FBbUJwQixPQUFuQixFQUE0Qk8sT0FBNUIsQ0FBUDtBQUNILEtBM0JnQixFQTJCZFAsT0EzQmMsQ0FBakI7O0FBNkJBLFFBQUlILFdBQVcsQ0FBQ3NCLFdBQWhCLEVBQTZCO0FBQ3pCLFVBQUlFLEdBQUcsR0FBRztBQUFFQyxRQUFBQSxVQUFVLEVBQUVMLFVBQWQ7QUFBMEJNLFFBQUFBLEtBQUssRUFBRUw7QUFBakMsT0FBVjs7QUFFQSxVQUFJLENBQUM3RCxTQUFTLENBQUN3QyxXQUFXLENBQUMyQixPQUFiLENBQWQsRUFBcUM7QUFDakNILFFBQUFBLEdBQUcsQ0FBQ0ksTUFBSixHQUFhNUIsV0FBVyxDQUFDMkIsT0FBekI7QUFDSDs7QUFFRCxVQUFJLENBQUNuRSxTQUFTLENBQUN3QyxXQUFXLENBQUM2QixNQUFiLENBQWQsRUFBb0M7QUFDaENMLFFBQUFBLEdBQUcsQ0FBQ00sS0FBSixHQUFZOUIsV0FBVyxDQUFDNkIsTUFBeEI7QUFDSDs7QUFFRCxhQUFPTCxHQUFQO0FBQ0g7O0FBRUQsV0FBT0gsSUFBUDtBQUNIOztBQVdELGVBQWFVLE9BQWIsQ0FBcUIxRCxJQUFyQixFQUEyQjJELGFBQTNCLEVBQTBDL0IsV0FBMUMsRUFBdUQ7QUFDbkQrQixJQUFBQSxhQUFhLEtBQUtBLGFBQWEsR0FBRyxFQUFyQixDQUFiOztBQUVBLFFBQUksQ0FBRUMsR0FBRixFQUFPQyxZQUFQLElBQXdCLEtBQUtDLG9CQUFMLENBQTBCOUQsSUFBMUIsQ0FBNUI7O0FBRUEsUUFBSThCLE9BQU8sR0FBRztBQUNWOEIsTUFBQUEsR0FEVTtBQUVWRCxNQUFBQSxhQUZVO0FBR1YvQixNQUFBQTtBQUhVLEtBQWQ7QUFNQSxRQUFJbUMsZ0JBQWdCLEdBQUcsS0FBdkI7O0FBRUEsUUFBSSxDQUFDeEYsQ0FBQyxDQUFDeUYsT0FBRixDQUFVSCxZQUFWLENBQUwsRUFBOEI7QUFDMUJFLE1BQUFBLGdCQUFnQixHQUFHLElBQW5CO0FBQ0g7O0FBRUQsV0FBTyxLQUFLM0IsYUFBTCxDQUFtQixNQUFPTixPQUFQLElBQW1CO0FBQ3pDLFlBQU0sS0FBS21DLGFBQUwsQ0FBbUJuQyxPQUFuQixDQUFOOztBQUVBLFVBQUlpQyxnQkFBSixFQUFzQjtBQUNsQixZQUFJLENBQUNqQyxPQUFPLENBQUNGLFdBQVQsSUFBd0IsQ0FBQ0UsT0FBTyxDQUFDRixXQUFSLENBQW9Cc0MsVUFBakQsRUFBNkQ7QUFDekRwQyxVQUFBQSxPQUFPLENBQUNGLFdBQVIsS0FBd0JFLE9BQU8sQ0FBQ0YsV0FBUixHQUFzQixFQUE5QztBQUVBRSxVQUFBQSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JzQyxVQUFwQixHQUFpQyxNQUFNLEtBQUs1QixFQUFMLENBQVFDLFNBQVIsQ0FBa0I0QixpQkFBbEIsRUFBdkM7QUFDSDtBQUNKOztBQUVELFlBQU0sS0FBS0MsbUJBQUwsQ0FBeUJ0QyxPQUF6QixDQUFOO0FBRUEsWUFBTTdDLFFBQVEsQ0FBQzhDLFdBQVQsQ0FBcUI3QyxLQUFLLENBQUNtRixrQkFBM0IsRUFBK0MsSUFBL0MsRUFBcUR2QyxPQUFyRCxDQUFOO0FBRUFBLE1BQUFBLE9BQU8sQ0FBQ2dCLE1BQVIsR0FBaUIsTUFBTSxLQUFLUixFQUFMLENBQVFDLFNBQVIsQ0FBa0JtQixPQUFsQixDQUNuQixLQUFLN0QsSUFBTCxDQUFVNEMsSUFEUyxFQUVuQlgsT0FBTyxDQUFDd0MsTUFGVyxFQUduQnhDLE9BQU8sQ0FBQ0YsV0FIVyxDQUF2QjtBQU1BLFlBQU0sS0FBSzJDLFlBQUwsQ0FBa0J6QyxPQUFsQixDQUFOOztBQUVBLFVBQUlpQyxnQkFBSixFQUFzQjtBQUNsQixjQUFNLEtBQUtTLGNBQUwsQ0FBb0IxQyxPQUFwQixFQUE2QitCLFlBQTdCLENBQU47QUFDSDs7QUFFRCxhQUFPL0IsT0FBTyxDQUFDd0MsTUFBZjtBQUNILEtBNUJNLEVBNEJKeEMsT0E1QkksQ0FBUDtBQTZCSDs7QUEwRUQsZUFBYTJDLFVBQWIsQ0FBd0J6RSxJQUF4QixFQUE4QjBFLGFBQTlCLEVBQTZDOUMsV0FBN0MsRUFBMEQ7QUFDdEQsUUFBSThDLGFBQWEsSUFBSUEsYUFBYSxDQUFDQyxlQUFuQyxFQUFvRDtBQUNoRCxZQUFNLElBQUk3RixnQkFBSixDQUFxQixtQkFBckIsRUFBMEM7QUFDNUM4RixRQUFBQSxNQUFNLEVBQUUsS0FBSy9FLElBQUwsQ0FBVTRDLElBRDBCO0FBRTVDb0MsUUFBQUEsTUFBTSxFQUFFLDJFQUZvQztBQUc1Q0gsUUFBQUE7QUFINEMsT0FBMUMsQ0FBTjtBQUtIOztBQUVELFdBQU8sS0FBS0ksUUFBTCxDQUFjOUUsSUFBZCxFQUFvQjBFLGFBQXBCLEVBQW1DOUMsV0FBbkMsRUFBZ0QsSUFBaEQsQ0FBUDtBQUNIOztBQVFELGVBQWFtRCxXQUFiLENBQXlCL0UsSUFBekIsRUFBK0IwRSxhQUEvQixFQUE4QzlDLFdBQTlDLEVBQTJEO0FBQ3ZELFFBQUk4QyxhQUFhLElBQUlBLGFBQWEsQ0FBQ0MsZUFBbkMsRUFBb0Q7QUFDaEQsWUFBTSxJQUFJN0YsZ0JBQUosQ0FBcUIsbUJBQXJCLEVBQTBDO0FBQzVDOEYsUUFBQUEsTUFBTSxFQUFFLEtBQUsvRSxJQUFMLENBQVU0QyxJQUQwQjtBQUU1Q29DLFFBQUFBLE1BQU0sRUFBRSwyRUFGb0M7QUFHNUNILFFBQUFBO0FBSDRDLE9BQTFDLENBQU47QUFLSDs7QUFFRCxXQUFPLEtBQUtJLFFBQUwsQ0FBYzlFLElBQWQsRUFBb0IwRSxhQUFwQixFQUFtQzlDLFdBQW5DLEVBQWdELEtBQWhELENBQVA7QUFDSDs7QUFFRCxlQUFha0QsUUFBYixDQUFzQjlFLElBQXRCLEVBQTRCMEUsYUFBNUIsRUFBMkM5QyxXQUEzQyxFQUF3RG9ELGVBQXhELEVBQXlFO0FBQ3JFLFFBQUksQ0FBQ04sYUFBTCxFQUFvQjtBQUNoQixVQUFJTyxlQUFlLEdBQUcsS0FBSy9FLHNCQUFMLENBQTRCRixJQUE1QixDQUF0Qjs7QUFDQSxVQUFJekIsQ0FBQyxDQUFDeUYsT0FBRixDQUFVaUIsZUFBVixDQUFKLEVBQWdDO0FBQzVCLGNBQU0sSUFBSW5HLGdCQUFKLENBQXFCLHVHQUFyQixDQUFOO0FBQ0g7O0FBQ0Q0RixNQUFBQSxhQUFhLEdBQUc7QUFBRVEsUUFBQUEsTUFBTSxFQUFFM0csQ0FBQyxDQUFDb0IsSUFBRixDQUFPSyxJQUFQLEVBQWFpRixlQUFiO0FBQVYsT0FBaEI7QUFDQWpGLE1BQUFBLElBQUksR0FBR3pCLENBQUMsQ0FBQzRHLElBQUYsQ0FBT25GLElBQVAsRUFBYWlGLGVBQWIsQ0FBUDtBQUNIOztBQUVEUCxJQUFBQSxhQUFhLEdBQUcsS0FBSzdDLGVBQUwsQ0FBcUI2QyxhQUFyQixFQUFvQ00sZUFBcEMsQ0FBaEI7O0FBRUEsUUFBSU4sYUFBYSxDQUFDekMsWUFBZCxJQUE4QixDQUFDeUMsYUFBYSxDQUFDeEMsY0FBakQsRUFBaUU7QUFDN0R3QyxNQUFBQSxhQUFhLENBQUN4QyxjQUFkLEdBQStCLEtBQUtDLG9CQUFMLENBQTBCdUMsYUFBMUIsQ0FBL0I7QUFDSDs7QUFFRCxRQUFJNUMsT0FBTyxHQUFHO0FBQ1Y4QixNQUFBQSxHQUFHLEVBQUU1RCxJQURLO0FBRVYwRSxNQUFBQSxhQUZVO0FBR1Y5QyxNQUFBQTtBQUhVLEtBQWQ7QUFNQSxXQUFPLEtBQUtRLGFBQUwsQ0FBbUIsTUFBT04sT0FBUCxJQUFtQjtBQUN6QyxZQUFNLEtBQUtzQyxtQkFBTCxDQUF5QnRDLE9BQXpCLEVBQWtDLElBQWxDLENBQU47QUFFQSxZQUFNN0MsUUFBUSxDQUFDOEMsV0FBVCxDQUFxQjdDLEtBQUssQ0FBQ2tHLGtCQUEzQixFQUErQyxJQUEvQyxFQUFxRHRELE9BQXJELENBQU47QUFFQUEsTUFBQUEsT0FBTyxDQUFDZ0IsTUFBUixHQUFpQixNQUFNLEtBQUtSLEVBQUwsQ0FBUUMsU0FBUixDQUFrQjhDLE9BQWxCLENBQ25CLEtBQUt4RixJQUFMLENBQVU0QyxJQURTLEVBRW5CWCxPQUFPLENBQUN3QyxNQUZXLEVBR25CeEMsT0FBTyxDQUFDNEMsYUFBUixDQUFzQlEsTUFISCxFQUluQnBELE9BQU8sQ0FBQzRDLGFBSlcsRUFLbkI1QyxPQUFPLENBQUNGLFdBTFcsQ0FBdkI7O0FBUUEsVUFBSW9ELGVBQUosRUFBcUI7QUFDakIsY0FBTSxLQUFLTSxZQUFMLENBQWtCeEQsT0FBbEIsQ0FBTjtBQUNILE9BRkQsTUFFTztBQUNILGNBQU0sS0FBS3lELGdCQUFMLENBQXNCekQsT0FBdEIsQ0FBTjtBQUNIOztBQUVELGFBQU9BLE9BQU8sQ0FBQ3dDLE1BQWY7QUFDSCxLQXBCTSxFQW9CSnhDLE9BcEJJLENBQVA7QUFxQkg7O0FBV0QsZUFBYTBELFVBQWIsQ0FBd0JDLGFBQXhCLEVBQXVDN0QsV0FBdkMsRUFBb0Q7QUFDaEQsV0FBTyxLQUFLOEQsUUFBTCxDQUFjRCxhQUFkLEVBQTZCN0QsV0FBN0IsRUFBMEMsSUFBMUMsQ0FBUDtBQUNIOztBQVdELGVBQWErRCxXQUFiLENBQXlCRixhQUF6QixFQUF3QzdELFdBQXhDLEVBQXFEO0FBQ2pELFdBQU8sS0FBSzhELFFBQUwsQ0FBY0QsYUFBZCxFQUE2QjdELFdBQTdCLEVBQTBDLEtBQTFDLENBQVA7QUFDSDs7QUFXRCxlQUFhOEQsUUFBYixDQUFzQkQsYUFBdEIsRUFBcUM3RCxXQUFyQyxFQUFrRG9ELGVBQWxELEVBQW1FO0FBQUEsU0FDMURTLGFBRDBEO0FBQUE7QUFBQTs7QUFHL0RBLElBQUFBLGFBQWEsR0FBRyxLQUFLNUQsZUFBTCxDQUFxQjRELGFBQXJCLEVBQW9DVCxlQUFwQyxDQUFoQjs7QUFFQSxRQUFJekcsQ0FBQyxDQUFDeUYsT0FBRixDQUFVeUIsYUFBYSxDQUFDUCxNQUF4QixDQUFKLEVBQXFDO0FBQ2pDLFlBQU0sSUFBSXBHLGdCQUFKLENBQXFCLHdEQUFyQixDQUFOO0FBQ0g7O0FBRUQsUUFBSWdELE9BQU8sR0FBRztBQUNWMkQsTUFBQUEsYUFEVTtBQUVWN0QsTUFBQUE7QUFGVSxLQUFkO0FBS0EsUUFBSWdFLFdBQVcsR0FBRyxNQUFNM0csUUFBUSxDQUFDOEMsV0FBVCxDQUFxQjdDLEtBQUssQ0FBQzJHLGtCQUEzQixFQUErQyxJQUEvQyxFQUFxRC9ELE9BQXJELENBQXhCOztBQUNBLFFBQUksQ0FBQzhELFdBQUwsRUFBa0I7QUFDZCxhQUFPOUQsT0FBTyxDQUFDd0MsTUFBZjtBQUNIOztBQUVELFdBQU8sS0FBS2xDLGFBQUwsQ0FBbUIsTUFBT04sT0FBUCxJQUFtQjtBQUN6QyxVQUFJa0QsZUFBSixFQUFxQjtBQUNqQixjQUFNLEtBQUtjLGFBQUwsQ0FBbUJoRSxPQUFuQixDQUFOO0FBQ0gsT0FGRCxNQUVPO0FBQ0gsY0FBTSxLQUFLaUUsaUJBQUwsQ0FBdUJqRSxPQUF2QixDQUFOO0FBQ0g7O0FBRURBLE1BQUFBLE9BQU8sQ0FBQ2dCLE1BQVIsR0FBaUIsTUFBTSxLQUFLUixFQUFMLENBQVFDLFNBQVIsQ0FBa0J5RCxPQUFsQixDQUNuQixLQUFLbkcsSUFBTCxDQUFVNEMsSUFEUyxFQUVuQlgsT0FBTyxDQUFDMkQsYUFBUixDQUFzQlAsTUFGSCxFQUduQnBELE9BQU8sQ0FBQ0YsV0FIVyxDQUF2Qjs7QUFNQSxVQUFJb0QsZUFBSixFQUFxQjtBQUNqQixjQUFNLEtBQUtpQixZQUFMLENBQWtCbkUsT0FBbEIsQ0FBTjtBQUNILE9BRkQsTUFFTztBQUNILGNBQU0sS0FBS29FLGdCQUFMLENBQXNCcEUsT0FBdEIsQ0FBTjtBQUNIOztBQUVELGFBQU9BLE9BQU8sQ0FBQ3FFLFFBQWY7QUFDSCxLQXBCTSxFQW9CSnJFLE9BcEJJLENBQVA7QUFxQkg7O0FBTUQsU0FBT3NFLGtCQUFQLENBQTBCcEcsSUFBMUIsRUFBZ0M7QUFDNUIsUUFBSXFHLGNBQWMsR0FBRyxLQUFyQjs7QUFFQSxRQUFJQyxhQUFhLEdBQUcvSCxDQUFDLENBQUM0QixJQUFGLENBQU8sS0FBS04sSUFBTCxDQUFVTyxVQUFqQixFQUE2QkMsTUFBTSxJQUFJO0FBQ3ZELFVBQUlrRyxPQUFPLEdBQUdoSSxDQUFDLENBQUMrQixLQUFGLENBQVFELE1BQVIsRUFBZ0JFLENBQUMsSUFBSUEsQ0FBQyxJQUFJUCxJQUExQixDQUFkOztBQUNBcUcsTUFBQUEsY0FBYyxHQUFHQSxjQUFjLElBQUlFLE9BQW5DO0FBRUEsYUFBT2hJLENBQUMsQ0FBQytCLEtBQUYsQ0FBUUQsTUFBUixFQUFnQkUsQ0FBQyxJQUFJLENBQUNoQyxDQUFDLENBQUNpQyxLQUFGLENBQVFSLElBQUksQ0FBQ08sQ0FBRCxDQUFaLENBQXRCLENBQVA7QUFDSCxLQUxtQixDQUFwQjs7QUFPQSxXQUFPLENBQUUrRixhQUFGLEVBQWlCRCxjQUFqQixDQUFQO0FBQ0g7O0FBTUQsU0FBT0csd0JBQVAsQ0FBZ0NDLFNBQWhDLEVBQTJDO0FBQ3ZDLFFBQUksQ0FBRUMseUJBQUYsRUFBNkJDLHFCQUE3QixJQUF1RCxLQUFLUCxrQkFBTCxDQUF3QkssU0FBeEIsQ0FBM0Q7O0FBRUEsUUFBSSxDQUFDQyx5QkFBTCxFQUFnQztBQUM1QixVQUFJQyxxQkFBSixFQUEyQjtBQUN2QixjQUFNLElBQUk5SCxtQkFBSixDQUF3Qix5REFBeEIsQ0FBTjtBQUNIOztBQUVELFlBQU0sSUFBSUMsZ0JBQUosQ0FBcUIsbUJBQXJCLEVBQTBDO0FBQ3hDOEYsUUFBQUEsTUFBTSxFQUFFLEtBQUsvRSxJQUFMLENBQVU0QyxJQURzQjtBQUV4Q29DLFFBQUFBLE1BQU0sRUFBRSx5RUFGZ0M7QUFHeEM0QixRQUFBQTtBQUh3QyxPQUExQyxDQUFOO0FBTUg7QUFDSjs7QUFTRCxlQUFhckMsbUJBQWIsQ0FBaUN0QyxPQUFqQyxFQUEwQzhFLFVBQVUsR0FBRyxLQUF2RCxFQUE4RDtBQUMxRCxRQUFJL0csSUFBSSxHQUFHLEtBQUtBLElBQWhCO0FBQ0EsUUFBSWdILElBQUksR0FBRyxLQUFLQSxJQUFoQjtBQUNBLFFBQUk7QUFBRXBFLE1BQUFBLElBQUY7QUFBUXBDLE1BQUFBO0FBQVIsUUFBbUJSLElBQXZCO0FBRUEsUUFBSTtBQUFFK0QsTUFBQUE7QUFBRixRQUFVOUIsT0FBZDtBQUNBLFFBQUl3QyxNQUFNLEdBQUcsRUFBYjtBQUFBLFFBQWlCNkIsUUFBakI7QUFDQXJFLElBQUFBLE9BQU8sQ0FBQ3dDLE1BQVIsR0FBaUJBLE1BQWpCOztBQUVBLFFBQUksQ0FBQ3hDLE9BQU8sQ0FBQytFLElBQWIsRUFBbUI7QUFDZi9FLE1BQUFBLE9BQU8sQ0FBQytFLElBQVIsR0FBZUEsSUFBZjtBQUNIOztBQUVELFFBQUlDLFNBQVMsR0FBR0YsVUFBVSxHQUFHOUUsT0FBTyxDQUFDNEMsYUFBWCxHQUEyQjVDLE9BQU8sQ0FBQzZCLGFBQTdEOztBQUVBLFFBQUlpRCxVQUFVLElBQUksS0FBS0csc0JBQUwsQ0FBNEJuRCxHQUE1QixDQUFsQixFQUFvRDtBQUNoRCxVQUFJLENBQUM5QixPQUFPLENBQUNGLFdBQVQsSUFBd0IsQ0FBQ0UsT0FBTyxDQUFDRixXQUFSLENBQW9Cc0MsVUFBakQsRUFBNkQ7QUFDekRwQyxRQUFBQSxPQUFPLENBQUNGLFdBQVIsS0FBd0JFLE9BQU8sQ0FBQ0YsV0FBUixHQUFzQixFQUE5QztBQUVBRSxRQUFBQSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JzQyxVQUFwQixHQUFpQyxNQUFNLEtBQUs1QixFQUFMLENBQVFDLFNBQVIsQ0FBa0I0QixpQkFBbEIsRUFBdkM7QUFDSDs7QUFFRGdDLE1BQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUt6RSxRQUFMLENBQWM7QUFBRXdELFFBQUFBLE1BQU0sRUFBRTRCLFNBQVMsQ0FBQzVCO0FBQXBCLE9BQWQsRUFBNENwRCxPQUFPLENBQUNGLFdBQXBELENBQWpCO0FBQ0FFLE1BQUFBLE9BQU8sQ0FBQ3FFLFFBQVIsR0FBbUJBLFFBQW5CO0FBQ0g7O0FBRUQsVUFBTTNILFVBQVUsQ0FBQzZCLE1BQUQsRUFBUyxPQUFPMkcsU0FBUCxFQUFrQkMsU0FBbEIsS0FBZ0M7QUFDckQsVUFBSUEsU0FBUyxJQUFJckQsR0FBakIsRUFBc0I7QUFFbEIsWUFBSW9ELFNBQVMsQ0FBQ0UsUUFBZCxFQUF3QjtBQUNwQixjQUFJLENBQUNOLFVBQUQsSUFBZSxDQUFDRSxTQUFTLENBQUNuQyxlQUFWLENBQTBCd0MsR0FBMUIsQ0FBOEJGLFNBQTlCLENBQXBCLEVBQThEO0FBRTFELGtCQUFNLElBQUlwSSxtQkFBSixDQUF5QixvQkFBbUJvSSxTQUFVLDZDQUF0RCxFQUFvRztBQUN0R3JDLGNBQUFBLE1BQU0sRUFBRW5DLElBRDhGO0FBRXRHdUUsY0FBQUEsU0FBUyxFQUFFQTtBQUYyRixhQUFwRyxDQUFOO0FBSUg7QUFDSjs7QUFFRCxZQUFJSixVQUFVLElBQUlJLFNBQVMsQ0FBQ0kscUJBQTVCLEVBQW1EO0FBQUEsZUFDdkNqQixRQUR1QztBQUFBLDRCQUM3QiwyREFENkI7QUFBQTs7QUFHL0MsY0FBSUEsUUFBUSxDQUFDYyxTQUFELENBQVIsS0FBd0JELFNBQVMsQ0FBQ0ssT0FBdEMsRUFBK0M7QUFFM0Msa0JBQU0sSUFBSXhJLG1CQUFKLENBQXlCLGdDQUErQm9JLFNBQVUsaUNBQWxFLEVBQW9HO0FBQ3RHckMsY0FBQUEsTUFBTSxFQUFFbkMsSUFEOEY7QUFFdEd1RSxjQUFBQSxTQUFTLEVBQUVBO0FBRjJGLGFBQXBHLENBQU47QUFJSDtBQUNKOztBQWNELFlBQUk3SCxTQUFTLENBQUN5RSxHQUFHLENBQUNxRCxTQUFELENBQUosQ0FBYixFQUErQjtBQUMzQixjQUFJLENBQUNELFNBQVMsQ0FBQ00sUUFBZixFQUF5QjtBQUNyQixrQkFBTSxJQUFJekksbUJBQUosQ0FBeUIsUUFBT29JLFNBQVUsZUFBY3hFLElBQUssMEJBQTdELEVBQXdGO0FBQzFGbUMsY0FBQUEsTUFBTSxFQUFFbkMsSUFEa0Y7QUFFMUZ1RSxjQUFBQSxTQUFTLEVBQUVBO0FBRitFLGFBQXhGLENBQU47QUFJSDs7QUFFRDFDLFVBQUFBLE1BQU0sQ0FBQzJDLFNBQUQsQ0FBTixHQUFvQixJQUFwQjtBQUNILFNBVEQsTUFTTztBQUNILGNBQUk7QUFDQTNDLFlBQUFBLE1BQU0sQ0FBQzJDLFNBQUQsQ0FBTixHQUFvQnJJLEtBQUssQ0FBQzJJLFFBQU4sQ0FBZTNELEdBQUcsQ0FBQ3FELFNBQUQsQ0FBbEIsRUFBK0JELFNBQS9CLEVBQTBDSCxJQUExQyxDQUFwQjtBQUNILFdBRkQsQ0FFRSxPQUFPVyxLQUFQLEVBQWM7QUFDWixrQkFBTSxJQUFJM0ksbUJBQUosQ0FBeUIsWUFBV29JLFNBQVUsZUFBY3hFLElBQUssV0FBakUsRUFBNkU7QUFDL0VtQyxjQUFBQSxNQUFNLEVBQUVuQyxJQUR1RTtBQUUvRXVFLGNBQUFBLFNBQVMsRUFBRUEsU0FGb0U7QUFHL0VRLGNBQUFBLEtBQUssRUFBRUEsS0FBSyxDQUFDQyxPQUFOLElBQWlCRCxLQUFLLENBQUNFO0FBSGlELGFBQTdFLENBQU47QUFLSDtBQUNKOztBQUVEO0FBQ0g7O0FBR0QsVUFBSWQsVUFBSixFQUFnQjtBQUNaLFlBQUlJLFNBQVMsQ0FBQ1csV0FBZCxFQUEyQjtBQUV2QixjQUFJWCxTQUFTLENBQUNZLFVBQWQsRUFBMEI7QUFDdEI7QUFDSDs7QUFHRCxjQUFJWixTQUFTLENBQUNhLElBQWQsRUFBb0I7QUFDaEJ2RCxZQUFBQSxNQUFNLENBQUMyQyxTQUFELENBQU4sR0FBb0IsTUFBTXRJLFVBQVUsQ0FBQzBJLE9BQVgsQ0FBbUJMLFNBQW5CLEVBQThCSCxJQUE5QixDQUExQjtBQUNBO0FBQ0g7O0FBRUQsZ0JBQU0sSUFBSWhJLG1CQUFKLENBQ0QsSUFBR29JLFNBQVUsU0FBUXhFLElBQUssdUNBRHpCLEVBQ2lFO0FBQy9EbUMsWUFBQUEsTUFBTSxFQUFFbkMsSUFEdUQ7QUFFL0R1RSxZQUFBQSxTQUFTLEVBQUVBO0FBRm9ELFdBRGpFLENBQU47QUFNSDs7QUFFRDtBQUNIOztBQUdELFVBQUksQ0FBQ0EsU0FBUyxDQUFDYyxVQUFmLEVBQTJCO0FBQ3ZCLFlBQUlkLFNBQVMsQ0FBQ2UsY0FBVixDQUF5QixTQUF6QixDQUFKLEVBQXlDO0FBRXJDekQsVUFBQUEsTUFBTSxDQUFDMkMsU0FBRCxDQUFOLEdBQW9CRCxTQUFTLENBQUNLLE9BQTlCO0FBRUgsU0FKRCxNQUlPLElBQUlMLFNBQVMsQ0FBQ00sUUFBZCxFQUF3QjtBQUMzQjtBQUNILFNBRk0sTUFFQSxJQUFJTixTQUFTLENBQUNhLElBQWQsRUFBb0I7QUFFdkJ2RCxVQUFBQSxNQUFNLENBQUMyQyxTQUFELENBQU4sR0FBb0IsTUFBTXRJLFVBQVUsQ0FBQzBJLE9BQVgsQ0FBbUJMLFNBQW5CLEVBQThCSCxJQUE5QixDQUExQjtBQUVILFNBSk0sTUFJQTtBQUVILGdCQUFNLElBQUloSSxtQkFBSixDQUF5QixJQUFHb0ksU0FBVSxTQUFReEUsSUFBSyx1QkFBbkQsRUFBMkU7QUFDN0VtQyxZQUFBQSxNQUFNLEVBQUVuQyxJQURxRTtBQUU3RXVFLFlBQUFBLFNBQVMsRUFBRUE7QUFGa0UsV0FBM0UsQ0FBTjtBQUlIO0FBQ0o7QUFDSixLQTFHZSxDQUFoQjtBQTRHQTFDLElBQUFBLE1BQU0sR0FBR3hDLE9BQU8sQ0FBQ3dDLE1BQVIsR0FBaUIsS0FBSzBELGNBQUwsQ0FBb0IxRCxNQUFwQixFQUE0QndDLFNBQVMsQ0FBQ21CLFVBQXRDLEVBQWtELElBQWxELENBQTFCOztBQUVBLFFBQUk7QUFDQSxZQUFNaEosUUFBUSxDQUFDOEMsV0FBVCxDQUFxQjdDLEtBQUssQ0FBQ2dKLHFCQUEzQixFQUFrRCxJQUFsRCxFQUF3RHBHLE9BQXhELENBQU47QUFDSCxLQUZELENBRUUsT0FBTzBGLEtBQVAsRUFBYztBQUNaLFVBQUlBLEtBQUssQ0FBQ1csTUFBVixFQUFrQjtBQUNkLGNBQU1YLEtBQU47QUFDSDs7QUFFRCxZQUFNLElBQUl6SSxnQkFBSixDQUNELDJEQUEwRCxLQUFLYyxJQUFMLENBQVU0QyxJQUFLLGFBQTFFLEdBQXlGK0UsS0FBSyxDQUFDQyxPQUQ3RixFQUVGO0FBQUVELFFBQUFBLEtBQUssRUFBRUE7QUFBVCxPQUZFLENBQU47QUFJSDs7QUFFRCxVQUFNLEtBQUtZLGVBQUwsQ0FBcUJ0RyxPQUFyQixFQUE4QjhFLFVBQTlCLENBQU47QUFHQTlFLElBQUFBLE9BQU8sQ0FBQ3dDLE1BQVIsR0FBaUIvRixDQUFDLENBQUM4SixTQUFGLENBQVkvRCxNQUFaLEVBQW9CLENBQUNnRSxLQUFELEVBQVFsSCxHQUFSLEtBQWdCO0FBQ2pELFVBQUk0RixTQUFTLEdBQUczRyxNQUFNLENBQUNlLEdBQUQsQ0FBdEI7O0FBRGlELFdBRXpDNEYsU0FGeUM7QUFBQTtBQUFBOztBQUlqRCxhQUFPLEtBQUt1QixnQkFBTCxDQUFzQkQsS0FBdEIsRUFBNkJ0QixTQUE3QixDQUFQO0FBQ0gsS0FMZ0IsQ0FBakI7QUFPQSxXQUFPbEYsT0FBUDtBQUNIOztBQUVELGVBQWFNLGFBQWIsQ0FBMkJvRyxRQUEzQixFQUFxQzFHLE9BQXJDLEVBQThDO0FBQzFDMEcsSUFBQUEsUUFBUSxHQUFHQSxRQUFRLENBQUNDLElBQVQsQ0FBYyxJQUFkLENBQVg7O0FBRUEsUUFBSTNHLE9BQU8sQ0FBQ0YsV0FBUixJQUF1QkUsT0FBTyxDQUFDRixXQUFSLENBQW9Cc0MsVUFBL0MsRUFBMkQ7QUFDdEQsYUFBT3NFLFFBQVEsQ0FBQzFHLE9BQUQsQ0FBZjtBQUNKOztBQUVELFFBQUk7QUFDQSxVQUFJZ0IsTUFBTSxHQUFHLE1BQU0wRixRQUFRLENBQUMxRyxPQUFELENBQTNCO0FBR0FBLE1BQUFBLE9BQU8sQ0FBQ0YsV0FBUixJQUNJRSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JzQyxVQUR4QixLQUVJLE1BQU0sS0FBSzVCLEVBQUwsQ0FBUUMsU0FBUixDQUFrQm1HLE9BQWxCLENBQTBCNUcsT0FBTyxDQUFDRixXQUFSLENBQW9Cc0MsVUFBOUMsQ0FGVjtBQUlBLGFBQU9wQixNQUFQO0FBQ0gsS0FURCxDQVNFLE9BQU8wRSxLQUFQLEVBQWM7QUFFWjFGLE1BQUFBLE9BQU8sQ0FBQ0YsV0FBUixJQUNJRSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JzQyxVQUR4QixLQUVJLE1BQU0sS0FBSzVCLEVBQUwsQ0FBUUMsU0FBUixDQUFrQm9HLFNBQWxCLENBQTRCN0csT0FBTyxDQUFDRixXQUFSLENBQW9Cc0MsVUFBaEQsQ0FGVjtBQUlBLFlBQU1zRCxLQUFOO0FBQ0g7QUFDSjs7QUFFRCxTQUFPVCxzQkFBUCxDQUE4QjZCLEtBQTlCLEVBQXFDO0FBRWpDLFFBQUlDLElBQUksR0FBRyxLQUFLaEosSUFBTCxDQUFVaUosaUJBQXJCO0FBQ0EsUUFBSUMsVUFBVSxHQUFHLEtBQWpCOztBQUVBLFFBQUlGLElBQUosRUFBVTtBQUNORSxNQUFBQSxVQUFVLEdBQUd4SyxDQUFDLENBQUM0QixJQUFGLENBQU8wSSxJQUFQLEVBQWEsQ0FBQ0csR0FBRCxFQUFNL0IsU0FBTixLQUFvQjtBQUMxQyxZQUFJQSxTQUFTLElBQUkyQixLQUFqQixFQUF3QjtBQUNwQixpQkFBT3JLLENBQUMsQ0FBQzRCLElBQUYsQ0FBTzZJLEdBQVAsRUFBWUMsQ0FBQyxJQUFJO0FBQ3BCLGdCQUFJLENBQUVDLEtBQUYsRUFBU0MsS0FBVCxJQUFtQkYsQ0FBQyxDQUFDbEksS0FBRixDQUFRLEdBQVIsQ0FBdkI7QUFDQSxtQkFBTyxDQUFDbUksS0FBSyxLQUFLLFFBQVYsSUFBc0JBLEtBQUssS0FBSyxTQUFqQyxLQUErQzNLLENBQUMsQ0FBQ2lDLEtBQUYsQ0FBUW9JLEtBQUssQ0FBQ08sS0FBRCxDQUFiLENBQXREO0FBQ0gsV0FITSxDQUFQO0FBSUg7O0FBRUQsZUFBTyxLQUFQO0FBQ0gsT0FUWSxDQUFiOztBQVdBLFVBQUlKLFVBQUosRUFBZ0I7QUFDWixlQUFPLElBQVA7QUFDSDtBQUNKOztBQUdELFFBQUlLLGlCQUFpQixHQUFHLEtBQUt2SixJQUFMLENBQVV3SixRQUFWLENBQW1CRCxpQkFBM0M7O0FBQ0EsUUFBSUEsaUJBQUosRUFBdUI7QUFDbkJMLE1BQUFBLFVBQVUsR0FBR3hLLENBQUMsQ0FBQzRCLElBQUYsQ0FBT2lKLGlCQUFQLEVBQTBCL0ksTUFBTSxJQUFJOUIsQ0FBQyxDQUFDNEIsSUFBRixDQUFPRSxNQUFQLEVBQWU4SSxLQUFLLElBQUtBLEtBQUssSUFBSVAsS0FBVixJQUFvQnJLLENBQUMsQ0FBQ2lDLEtBQUYsQ0FBUW9JLEtBQUssQ0FBQ08sS0FBRCxDQUFiLENBQTVDLENBQXBDLENBQWI7O0FBQ0EsVUFBSUosVUFBSixFQUFnQjtBQUNaLGVBQU8sSUFBUDtBQUNIO0FBQ0o7O0FBRUQsV0FBTyxLQUFQO0FBQ0g7O0FBRUQsU0FBT08sZ0JBQVAsQ0FBd0JDLEdBQXhCLEVBQTZCO0FBQ3pCLFdBQU9oTCxDQUFDLENBQUM0QixJQUFGLENBQU9vSixHQUFQLEVBQVksQ0FBQ0MsQ0FBRCxFQUFJQyxDQUFKLEtBQVVBLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBUyxHQUEvQixDQUFQO0FBQ0g7O0FBRUQsU0FBTzVILGVBQVAsQ0FBdUI2SCxPQUF2QixFQUFnQzFFLGVBQWUsR0FBRyxLQUFsRCxFQUF5RDtBQUNyRCxRQUFJLENBQUN6RyxDQUFDLENBQUNtQyxhQUFGLENBQWdCZ0osT0FBaEIsQ0FBTCxFQUErQjtBQUMzQixVQUFJMUUsZUFBZSxJQUFJMkUsS0FBSyxDQUFDQyxPQUFOLENBQWMsS0FBSy9KLElBQUwsQ0FBVUMsUUFBeEIsQ0FBdkIsRUFBMEQ7QUFDdEQsY0FBTSxJQUFJaEIsZ0JBQUosQ0FBcUIsK0ZBQXJCLENBQU47QUFDSDs7QUFFRCxhQUFPNEssT0FBTyxHQUFHO0FBQUV4RSxRQUFBQSxNQUFNLEVBQUU7QUFBRSxXQUFDLEtBQUtyRixJQUFMLENBQVVDLFFBQVgsR0FBc0IsS0FBS2tJLGNBQUwsQ0FBb0IwQixPQUFwQjtBQUF4QjtBQUFWLE9BQUgsR0FBd0UsRUFBdEY7QUFDSDs7QUFFRCxRQUFJRyxpQkFBaUIsR0FBRyxFQUF4QjtBQUFBLFFBQTRCQyxLQUFLLEdBQUcsRUFBcEM7O0FBRUF2TCxJQUFBQSxDQUFDLENBQUN3TCxNQUFGLENBQVNMLE9BQVQsRUFBa0IsQ0FBQ0YsQ0FBRCxFQUFJQyxDQUFKLEtBQVU7QUFDeEIsVUFBSUEsQ0FBQyxDQUFDLENBQUQsQ0FBRCxLQUFTLEdBQWIsRUFBa0I7QUFDZEksUUFBQUEsaUJBQWlCLENBQUNKLENBQUQsQ0FBakIsR0FBdUJELENBQXZCO0FBQ0gsT0FGRCxNQUVPO0FBQ0hNLFFBQUFBLEtBQUssQ0FBQ0wsQ0FBRCxDQUFMLEdBQVdELENBQVg7QUFDSDtBQUNKLEtBTkQ7O0FBUUFLLElBQUFBLGlCQUFpQixDQUFDM0UsTUFBbEIsR0FBMkIsRUFBRSxHQUFHNEUsS0FBTDtBQUFZLFNBQUdELGlCQUFpQixDQUFDM0U7QUFBakMsS0FBM0I7O0FBRUEsUUFBSUYsZUFBZSxJQUFJLENBQUMwRSxPQUFPLENBQUNNLG1CQUFoQyxFQUFxRDtBQUNqRCxXQUFLeEQsd0JBQUwsQ0FBOEJxRCxpQkFBaUIsQ0FBQzNFLE1BQWhEO0FBQ0g7O0FBRUQyRSxJQUFBQSxpQkFBaUIsQ0FBQzNFLE1BQWxCLEdBQTJCLEtBQUs4QyxjQUFMLENBQW9CNkIsaUJBQWlCLENBQUMzRSxNQUF0QyxFQUE4QzJFLGlCQUFpQixDQUFDNUIsVUFBaEUsQ0FBM0I7O0FBRUEsUUFBSTRCLGlCQUFpQixDQUFDSSxRQUF0QixFQUFnQztBQUM1QixVQUFJMUwsQ0FBQyxDQUFDbUMsYUFBRixDQUFnQm1KLGlCQUFpQixDQUFDSSxRQUFsQyxDQUFKLEVBQWlEO0FBQzdDLFlBQUlKLGlCQUFpQixDQUFDSSxRQUFsQixDQUEyQkMsTUFBL0IsRUFBdUM7QUFDbkNMLFVBQUFBLGlCQUFpQixDQUFDSSxRQUFsQixDQUEyQkMsTUFBM0IsR0FBb0MsS0FBS2xDLGNBQUwsQ0FBb0I2QixpQkFBaUIsQ0FBQ0ksUUFBbEIsQ0FBMkJDLE1BQS9DLEVBQXVETCxpQkFBaUIsQ0FBQzVCLFVBQXpFLENBQXBDO0FBQ0g7QUFDSjtBQUNKOztBQUVELFFBQUk0QixpQkFBaUIsQ0FBQ00sV0FBdEIsRUFBbUM7QUFDL0JOLE1BQUFBLGlCQUFpQixDQUFDTSxXQUFsQixHQUFnQyxLQUFLbkMsY0FBTCxDQUFvQjZCLGlCQUFpQixDQUFDTSxXQUF0QyxFQUFtRE4saUJBQWlCLENBQUM1QixVQUFyRSxDQUFoQztBQUNIOztBQUVELFdBQU80QixpQkFBUDtBQUNIOztBQUVELFNBQU8xSCxvQkFBUCxHQUE4QjtBQUMxQixVQUFNLElBQUlpSSxLQUFKLENBQVVoTCxhQUFWLENBQU47QUFDSDs7QUFFRCxTQUFPeUQsb0JBQVAsR0FBOEI7QUFDMUIsVUFBTSxJQUFJdUgsS0FBSixDQUFVaEwsYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBTzBFLG9CQUFQLENBQTRCOUQsSUFBNUIsRUFBa0M7QUFDOUIsVUFBTSxJQUFJb0ssS0FBSixDQUFVaEwsYUFBVixDQUFOO0FBQ0g7O0FBRUQsZUFBYW9GLGNBQWIsQ0FBNEIxQyxPQUE1QixFQUFxQ3VJLE1BQXJDLEVBQTZDO0FBQ3pDLFVBQU0sSUFBSUQsS0FBSixDQUFVaEwsYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBT2tMLHFCQUFQLENBQTZCN0gsSUFBN0IsRUFBbUM7QUFDL0IsVUFBTSxJQUFJMkgsS0FBSixDQUFVaEwsYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBT21MLFVBQVAsQ0FBa0JqQyxLQUFsQixFQUF5QjtBQUNyQixVQUFNLElBQUk4QixLQUFKLENBQVVoTCxhQUFWLENBQU47QUFDSDs7QUFFRCxTQUFPNEksY0FBUCxDQUFzQk0sS0FBdEIsRUFBNkJrQyxTQUE3QixFQUF3Q0MsYUFBeEMsRUFBdUQ7QUFDbkQsUUFBSWxNLENBQUMsQ0FBQ21DLGFBQUYsQ0FBZ0I0SCxLQUFoQixDQUFKLEVBQTRCO0FBQ3hCLFVBQUlBLEtBQUssQ0FBQ29DLE9BQVYsRUFBbUI7QUFDZixZQUFJcEMsS0FBSyxDQUFDb0MsT0FBTixLQUFrQixpQkFBdEIsRUFBeUM7QUFDckMsY0FBSSxDQUFDRixTQUFMLEVBQWdCO0FBQ1osa0JBQU0sSUFBSTFMLGdCQUFKLENBQXFCLDRCQUFyQixDQUFOO0FBQ0g7O0FBRUQsY0FBSSxDQUFDLENBQUMwTCxTQUFTLENBQUNHLE9BQVgsSUFBc0IsRUFBRXJDLEtBQUssQ0FBQzdGLElBQU4sSUFBZStILFNBQVMsQ0FBQ0csT0FBM0IsQ0FBdkIsS0FBK0QsQ0FBQ3JDLEtBQUssQ0FBQ2hCLFFBQTFFLEVBQW9GO0FBQ2hGLGdCQUFJc0QsT0FBTyxHQUFHLEVBQWQ7O0FBQ0EsZ0JBQUl0QyxLQUFLLENBQUN1QyxjQUFWLEVBQTBCO0FBQ3RCRCxjQUFBQSxPQUFPLENBQUNFLElBQVIsQ0FBYXhDLEtBQUssQ0FBQ3VDLGNBQW5CO0FBQ0g7O0FBQ0QsZ0JBQUl2QyxLQUFLLENBQUN5QyxhQUFWLEVBQXlCO0FBQ3JCSCxjQUFBQSxPQUFPLENBQUNFLElBQVIsQ0FBYXhDLEtBQUssQ0FBQ3lDLGFBQU4sSUFBdUIxTSxRQUFRLENBQUMyTSxXQUE3QztBQUNIOztBQUVELGtCQUFNLElBQUloTSxhQUFKLENBQWtCLEdBQUc0TCxPQUFyQixDQUFOO0FBQ0g7O0FBRUQsaUJBQU9KLFNBQVMsQ0FBQ0csT0FBVixDQUFrQnJDLEtBQUssQ0FBQzdGLElBQXhCLENBQVA7QUFDSCxTQWxCRCxNQWtCTyxJQUFJNkYsS0FBSyxDQUFDb0MsT0FBTixLQUFrQixlQUF0QixFQUF1QztBQUMxQyxjQUFJLENBQUNGLFNBQUwsRUFBZ0I7QUFDWixrQkFBTSxJQUFJMUwsZ0JBQUosQ0FBcUIsNEJBQXJCLENBQU47QUFDSDs7QUFFRCxjQUFJLENBQUMwTCxTQUFTLENBQUNWLEtBQVgsSUFBb0IsRUFBRXhCLEtBQUssQ0FBQzdGLElBQU4sSUFBYytILFNBQVMsQ0FBQ1YsS0FBMUIsQ0FBeEIsRUFBMEQ7QUFDdEQsa0JBQU0sSUFBSWhMLGdCQUFKLENBQXNCLG9CQUFtQndKLEtBQUssQ0FBQzdGLElBQUssK0JBQXBELENBQU47QUFDSDs7QUFFRCxpQkFBTytILFNBQVMsQ0FBQ1YsS0FBVixDQUFnQnhCLEtBQUssQ0FBQzdGLElBQXRCLENBQVA7QUFDSCxTQVZNLE1BVUEsSUFBSTZGLEtBQUssQ0FBQ29DLE9BQU4sS0FBa0IsYUFBdEIsRUFBcUM7QUFDeEMsaUJBQU8sS0FBS0oscUJBQUwsQ0FBMkJoQyxLQUFLLENBQUM3RixJQUFqQyxDQUFQO0FBQ0g7O0FBRUQsY0FBTSxJQUFJMkgsS0FBSixDQUFVLDRCQUE0QjlCLEtBQUssQ0FBQ29DLE9BQTVDLENBQU47QUFDSDs7QUFFRCxhQUFPbk0sQ0FBQyxDQUFDOEosU0FBRixDQUFZQyxLQUFaLEVBQW9Ca0IsQ0FBRCxJQUFPLEtBQUt4QixjQUFMLENBQW9Cd0IsQ0FBcEIsRUFBdUJnQixTQUF2QixDQUExQixDQUFQO0FBQ0g7O0FBRUQsUUFBSWIsS0FBSyxDQUFDQyxPQUFOLENBQWN0QixLQUFkLENBQUosRUFBMEI7QUFDdEIsYUFBT0EsS0FBSyxDQUFDdEgsR0FBTixDQUFVd0ksQ0FBQyxJQUFJLEtBQUt4QixjQUFMLENBQW9Cd0IsQ0FBcEIsRUFBdUJnQixTQUF2QixDQUFmLENBQVA7QUFDSDs7QUFFRCxRQUFJQyxhQUFKLEVBQW1CLE9BQU9uQyxLQUFQO0FBRW5CLFdBQU8sS0FBS2lDLFVBQUwsQ0FBZ0JqQyxLQUFoQixDQUFQO0FBQ0g7O0FBOTJCYTs7QUFpM0JsQjJDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjdMLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IsIE9vbG9uZ1VzYWdlRXJyb3IsIERzT3BlcmF0aW9uRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogR2V0IGFuIG9iamVjdCBvZiB0aGUgcHJpbWFyeSBrZXkgdmFsdWVzLlxuICAgICAqL1xuICAgIGdldCAkcGtWYWx1ZXMoKSB7XG4gICAgICAgIHJldHVybiBfLnBpY2sodGhpcywgXy5jYXN0QXJyYXkodGhpcy5jb25zdHJ1Y3Rvci5tZXRhLmtleUZpZWxkKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9wdWxhdGUgZGF0YSBmcm9tIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcmV0dXJuIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgcG9wdWxhdGUoZGF0YSkge1xuICAgICAgICBsZXQgTW9kZWxDbGFzcyA9IHRoaXM7XG4gICAgICAgIHJldHVybiBuZXcgTW9kZWxDbGFzcyhkYXRhKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiBfLmlzUGxhaW5PYmplY3QoZGF0YSk7ICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXkpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YUFsdEtleSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGFBbHRLZXkgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YUFsdEtleVtrZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiBrZXkgfSk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX2NhY2hlZERhdGE7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5maW5kT3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIC8qXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZU1hbnlfKHJlY29yZHMsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGNyZWF0ZU9wdGlvbnMgfHwgKGNyZWF0ZU9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGRhdGEgPT4ge1xuICAgICAgICAgICAgXG5cblxuICAgICAgICB9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH0qL1xuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIXVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKHVwZGF0ZU9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8pOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQudXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgcHJlOiBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgbm90RmluaXNoZWQgPSBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG4gICAgICAgIGlmICghbm90RmluaXNoZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmV4aXN0aW5nO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmUgcnVsZXMgdG8gZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi4gRGV0YWlsOiBgICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICB7IGVycm9yOiBlcnJvciB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieVBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGV0ZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodikgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=