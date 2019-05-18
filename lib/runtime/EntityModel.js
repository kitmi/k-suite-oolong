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

  static valueOfKey(data) {
    return Array.isArray(this.meta.keyField) ? _.pick(data, this.meta.keyField) : data[this.meta.keyField];
  }

  static getUniqueKeyFieldsFrom(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }

  static getUniqueKeyValuePairsFrom(data) {
    if (!(typeof data === 'object')) {
      throw new Error("Function  precondition failed: typeof data === 'object'");
    }

    let ukFields = this.getUniqueKeyFieldsFrom(data);
    return _.pick(data, ukFields);
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath);
  }

  static ensureRetrieveCreated(context, customOptions) {
    if (!context.options.$retrieveCreated) {
      context.options.$retrieveCreated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveUpdated(context, customOptions) {
    if (!context.options.$retrieveUpdated) {
      context.options.$retrieveUpdated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveDeleted(context, customOptions) {
    if (!context.options.$retrieveDeleted) {
      context.options.$retrieveDeleted = customOptions ? customOptions : true;
    }
  }

  static async ensureTransaction_(context) {
    if (!context.connOptions || !context.connOptions.connection) {
      context.connOptions || (context.connOptions = {});
      context.connOptions.connection = await this.db.connector.beginTransaction_();
    }
  }

  static getValueFromContext(context, key) {
    return getValueByPath(context, 'options.$variables.' + key);
  }

  static async cached_(key, connOptions) {
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
        }, connOptions);
      }

      return cachedData;
    }

    if (!this._cachedData) {
      this._cachedData = await this.findAll_({
        $toDictionary: true
      }, connOptions);
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
      options: createOptions,
      connOptions
    };
    let needCreateAssocs = false;

    if (!_.isEmpty(associations)) {
      needCreateAssocs = true;
    }

    if (this.meta.name === 'party') {
      let a = 1;
    }

    let success = await this._safeExecute_(async context => {
      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
      }

      await this._prepareEntityData_(context);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context))) {
        return false;
      }

      if (!(await this.beforeCreate_(context))) {
        return false;
      }

      context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
      await this._internalAfterCreate_(context);

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
      }

      await Features.applyRules_(Rules.RULE_AFTER_CREATE, this, context);

      if (needCreateAssocs) {
        await this._createAssocs_(context, associations);
      }

      return true;
    }, context);

    if (success) {
      await this.afterCreate_(context);
    }

    return context.latest;
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
    let context = {
      raw: data,
      options: updateOptions,
      connOptions
    };
    let success = await this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context))) {
        return false;
      }

      let toUpdate;

      if (forSingleRecord) {
        toUpdate = await this.beforeUpdate_(context);
      } else {
        toUpdate = await this.beforeUpdateMany_(context);
      }

      if (!toUpdate) {
        return false;
      }

      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.options.$query, context.options, context.connOptions);

      if (forSingleRecord) {
        await this._internalAfterUpdate_(context);
      } else {
        await this._internalAfterUpdateMany_(context);
      }

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
      }

      await Features.applyRules_(Rules.RULE_AFTER_UPDATE, this, context);
      return true;
    }, context);

    if (success) {
      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }
    }

    return context.latest;
  }

  static async replaceOne_(data, updateOptions, connOptions) {
    if (!updateOptions) {
      let conditionFields = this.getUniqueKeyFieldsFrom(data);

      if (_.isEmpty(conditionFields)) {
        throw new OolongUsageError('Primary key value(s) or at least one group of unique key value(s) is required for replacing an entity.');
      }

      updateOptions = { ...updateOptions,
        $query: _.pick(data, conditionFields)
      };
    } else {
      updateOptions = this._prepareQueries(updateOptions, true);
    }

    let context = {
      raw: data,
      options: updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      return this._doReplaceOne_(context);
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
      options: deleteOptions,
      connOptions
    };
    let success = await this._safeExecute_(async context => {
      if (!(await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context))) {
        return false;
      }

      let toDelete;

      if (forSingleRecord) {
        toDelete = await this.beforeDelete_(context);
      } else {
        toDelete = await this.beforeDeleteMany_(context);
      }

      if (!toDelete) {
        return false;
      }

      context.result = await this.db.connector.delete_(this.meta.name, context.options.$query, context.connOptions);

      if (forSingleRecord) {
        await this._internalAfterDelete_(context);
      } else {
        await this._internalAfterDeleteMany_(context);
      }

      if (!context.queryKey) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
      }

      await Features.applyRules_(Rules.RULE_AFTER_DELETE, this, context);
      return true;
    }, context);

    if (success) {
      if (forSingleRecord) {
        await this.afterDelete_(context);
      } else {
        await this.afterDeleteMany_(context);
      }
    }

    return context.existing;
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

    let opOptions = context.options;

    if (isUpdating && this._dependsOnExistingData(raw)) {
      this.ensureRetrieveCreated(context);
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
    latest = context.latest = this._translateValue(latest, opOptions.$variables, true);

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

      return this._serializeByTypeInfo(value, fieldInfo);
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

      if (context.connOptions && context.connOptions.connection) {
        await this.db.connector.commit_(context.connOptions.connection);
        delete context.connOptions.connection;
      }

      return result;
    } catch (error) {
      if (context.connOptions && context.connOptions.connection) {
        await this.db.connector.rollback_(context.connOptions.connection);
        delete context.connOptions.connection;
      }

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
          [this.meta.keyField]: this._translateValue(options)
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

    normalizedOptions.$query = this._translateValue(normalizedOptions.$query, normalizedOptions.$variables);

    if (normalizedOptions.$groupBy) {
      if (_.isPlainObject(normalizedOptions.$groupBy)) {
        if (normalizedOptions.$groupBy.having) {
          normalizedOptions.$groupBy.having = this._translateValue(normalizedOptions.$groupBy.having, normalizedOptions.$variables);
        }
      }
    }

    if (normalizedOptions.$projection) {
      normalizedOptions.$projection = this._translateValue(normalizedOptions.$projection, normalizedOptions.$variables);
    }

    if (normalizedOptions.$association && !normalizedOptions.$relationships) {
      normalizedOptions.$relationships = this._prepareAssociations(normalizedOptions);
    }

    return normalizedOptions;
  }

  static async beforeCreate_(context) {
    return true;
  }

  static async beforeUpdate_(context) {
    return true;
  }

  static async beforeUpdateMany_(context) {
    return true;
  }

  static async beforeDelete_(context) {
    return true;
  }

  static async beforeDeleteMany_(context) {
    return true;
  }

  static async afterCreate_(context) {}

  static async afterUpdate_(context) {}

  static async afterUpdateMany_(context) {}

  static async afterDelete_(context) {}

  static async afterDeleteMany_(context) {}

  static async afterFindAll_(context, records) {
    if (context.findOptions.$toDictionary) {
      let keyField = this.meta.keyField;

      if (typeof context.findOptions.$toDictionary === 'string') {
        keyField = context.findOptions.$toDictionary;

        if (!(keyField in this.meta.fields)) {
          throw new OolongUsageError(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`);
        }
      }

      return records.reduce((table, v) => {
        table[v[keyField]] = v;
        return table;
      }, {});
    }

    return records;
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

  static _serializeByTypeInfo(value, info) {
    throw new Error(NEED_OVERRIDE);
  }

  static _translateValue(value, variables, skipSerialize) {
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

      return _.mapValues(value, v => this._translateValue(v, variables));
    }

    if (Array.isArray(value)) {
      return value.map(v => this._translateValue(v, variables));
    }

    if (skipSerialize) return value;
    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsInZhbHVlT2ZLZXkiLCJkYXRhIiwiQXJyYXkiLCJpc0FycmF5IiwibWV0YSIsImtleUZpZWxkIiwicGljayIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImtleSIsImNhY2hlZF8iLCJjYWNoZWREYXRhIiwiX2NhY2hlZERhdGFBbHRLZXkiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJfY2FjaGVkRGF0YSIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwibmFtZSIsIiRyZWxhdGlvbnNoaXBzIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJhc3NvY2lhdGlvbnMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJpc0VtcHR5IiwiYSIsInN1Y2Nlc3MiLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiYmVmb3JlQ3JlYXRlXyIsImxhdGVzdCIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJfY3JlYXRlQXNzb2NzXyIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsIm9taXQiLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsIlJVTEVfQkVGT1JFX0RFTEVURSIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIl90cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCJzdGF0dXMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCJ2YWx1ZSIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImlucHV0IiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaGFzRGVwZW5kcyIsImRlcCIsImQiLCJzdGFnZSIsImZpZWxkIiwic3BsaXQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrIiwiaXNQbGFpbk9iamVjdCIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCIkYnlQYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIiRhc3NvY2lhdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwicmVkdWNlIiwidGFibGUiLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFNlcmlhbGl6ZSIsIm9vclR5cGUiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwicHVzaCIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIm1hcCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DSCxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNSSxNQUFNLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLG1CQUFGO0FBQXVCQyxFQUFBQSxnQkFBdkI7QUFBeUNDLEVBQUFBLGdCQUF6QztBQUEyREMsRUFBQUE7QUFBM0QsSUFBNkVOLE1BQW5GOztBQUNBLE1BQU1PLFFBQVEsR0FBR1gsT0FBTyxDQUFDLGtCQUFELENB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LElBQWNrSixTQUFTLENBQUNmLEtBQTFCLENBQXhCLEVBQTBEO0FBQ3RELGtCQUFNLElBQUlqTSxnQkFBSixDQUFzQixvQkFBbUIwSyxLQUFLLENBQUM1RyxJQUFLLCtCQUFwRCxDQUFOO0FBQ0g7O0FBRUQsaUJBQU9rSixTQUFTLENBQUNmLEtBQVYsQ0FBZ0J2QixLQUFLLENBQUM1RyxJQUF0QixDQUFQO0FBQ0gsU0FWTSxNQVVBLElBQUk0RyxLQUFLLENBQUN3QyxPQUFOLEtBQWtCLGFBQXRCLEVBQXFDO0FBQ3hDLGlCQUFPLEtBQUtMLHFCQUFMLENBQTJCbkMsS0FBSyxDQUFDNUcsSUFBakMsQ0FBUDtBQUNIOztBQUVELGNBQU0sSUFBSTZJLEtBQUosQ0FBVSw0QkFBNEJqQyxLQUFLLENBQUN3QyxPQUE1QyxDQUFOO0FBQ0g7O0FBRUQsYUFBT3pOLENBQUMsQ0FBQ2dMLFNBQUYsQ0FBWUMsS0FBWixFQUFvQm1CLENBQUQsSUFBTyxLQUFLekIsZUFBTCxDQUFxQnlCLENBQXJCLEVBQXdCbUIsU0FBeEIsQ0FBMUIsQ0FBUDtBQUNIOztBQUVELFFBQUlsTSxLQUFLLENBQUNDLE9BQU4sQ0FBYzJKLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixhQUFPQSxLQUFLLENBQUMrQyxHQUFOLENBQVU1QixDQUFDLElBQUksS0FBS3pCLGVBQUwsQ0FBcUJ5QixDQUFyQixFQUF3Qm1CLFNBQXhCLENBQWYsQ0FBUDtBQUNIOztBQUVELFFBQUlDLGFBQUosRUFBbUIsT0FBT3ZDLEtBQVA7QUFFbkIsV0FBTyxLQUFLb0MsVUFBTCxDQUFnQnBDLEtBQWhCLENBQVA7QUFDSDs7QUFuaUNhOztBQXNpQ2xCZ0QsTUFBTSxDQUFDQyxPQUFQLEdBQWlCcE4sV0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgRGF0YVZhbGlkYXRpb25FcnJvciwgT29sb25nVXNhZ2VFcnJvciwgRHNPcGVyYXRpb25FcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4uL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4uL3V0aWxzL2xhbmcnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkgPyBfLnBpY2soZGF0YSwgdGhpcy5tZXRhLmtleUZpZWxkKSA6IGRhdGFbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiB0eXBlb2YgZGF0YSA9PT0gJ29iamVjdCc7XG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBuZXN0ZWQgb2JqZWN0IG9mIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwga2V5UGF0aCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IGNyZWF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQubGF0ZXN0IGJlIHRoZSBqdXN0IHVwZGF0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlVXBkYXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbnRleHQuZXhpc2ludGcgYmUgdGhlIGp1c3QgZGVsZXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVEZWxldGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIHVwY29taW5nIG9wZXJhdGlvbnMgYXJlIGV4ZWN1dGVkIGluIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBlbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCkge1xuICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IHZhbHVlIGZyb20gY29udGV4dCwgZS5nLiBzZXNzaW9uLCBxdWVyeSAuLi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGtleVxuICAgICAqIEByZXR1cm5zIHsqfSBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VmFsdWVGcm9tQ29udGV4dChjb250ZXh0LCBrZXkpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGNvbnRleHQsICdvcHRpb25zLiR2YXJpYWJsZXMuJyArIGtleSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGEgcGstaW5kZXhlZCBoYXNodGFibGUgd2l0aCBhbGwgdW5kZWxldGVkIGRhdGFcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY2FjaGVkXyhrZXksIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGFBbHRLZXkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhQWx0S2V5ID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhQWx0S2V5W2tleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhQWx0S2V5W2tleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHRvRGljdGlvbmFyeToga2V5IH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgIHJldHVybiBjYWNoZWREYXRhO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICR0b0RpY3Rpb25hcnk6IHRydWUgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX2NhY2hlZERhdGE7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5maW5kT3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGNyZWF0ZU9wdGlvbnMgfHwgKGNyZWF0ZU9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodGhpcy5tZXRhLm5hbWUgPT09ICdwYXJ0eScpIHtcbiAgICAgICAgICAgIGxldCBhID0gMTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5iZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEsIG9yIGNyZWF0ZSBvbmUgaWYgbm90IGZvdW5kLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi8gICAgXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIG9wdGlvbnM6IHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgcHJlOiBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBvcHRpb25zOiBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdG9EZWxldGU7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5vcHRpb25zLiRxdWVyeSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfREVMRVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5leGlzdGluZztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpKSB7XG4gICAgICAgICAgICB0aGlzLmVuc3VyZVJldHJpZXZlQ3JlYXRlZChjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmIChlcnJvci5zdGF0dXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgYEVycm9yIG9jY3VycmVkIGR1cmluZyBhcHBseWluZyBmZWF0dXJlIHJ1bGVzIHRvIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuIERldGFpbDogYCArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgeyBlcnJvcjogZXJyb3IgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlQYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0LmZpbmRPcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0LmZpbmRPcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5maW5kT3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZWNvcmRzLnJlZHVjZSgodGFibGUsIHYpID0+IHtcbiAgICAgICAgICAgICAgICB0YWJsZVt2W2tleUZpZWxkXV0gPSB2O1xuICAgICAgICAgICAgICAgIHJldHVybiB0YWJsZTtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxldGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYpID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUubWFwKHYgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=