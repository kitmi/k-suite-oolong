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
      options: findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);
    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.options, context.connOptions);
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
      options: findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);
    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.options, context.connOptions);
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

    if (!(await this.beforeCreate_(context))) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
      }

      await this._prepareEntityData_(context);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context))) {
        return false;
      }

      if (!(await this._internalBeforeCreate_(context))) {
        return false;
      }

      context.latest = Object.freeze(context.latest);
      context.result = await this.db.connector.create_(this.meta.name, context.latest, context.connOptions);
      context.return = context.latest;
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

    return context.return;
  }

  static async updateOne_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$bypassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions, true);
  }

  static async updateMany_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$bypassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
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
    let toUpdate;

    if (forSingleRecord) {
      toUpdate = await this.beforeUpdate_(context);
    } else {
      toUpdate = await this.beforeUpdateMany_(context);
    }

    if (!toUpdate) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context))) {
        return false;
      }

      if (forSingleRecord) {
        toUpdate = await this._internalBeforeUpdate_(context);
      } else {
        toUpdate = await this._internalBeforeUpdateMany_(context);
      }

      if (!toUpdate) {
        return false;
      }

      context.latest = Object.freeze(context.latest);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.options.$query, context.options, context.connOptions);
      context.return = context.latest;

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

    return context.return;
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
    let toDelete;

    if (forSingleRecord) {
      toDelete = await this.beforeDelete_(context);
    } else {
      toDelete = await this.beforeDeleteMany_(context);
    }

    if (!toDelete) {
      return context.return;
    }

    let success = await this._safeExecute_(async context => {
      if (!(await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context))) {
        return false;
      }

      if (forSingleRecord) {
        toDelete = await this._internalBeforeDelete_(context);
      } else {
        toDelete = await this._internalBeforeDeleteMany_(context);
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
        if (forSingleRecord) {
          context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
        } else {
          context.queryKey = context.options.$query;
        }
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

    return context.return;
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
          if (!isUpdating || !opOptions.$bypassReadOnly.has(fieldName)) {
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

    if (forSingleRecord && !options.$bypassEnsureUnique) {
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
    if (context.options.$toDictionary) {
      let keyField = this.meta.keyField;

      if (typeof context.options.$toDictionary === 'string') {
        keyField = context.options.$toDictionary;

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsInZhbHVlT2ZLZXkiLCJkYXRhIiwiQXJyYXkiLCJpc0FycmF5IiwibWV0YSIsImtleUZpZWxkIiwicGljayIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImtleSIsImNhY2hlZF8iLCJjYWNoZWREYXRhIiwiX2NhY2hlZERhdGFBbHRLZXkiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJfY2FjaGVkRGF0YSIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImZpbmRfIiwibmFtZSIsIiRyZWxhdGlvbnNoaXBzIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJhc3NvY2lhdGlvbnMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJpc0VtcHR5IiwiYmVmb3JlQ3JlYXRlXyIsInJldHVybiIsInN1Y2Nlc3MiLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsImxhdGVzdCIsImZyZWV6ZSIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsInF1ZXJ5S2V5IiwiUlVMRV9BRlRFUl9DUkVBVEUiLCJfY3JlYXRlQXNzb2NzXyIsImFmdGVyQ3JlYXRlXyIsInVwZGF0ZU9uZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5cGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsIm9taXQiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsIlJVTEVfQkVGT1JFX1VQREFURSIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsInVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZV8iLCJfaW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfIiwiUlVMRV9BRlRFUl9VUERBVEUiLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJkZWxldGVPcHRpb25zIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsInRvRGVsZXRlIiwiYmVmb3JlRGVsZXRlXyIsImJlZm9yZURlbGV0ZU1hbnlfIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiZGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJSVUxFX0FGVEVSX0RFTEVURSIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsImlzVXBkYXRpbmciLCJpMThuIiwiZXhpc3RpbmciLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsIl90cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCJzdGF0dXMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCJ2YWx1ZSIsIl9zZXJpYWxpemVCeVR5cGVJbmZvIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImlucHV0IiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaGFzRGVwZW5kcyIsImRlcCIsImQiLCJzdGFnZSIsImZpZWxkIiwic3BsaXQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrIiwiaXNQbGFpbk9iamVjdCIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIiRhc3NvY2lhdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwicmVkdWNlIiwidGFibGUiLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFNlcmlhbGl6ZSIsIm9vclR5cGUiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwicHVzaCIsIm1pc3NpbmdTdGF0dXMiLCJCQURfUkVRVUVTVCIsIm1hcCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DSCxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNSSxNQUFNLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMsU0FBRCxD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cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18sIGdldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSA/IF8ucGljayhkYXRhLCB0aGlzLm1ldGEua2V5RmllbGQpIDogZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IHR5cGVvZiBkYXRhID09PSAnb2JqZWN0JztcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IG5lc3RlZCBvYmplY3Qgb2YgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgY3JlYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5sYXRlc3QgYmUgdGhlIGp1c3QgdXBkYXRlZCBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gY3VzdG9tT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgZW5zdXJlUmV0cmlldmVVcGRhdGVkKGNvbnRleHQsIGN1c3RvbU9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkge1xuICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgPSBjdXN0b21PcHRpb25zID8gY3VzdG9tT3B0aW9ucyA6IHRydWU7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29udGV4dC5leGlzaW50ZyBiZSB0aGUganVzdCBkZWxldGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZURlbGV0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgdXBjb21pbmcgb3BlcmF0aW9ucyBhcmUgZXhlY3V0ZWQgaW4gYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdmFsdWUgZnJvbSBjb250ZXh0LCBlLmcuIHNlc3Npb24sIHF1ZXJ5IC4uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30ga2V5XG4gICAgICogQHJldHVybnMgeyp9IFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRWYWx1ZUZyb21Db250ZXh0KGNvbnRleHQsIGtleSkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoY29udGV4dCwgJ29wdGlvbnMuJHZhcmlhYmxlcy4nICsga2V5KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgYSBway1pbmRleGVkIGhhc2h0YWJsZSB3aXRoIGFsbCB1bmRlbGV0ZWQgZGF0YVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjYWNoZWRfKGtleSwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKGtleSkge1xuICAgICAgICAgICAgbGV0IGNhY2hlZERhdGE7XG5cbiAgICAgICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YUFsdEtleSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGFBbHRLZXkgPSB7fTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAodGhpcy5fY2FjaGVkRGF0YUFsdEtleVtrZXldKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHRvRGljdGlvbmFyeTogdHJ1ZSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fY2FjaGVkRGF0YTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHsqfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kT25lXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgXG4gICAgICAgIHByZTogZmluZE9wdGlvbnM7XG5cbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG4gICAgICAgIFxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zOiBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzZXJ0OiByZWNvcmRzLmxlbmd0aCA9PT0gMTtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiByZWNvcmRzLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRvZmZzZXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0Lm9mZnNldCA9IGZpbmRPcHRpb25zLiRvZmZzZXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghaXNOb3RoaW5nKGZpbmRPcHRpb25zLiRsaW1pdCkpIHtcbiAgICAgICAgICAgICAgICByZXQubGltaXQgPSBmaW5kT3B0aW9ucy4kbGltaXQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGNyZWF0ZU9wdGlvbnMgfHwgKGNyZWF0ZU9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIG1hbnkgZXhpc3RpbmcgZW50aXRlcyB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvVXBkYXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5iZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b1VwZGF0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8pOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IE9iamVjdC5mcmVlemUoY29udGV4dC5sYXRlc3QpO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9VUERBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgb3B0aW9uczogdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBwcmU6IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIG9wdGlvbnM6IGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIGxldCB0b0RlbGV0ZTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHN1Y2Nlc3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7IFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LnF1ZXJ5S2V5KSB7XG4gICAgICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfREVMRVRFLCB0aGlzLCBjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbjogJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGNvbmRpdGlvbiB0byBiZSBjb250YWluaW5nIHVuaXF1ZSBrZXkuJyxcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgdGhpcy5lbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1VwZGF0aW5nIHx8ICFvcE9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeVxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcocmF3W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZShyYXdbZmllbGROYW1lXSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfHwgZXJyb3Iuc3RhY2sgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudHRpeSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGF0ZXN0ID0gY29udGV4dC5sYXRlc3QgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzLCB0cnVlKTtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBpZiAoZXJyb3Iuc3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgIGBFcnJvciBvY2N1cnJlZCBkdXJpbmcgYXBwbHlpbmcgZmVhdHVyZSBydWxlcyB0byBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLiBEZXRhaWw6IGAgKyBlcnJvci5tZXNzYWdlLFxuICAgICAgICAgICAgICAgIHsgZXJyb3I6IGVycm9yIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcblxuICAgICAgICAvL2ZpbmFsIHJvdW5kIHByb2Nlc3MgYmVmb3JlIGVudGVyaW5nIGRhdGFiYXNlXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gXy5tYXBWYWx1ZXMobGF0ZXN0LCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgbGV0IGZpZWxkSW5mbyA9IGZpZWxkc1trZXldO1xuICAgICAgICAgICAgYXNzZXJ0OiBmaWVsZEluZm87XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb21taXQgb3Igcm9sbGJhY2sgaXMgY2FsbGVkIGlmIHRyYW5zYWN0aW9uIGlzIGNyZWF0ZWQgd2l0aGluIHRoZSBleGVjdXRvci5cbiAgICAgKiBAcGFyYW0geyp9IGV4ZWN1dG9yIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgZGVsZXRlIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbjsgICBcbiAgICAgICAgICAgIH0gICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIGlucHV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBbIHN0YWdlLCBmaWVsZCBdID0gZC5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIChzdGFnZSA9PT0gJ2xhdGVzdCcgfHwgc3RhZ2UgPT09ICdleGlzdG5nJykgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgIW9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKG5vcm1hbGl6ZWRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgY3JlYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGZpbmRBbGwgcHJvY2Vzc2luZ1xuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IHJlY29yZHMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcykge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSA9PT0gJ3N0cmluZycpIHsgXG4gICAgICAgICAgICAgICAga2V5RmllbGQgPSBjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeTsgXG5cbiAgICAgICAgICAgICAgICBpZiAoIShrZXlGaWVsZCBpbiB0aGlzLm1ldGEuZmllbGRzKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVjb3Jkcy5yZWR1Y2UoKHRhYmxlLCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgdGFibGVbdltrZXlGaWVsZF1dID0gdjtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGFibGU7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFNlcmlhbGl6ZSkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2KSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBTZXJpYWxpemUpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19