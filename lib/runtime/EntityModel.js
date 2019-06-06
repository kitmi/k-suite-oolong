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

function minifyAssocs(assocs) {
  let sorted = _.uniq(assocs).sort().reverse();

  let minified = _.take(sorted, 1),
      l = sorted.length - 1;

  for (let i = 1; i < l; i++) {
    let k = sorted[i] + '.';

    if (!_.find(minified, a => a.startsWith(k))) {
      minified.push(sorted[i]);
    }
  }

  return minified;
}

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

  static async cached_(key, associations, connOptions) {
    if (key) {
      let combinedKey = key;

      if (!_.isEmpty(associations)) {
        combinedKey += '/' + minifyAssocs(associations).join('&');
      }

      let cachedData;

      if (!this._cachedData) {
        this._cachedData = {};
      } else if (this._cachedData[combinedKey]) {
        cachedData = this._cachedData[combinedKey];
      }

      if (!cachedData) {
        cachedData = this._cachedData[combinedKey] = await this.findAll_({
          $association: associations,
          $toDictionary: key
        }, connOptions);
      }

      return cachedData;
    }

    return this.cached_(this.meta.keyField, associations, connOptions);
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
      await this.ensureTransaction_(context);
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

    normalizedOptions.$query = this._translateValue(normalizedOptions.$query, normalizedOptions.$variables, null, true);

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

  static _translateValue(value, variables, skipSerialize, arrayToInOperator) {
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

      return _.mapValues(value, (v, k) => this._translateValue(v, variables, skipSerialize, arrayToInOperator && k[0] !== '$'));
    }

    if (Array.isArray(value)) {
      let ret = value.map(v => this._translateValue(v, variables, skipSerialize, arrayToInOperator));
      return arrayToInOperator ? {
        $in: ret
      } : ret;
    }

    if (skipSerialize) return value;
    return this._serialize(value);
  }

}

module.exports = EntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCJ2YWx1ZU9mS2V5IiwiZGF0YSIsIkFycmF5IiwiaXNBcnJheSIsIm1ldGEiLCJrZXlGaWVsZCIsInBpY2siLCJnZXRVbmlxdWVLZXlGaWVsZHNGcm9tIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImtleSIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCJuYW1lIiwiJHJlbGF0aW9uc2hpcHMiLCIkc2tpcE9ybSIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJsYXRlc3QiLCJmcmVlemUiLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiX2NyZWF0ZUFzc29jc18iLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJ0b0RlbGV0ZSIsImJlZm9yZURlbGV0ZV8iLCJiZWZvcmVEZWxldGVNYW55XyIsIlJVTEVfQkVGT1JFX0RFTEVURSIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiUlVMRV9BRlRFUl9ERUxFVEUiLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJlcnJvciIsIm1lc3NhZ2UiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwic3RhdHVzIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwidmFsdWUiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsInNwbGl0IiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2IiwiaXNQbGFpbk9iamVjdCIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCIkYnlwYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwicmVkdWNlIiwidGFibGUiLCJFcnJvciIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJpbmZvIiwidmFyaWFibGVzIiwic2tpcFNlcmlhbGl6ZSIsImFycmF5VG9Jbk9wZXJhdG9yIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCJtYXAiLCIkaW4iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0gsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFB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bEo7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUl5SSxhQUFKLEVBQW1CLE9BQU9wQyxLQUFQO0FBRW5CLFdBQU8sS0FBS2lDLFVBQUwsQ0FBZ0JqQyxLQUFoQixDQUFQO0FBQ0g7O0FBdGtDYTs7QUF5a0NsQjhDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnhOLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IsIE9vbG9uZ1VzYWdlRXJyb3IsIERzT3BlcmF0aW9uRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpID8gXy5waWNrKGRhdGEsIHRoaXMubWV0YS5rZXlGaWVsZCkgOiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIGtleVBhdGgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgb3B0aW9uczogY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghKGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7IFxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY29udGV4dC5sYXRlc3QgPSBPYmplY3QuZnJlZXplKGNvbnRleHQubGF0ZXN0KTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9DUkVBVEUsIHRoaXMsIGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChzdWNjZXNzKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5cGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgbWFueSBleGlzdGluZyBlbnRpdGVzIHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7ICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHJlcGxhY2luZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7IC4uLnVwZGF0ZU9wdGlvbnMsICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICBvcHRpb25zOiB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZG9SZXBsYWNlT25lXyhjb250ZXh0KTsgLy8gZGlmZmVyZW50IGRibXMgaGFzIGRpZmZlcmVudCByZXBsYWNpbmcgc3RyYXRlZ3lcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIHByZTogZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlwYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMsIHRydWUpO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGlmIChlcnJvci5zdGF0dXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgYEVycm9yIG9jY3VycmVkIGR1cmluZyBhcHBseWluZyBmZWF0dXJlIHJ1bGVzIHRvIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuIERldGFpbDogYCArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgeyBlcnJvcjogZXJyb3IgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZWNvcmRzLnJlZHVjZSgodGFibGUsIHYpID0+IHtcbiAgICAgICAgICAgICAgICB0YWJsZVt2W2tleUZpZWxkXV0gPSB2O1xuICAgICAgICAgICAgICAgIHJldHVybiB0YWJsZTtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplLCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0gdmFsdWUubWFwKHYgPT4gdGhpcy5fdHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplLCBhcnJheVRvSW5PcGVyYXRvcikpO1xuICAgICAgICAgICAgcmV0dXJuIGFycmF5VG9Jbk9wZXJhdG9yID8geyAkaW46IHJldCB9IDogcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBTZXJpYWxpemUpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19