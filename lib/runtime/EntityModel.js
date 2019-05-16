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
    if (!_.isPlainObject(data)) {
      throw new Error("Function  precondition failed: _.isPlainObject(data)");
    }

    let ukFields = this.getUniqueKeyFieldsFrom(data);
    return _.pick(data, ukFields);
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath);
  }

  static ensureRetrieveCreated(context, customOptions) {
    if (!context.createOptions.$retrieveCreated) {
      context.createOptions.$retrieveCreated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveUpdated(context, customOptions) {
    if (!context.updateOptions.$retrieveUpdated) {
      context.updateOptions.$retrieveUpdated = customOptions ? customOptions : true;
    }
  }

  static ensureRetrieveDeleted(context, customOptions) {
    if (!context.deleteOptions.$retrieveDeleted) {
      context.deleteOptions.$retrieveDeleted = customOptions ? customOptions : true;
    }
  }

  static async ensureTransaction_(context) {
    if (!context.connOptions || !context.connOptions.connection) {
      context.connOptions || (context.connOptions = {});
      context.connOptions.connection = await this.db.connector.beginTransaction_();
    }
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
      createOptions,
      connOptions
    };
    let needCreateAssocs = false;

    if (!_.isEmpty(associations)) {
      needCreateAssocs = true;
    }

    return this._safeExecute_(async context => {
      if (needCreateAssocs) {
        await this.ensureTransaction_(context);
      }

      await this._prepareEntityData_(context);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context))) {
        return context.latest;
      }

      if (!(await this.beforeCreate_(context))) {
        return context.latest;
      }

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
    let context = {
      raw: data,
      updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);

      if (!(await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context))) {
        return context.latest;
      }

      let toUpdate;

      if (forSingleRecord) {
        toUpdate = await this.beforeUpdate_(context);
      } else {
        toUpdate = await this.beforeUpdateMany_(context);
      }

      if (!toUpdate) {
        return context.latest;
      }

      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.updateOptions.$query, context.updateOptions, context.connOptions);

      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }

      return context.latest;
    }, context);
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
      updateOptions,
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
      deleteOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      if (!(await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context))) {
        return context.latest;
      }

      let toDelete;

      if (forSingleRecord) {
        toDelete = await this.beforeDelete_(context);
      } else {
        toDelete = await this.beforeDeleteMany_(context);
      }

      if (!toDelete) {
        return context.latest;
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

  static async afterCreate_(context) {
    let which = this.getUniqueKeyValuePairsFrom(context.latest);

    if (!!_.isEmpty(which)) {
      throw new Error("Assertion failed: !_.isEmpty(which)");
    }

    return this.afterChange_(context, which);
  }

  static async afterUpdate_(context) {
    let which = this.getUniqueKeyValuePairsFrom(context.updateOptions.$query);

    if (!!_.isEmpty(which)) {
      throw new Error("Assertion failed: !_.isEmpty(which)");
    }

    return this.afterChange_(context, which);
  }

  static async afterUpdateMany_(context) {
    return this.afterChangeMany_(context);
  }

  static async afterDelete_(context) {
    let which = this.getUniqueKeyValuePairsFrom(context.deleteOptions.$query);

    if (!!_.isEmpty(which)) {
      throw new Error("Assertion failed: !_.isEmpty(which)");
    }

    return this.afterChange_(context, which);
  }

  static async afterDeleteMany_(context) {
    return this.afterChangeMany_(context);
  }

  static async afterChange_(context, keyFields) {}

  static async afterChangeMany_(context) {}

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsInZhbHVlT2ZLZXkiLCJkYXRhIiwiQXJyYXkiLCJpc0FycmF5IiwibWV0YSIsImtleUZpZWxkIiwicGljayIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwiZW5zdXJlUmV0cmlldmVDcmVhdGVkIiwiY29udGV4dCIsImN1c3RvbU9wdGlvbnMiLCJjcmVhdGVPcHRpb25zIiwiJHJldHJpZXZlQ3JlYXRlZCIsImVuc3VyZVJldHJpZXZlVXBkYXRlZCIsInVwZGF0ZU9wdGlvbnMiLCIkcmV0cmlldmVVcGRhdGVkIiwiZW5zdXJlUmV0cmlldmVEZWxldGVkIiwiZGVsZXRlT3B0aW9ucyIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiY2FjaGVkXyIsImtleSIsImNhY2hlZERhdGEiLCJfY2FjaGVkRGF0YUFsdEtleSIsImZpbmRBbGxfIiwiJHRvRGljdGlvbmFyeSIsIl9jYWNoZWREYXRhIiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCJuYW1lIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsImxlbmd0aCIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwicmF3IiwiYXNzb2NpYXRpb25zIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiaXNFbXB0eSIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJsYXRlc3QiLCJiZWZvcmVDcmVhdGVfIiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVPbmVfIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJ1cGRhdGVNYW55XyIsImZvclNpbmdsZVJlY29yZCIsImNvbmRpdGlvbkZpZWxkcyIsIiRxdWVyeSIsIm9taXQiLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJ0b1VwZGF0ZSIsImJlZm9yZVVwZGF0ZV8iLCJiZWZvcmVVcGRhdGVNYW55XyIsInVwZGF0ZV8iLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwicmVwbGFjZU9uZV8iLCJfZG9SZXBsYWNlT25lXyIsImRlbGV0ZU9uZV8iLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwidG9EZWxldGUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsImV4aXN0aW5nIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJpc1VwZGF0aW5nIiwiaTE4biIsIm9wT3B0aW9ucyIsIl9kZXBlbmRzT25FeGlzdGluZ0RhdGEiLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJyZWFkT25seSIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsInNhbml0aXplIiwiZXJyb3IiLCJtZXNzYWdlIiwic3RhY2siLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiX3RyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsInN0YXR1cyIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsInZhbHVlIiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJzcGxpdCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieVBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiJGFzc29jaWF0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJ3aGljaCIsImFmdGVyQ2hhbmdlXyIsImFmdGVyQ2hhbmdlTWFueV8iLCJrZXlGaWVsZHMiLCJyZWR1Y2UiLCJ0YWJsZSIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwibWFwIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NILE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU1JLE1BQU0sR0FBR0osT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBQ0EsTUFBTUssVUFBVSxHQUFHTCxPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNTSxLQUFLLEdBQUdOLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsbUJBQUY7QUFBdUJDLEVBQUFBLGdCQUF2QjtBQUF5Q0MsRUFBQUEsZ0JBQXpDO0FBQTJEQyxFQUFBQTtBQUEzRCxJQUE2RU4sTUFBbkY7O0FBQ0EsTUFBTU8sUUFBUSxHQUFHWCxPQUFPLENBQUMsa0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVksS0FBSyxHQUFHWixPQUFPLENBQUMsZUFBRCxDQUFyQjs7QUFFQSxNQUFNO0FBQUVhLEVBQUFBO0FBQUYsSUFBZ0JiLE9BQU8sQ0FBQyxlQUFELENBQTdCOztBQUVBLE1BQU1jLGFBQWEsR0FBRyxrREFBdEI7O0FBTUEsTUFBTUMsV0FBTixDQUFrQjtBQUlkQyxFQUFBQSxXQUFXLENBQUNDLE9B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dHJpY3RcIjtcblxuY29uc3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBnZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgRGF0YVZhbGlkYXRpb25FcnJvciwgT29sb25nVXNhZ2VFcnJvciwgRHNPcGVyYXRpb25FcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4uL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4uL3V0aWxzL2xhbmcnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgdmFsdWVPZktleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkgPyBfLnBpY2soZGF0YSwgdGhpcy5tZXRhLmtleUZpZWxkKSA6IGRhdGFbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiBfLmlzUGxhaW5PYmplY3QoZGF0YSk7ICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIGtleVBhdGgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQuY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0LmNyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5kZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoa2V5KSB7XG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhQWx0S2V5KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YUFsdEtleSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhQWx0S2V5W2tleV0pIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YUFsdEtleVtrZXldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNhY2hlZERhdGEpIHtcbiAgICAgICAgICAgICAgICBjYWNoZWREYXRhID0gdGhpcy5fY2FjaGVkRGF0YUFsdEtleVtrZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICR0b0RpY3Rpb25hcnk6IGtleSB9LCBjb25uT3B0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICByZXR1cm4gY2FjaGVkRGF0YTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiB0cnVlIH0sIGNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9jYWNoZWREYXRhO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzZXJ0OiByZWNvcmRzLmxlbmd0aCA9PT0gMTtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiByZWNvcmRzLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmICghKGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCkpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQudXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YSwgb3IgY3JlYXRlIG9uZSBpZiBub3QgZm91bmQuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqLyAgICBcbiAgICBzdGF0aWMgYXN5bmMgcmVwbGFjZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2RvUmVwbGFjZU9uZV8oY29udGV4dCk7IC8vIGRpZmZlcmVudCBkYm1zIGhhcyBkaWZmZXJlbnQgcmVwbGFjaW5nIHN0cmF0ZWd5XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU9uZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZU1hbnlfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBwcmU6IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5kZWxldGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5leGlzdGluZztcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIGxldCBoYXNLZXlOYW1lT25seSA9IGZhbHNlO1xuXG4gICAgICAgIGxldCBoYXNOb3ROdWxsS2V5ID0gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4ge1xuICAgICAgICAgICAgbGV0IGhhc0tleXMgPSBfLmV2ZXJ5KGZpZWxkcywgZiA9PiBmIGluIGRhdGEpO1xuICAgICAgICAgICAgaGFzS2V5TmFtZU9ubHkgPSBoYXNLZXlOYW1lT25seSB8fCBoYXNLZXlzO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpO1xuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gWyBoYXNOb3ROdWxsS2V5LCBoYXNLZXlOYW1lT25seSBdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IFsgY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSwgY29udGFpbnNVbmlxdWVLZXlPbmx5IF0gPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoY29udGFpbnNVbmlxdWVLZXlPbmx5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoJ09uZSBvZiB0aGUgdW5pcXVlIGtleSBmaWVsZCBhcyBxdWVyeSBjb25kaXRpb24gaXMgbnVsbC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbjogJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGNvbmRpdGlvbiB0byBiZSBjb250YWluaW5nIHVuaXF1ZSBrZXkuJyxcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGlzVXBkYXRpbmcgPyBjb250ZXh0LnVwZGF0ZU9wdGlvbnMgOiBjb250ZXh0LmNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgdGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykpIHtcbiAgICAgICAgICAgIHRoaXMuZW5zdXJlUmV0cmlldmVDcmVhdGVkKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBhd2FpdCBlYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieVBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3lcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHJhd1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUocmF3W2ZpZWxkTmFtZV0sIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8IGVycm9yLnN0YWNrIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnR0aXkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmUgcnVsZXMgdG8gZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi4gRGV0YWlsOiBgICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICB7IGVycm9yOiBlcnJvciB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgY29tbWl0IG9yIHJvbGxiYWNrIGlzIGNhbGxlZCBpZiB0cmFuc2FjdGlvbiBpcyBjcmVhdGVkIHdpdGhpbiB0aGUgZXhlY3V0b3IuXG4gICAgICogQHBhcmFtIHsqfSBleGVjdXRvciBcbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiBpbnB1dCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgWyBzdGFnZSwgZmllbGQgXSA9IGQuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAoc3RhZ2UgPT09ICdsYXRlc3QnIHx8IHN0YWdlID09PSAnZXhpc3RuZycpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLl90cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieVBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhbm9ybWFsaXplZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhub3JtYWxpemVkT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGNyZWF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSB1cGRhdGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIGRlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgbGV0IHdoaWNoID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgYXNzZXJ0OiAhXy5pc0VtcHR5KHdoaWNoKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5hZnRlckNoYW5nZV8oY29udGV4dCwgd2hpY2gpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGxldCB3aGljaCA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSk7XG5cbiAgICAgICAgYXNzZXJ0OiAhXy5pc0VtcHR5KHdoaWNoKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5hZnRlckNoYW5nZV8oY29udGV4dCwgd2hpY2gpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hZnRlckNoYW5nZU1hbnlfKGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGxldCB3aGljaCA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5kZWxldGVPcHRpb25zLiRxdWVyeSk7XG5cbiAgICAgICAgYXNzZXJ0OiAhXy5pc0VtcHR5KHdoaWNoKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5hZnRlckNoYW5nZV8oY29udGV4dCwgd2hpY2gpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdGhpcy5hZnRlckNoYW5nZU1hbnlfKGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlL3VwZGF0ZS9kZWxldGUgcHJvY2Vzc2luZ1xuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNoYW5nZV8oY29udGV4dCwga2V5RmllbGRzKSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUvdXBkYXRlL2RlbGV0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNoYW5nZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGZpbmRBbGwgcHJvY2Vzc2luZ1xuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IHJlY29yZHMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcykge1xuICAgICAgICBpZiAoY29udGV4dC5maW5kT3B0aW9ucy4kdG9EaWN0aW9uYXJ5KSB7XG4gICAgICAgICAgICBsZXQga2V5RmllbGQgPSB0aGlzLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0eXBlb2YgY29udGV4dC5maW5kT3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQuZmluZE9wdGlvbnMuJHRvRGljdGlvbmFyeTsgXG5cbiAgICAgICAgICAgICAgICBpZiAoIShrZXlGaWVsZCBpbiB0aGlzLm1ldGEuZmllbGRzKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGtleSBmaWVsZCBcIiR7a2V5RmllbGR9XCIgcHJvdmlkZWQgdG8gaW5kZXggdGhlIGNhY2hlZCBkaWN0aW9uYXJ5IGlzIG5vdCBhIGZpZWxkIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmVjb3Jkcy5yZWR1Y2UoKHRhYmxlLCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgdGFibGVbdltrZXlGaWVsZF1dID0gdjtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGFibGU7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHJlY29yZHM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcywgc2tpcFNlcmlhbGl6ZSkge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2KSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBTZXJpYWxpemUpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19