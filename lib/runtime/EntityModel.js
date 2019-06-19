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

const oorTypesToBypass = new Set(['ColumnReference', 'Function', 'BinaryExpression']);

class EntityModel {
  constructor(rawData) {
    if (rawData) {
      Object.assign(this, rawData);
    }
  }

  static valueOfKey(data) {
    return Array.isArray(this.meta.keyField) ? _.pick(data, this.meta.keyField) : data[this.meta.keyField];
  }

  static queryColumn(name) {
    return {
      oorType: 'ColumnReference',
      name
    };
  }

  static queryBinExpr(left, op, right) {
    return {
      oorType: 'BinaryExpression',
      left,
      op,
      right
    };
  }

  static queryFunction(name, ...args) {
    return {
      oorType: 'Function',
      name,
      args
    };
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
    let rawOptions = createOptions;

    if (!createOptions) {
      createOptions = {};
    }

    let [raw, associations] = this._extractAssociations(data);

    let context = {
      raw,
      rawOptions,
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
    let rawOptions = updateOptions;

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

    let context = {
      raw: data,
      rawOptions,
      options: this._prepareQueries(updateOptions, forSingleRecord),
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
    let rawOptions = updateOptions;

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
      rawOptions,
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
    let rawOptions = deleteOptions;
    deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord);

    if (_.isEmpty(deleteOptions.$query)) {
      throw new OolongUsageError('Empty condition is not allowed for deleting an entity.');
    }

    let context = {
      rawOptions,
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
        let value = raw[fieldName];

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

        if (isNothing(value)) {
          if (!fieldInfo.optional) {
            throw new DataValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
              entity: name,
              fieldInfo: fieldInfo
            });
          }

          latest[fieldName] = null;
        } else {
          if (_.isPlainObject(value) && value.oorType) {
            latest[fieldName] = value;
            return;
          }

          try {
            latest[fieldName] = Types.sanitize(value, fieldInfo, i18n);
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

      if (_.isPlainObject(value) && value.oorType) {
        opOptions.$requireSplitColumns = true;
        return value;
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
        if (oorTypesToBypass.has(value.oorType)) return value;

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJtaW5pZnlBc3NvY3MiLCJhc3NvY3MiLCJzb3J0ZWQiLCJ1bmlxIiwic29ydCIsInJldmVyc2UiLCJtaW5pZmllZCIsInRha2UiLCJsIiwibGVuZ3RoIiwiaSIsImsiLCJmaW5kIiwiYSIsInN0YXJ0c1dpdGgiLCJwdXNoIiwib29yVHlwZXNUb0J5cGFzcyIsIlNldCIsIkVudGl0eU1vZGVsIiwiY29uc3RydWN0b3IiLCJyYXdEYXRhIiwiT2JqZWN0IiwiYXNzaWduIiwidmFsdWVPZktleSIsImRhdGEiLCJBcnJheSIsImlzQXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwaWNrIiwicXVlcnlDb2x1bW4iLCJuYW1lIiwib29yVHlwZSIsInF1ZXJ5QmluRXhwciIsImxlZnQiLCJvcCIsInJpZ2h0IiwicXVlcnlGdW5jdGlvbiIsImFyZ3MiLCJnZXRVbmlxdWVLZXlGaWVsZHNGcm9tIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQiLCJjb250ZXh0IiwiY3VzdG9tT3B0aW9ucyIsIm9wdGlvbnMiLCIkcmV0cmlldmVDcmVhdGVkIiwiZW5zdXJlUmV0cmlldmVVcGRhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsImVuc3VyZVJldHJpZXZlRGVsZXRlZCIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJlbnN1cmVUcmFuc2FjdGlvbl8iLCJjb25uT3B0aW9ucyIsImNvbm5lY3Rpb24iLCJkYiIsImNvbm5lY3RvciIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZ2V0VmFsdWVGcm9tQ29udGV4dCIsImtleSIsImNhY2hlZF8iLCJhc3NvY2lhdGlvbnMiLCJjb21iaW5lZEtleSIsImlzRW1wdHkiLCJqb2luIiwiY2FjaGVkRGF0YSIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkYXNzb2NpYXRpb24iLCIkdG9EaWN0aW9uYXJ5IiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZmluZF8iLCIkcmVsYXRpb25zaGlwcyIsIiRza2lwT3JtIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyZXN1bHQiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3T3B0aW9ucyIsInJhdyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImJlZm9yZUNyZWF0ZV8iLCJyZXR1cm4iLCJzdWNjZXNzIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJsYXRlc3QiLCJmcmVlemUiLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJxdWVyeUtleSIsIlJVTEVfQUZURVJfQ1JFQVRFIiwiX2NyZWF0ZUFzc29jc18iLCJhZnRlckNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieXBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwidG9VcGRhdGUiLCJiZWZvcmVVcGRhdGVfIiwiYmVmb3JlVXBkYXRlTWFueV8iLCJSVUxFX0JFRk9SRV9VUERBVEUiLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVfIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8iLCJ1cGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsIlJVTEVfQUZURVJfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiYWZ0ZXJVcGRhdGVNYW55XyIsInJlcGxhY2VPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIl9kZWxldGVfIiwiZGVsZXRlTWFueV8iLCJ0b0RlbGV0ZSIsImJlZm9yZURlbGV0ZV8iLCJiZWZvcmVEZWxldGVNYW55XyIsIlJVTEVfQkVGT1JFX0RFTEVURSIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsImRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZV8iLCJfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfIiwiUlVMRV9BRlRFUl9ERUxFVEUiLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJpc1VwZGF0aW5nIiwiaTE4biIsImV4aXN0aW5nIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInZhbHVlIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJpc1BsYWluT2JqZWN0Iiwic2FuaXRpemUiLCJlcnJvciIsIm1lc3NhZ2UiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJfdHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwic3RhdHVzIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwiJHJlcXVpcmVTcGxpdENvbHVtbnMiLCJfc2VyaWFsaXplQnlUeXBlSW5mbyIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsInNwbGl0IiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkZ3JvdXBCeSIsImhhdmluZyIsIiRwcm9qZWN0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJyZWR1Y2UiLCJ0YWJsZSIsIkVycm9yIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsImluZm8iLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwiYXJyYXlUb0luT3BlcmF0b3IiLCJzZXNzaW9uIiwiZXJyQXJncyIsIm1pc3NpbmdNZXNzYWdlIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwibWFwIiwiJGluIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxR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Q0FBUDtBQUNIOztBQUVELFFBQUljLEtBQUssQ0FBQ0MsT0FBTixDQUFjc0osS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLFVBQUlsRixHQUFHLEdBQUdrRixLQUFLLENBQUNnRSxHQUFOLENBQVV2QixDQUFDLElBQUksS0FBS3pCLGVBQUwsQ0FBcUJ5QixDQUFyQixFQUF3QmUsU0FBeEIsRUFBbUNDLGFBQW5DLEVBQWtEQyxpQkFBbEQsQ0FBZixDQUFWO0FBQ0EsYUFBT0EsaUJBQWlCLEdBQUc7QUFBRU8sUUFBQUEsR0FBRyxFQUFFbko7QUFBUCxPQUFILEdBQWtCQSxHQUExQztBQUNIOztBQUVELFFBQUkySSxhQUFKLEVBQW1CLE9BQU96RCxLQUFQO0FBRW5CLFdBQU8sS0FBS3NELFVBQUwsQ0FBZ0J0RCxLQUFoQixDQUFQO0FBQ0g7O0FBeG5DYTs7QUEybkNsQmtFLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmpPLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXywgZ2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IsIE9vbG9uZ1VzYWdlRXJyb3IsIERzT3BlcmF0aW9uRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuZnVuY3Rpb24gbWluaWZ5QXNzb2NzKGFzc29jcykge1xuICAgIGxldCBzb3J0ZWQgPSBfLnVuaXEoYXNzb2NzKS5zb3J0KCkucmV2ZXJzZSgpO1xuXG4gICAgbGV0IG1pbmlmaWVkID0gXy50YWtlKHNvcnRlZCwgMSksIGwgPSBzb3J0ZWQubGVuZ3RoIC0gMTtcblxuICAgIGZvciAobGV0IGkgPSAxOyBpIDwgbDsgaSsrKSB7XG4gICAgICAgIGxldCBrID0gc29ydGVkW2ldICsgJy4nO1xuXG4gICAgICAgIGlmICghXy5maW5kKG1pbmlmaWVkLCBhID0+IGEuc3RhcnRzV2l0aChrKSkpIHtcbiAgICAgICAgICAgIG1pbmlmaWVkLnB1c2goc29ydGVkW2ldKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHJldHVybiBtaW5pZmllZDtcbn1cblxuY29uc3Qgb29yVHlwZXNUb0J5cGFzcyA9IG5ldyBTZXQoWydDb2x1bW5SZWZlcmVuY2UnLCAnRnVuY3Rpb24nLCAnQmluYXJ5RXhwcmVzc2lvbiddKTtcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIHZhbHVlT2ZLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpID8gXy5waWNrKGRhdGEsIHRoaXMubWV0YS5rZXlGaWVsZCkgOiBkYXRhW3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgfVxuXG4gICAgc3RhdGljIHF1ZXJ5Q29sdW1uKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLFxuICAgICAgICAgICAgbmFtZVxuICAgICAgICB9OyBcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVlcnlCaW5FeHByKGxlZnQsIG9wLCByaWdodCkge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb29yVHlwZTogJ0JpbmFyeUV4cHJlc3Npb24nLFxuICAgICAgICAgICAgbGVmdCxcbiAgICAgICAgICAgIG9wLFxuICAgICAgICAgICAgcmlnaHRcbiAgICAgICAgfTsgXG4gICAgfVxuXG4gICAgc3RhdGljIHF1ZXJ5RnVuY3Rpb24obmFtZSwgLi4uYXJncykge1xuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgb29yVHlwZTogJ0Z1bmN0aW9uJyxcbiAgICAgICAgICAgIG5hbWUsXG4gICAgICAgICAgICBhcmdzXG4gICAgICAgIH07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogdHlwZW9mIGRhdGEgPT09ICdvYmplY3QnO1xuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgbmVzdGVkIG9iamVjdCBvZiBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIGtleVBhdGgpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCBjcmVhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZUNyZWF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmxhdGVzdCBiZSB0aGUganVzdCB1cGRhdGVkIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHsqfSBjdXN0b21PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBlbnN1cmVSZXRyaWV2ZVVwZGF0ZWQoY29udGV4dCwgY3VzdG9tT3B0aW9ucykge1xuICAgICAgICBpZiAoIWNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7XG4gICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCA9IGN1c3RvbU9wdGlvbnMgPyBjdXN0b21PcHRpb25zIDogdHJ1ZTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSBjb250ZXh0LmV4aXNpbnRnIGJlIHRoZSBqdXN0IGRlbGV0ZWQgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0geyp9IGN1c3RvbU9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGVuc3VyZVJldHJpZXZlRGVsZXRlZChjb250ZXh0LCBjdXN0b21PcHRpb25zKSB7XG4gICAgICAgIGlmICghY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHtcbiAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkID0gY3VzdG9tT3B0aW9ucyA/IGN1c3RvbU9wdGlvbnMgOiB0cnVlO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSB1cGNvbWluZyBvcGVyYXRpb25zIGFyZSBleGVjdXRlZCBpbiBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCB2YWx1ZSBmcm9tIGNvbnRleHQsIGUuZy4gc2Vzc2lvbiwgcXVlcnkgLi4uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBrZXlcbiAgICAgKiBAcmV0dXJucyB7Kn0gXG4gICAgICovXG4gICAgc3RhdGljIGdldFZhbHVlRnJvbUNvbnRleHQoY29udGV4dCwga2V5KSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChjb250ZXh0LCAnb3B0aW9ucy4kdmFyaWFibGVzLicgKyBrZXkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5LCBhc3NvY2lhdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjb21iaW5lZEtleSA9IGtleTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGNvbWJpbmVkS2V5ICs9ICcvJyArIG1pbmlmeUFzc29jcyhhc3NvY2lhdGlvbnMpLmpvaW4oJyYnKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgY2FjaGVkRGF0YTtcblxuICAgICAgICAgICAgaWYgKCF0aGlzLl9jYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IHt9O1xuICAgICAgICAgICAgfSBlbHNlIGlmICh0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhW2NvbWJpbmVkS2V5XTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFjYWNoZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgY2FjaGVkRGF0YSA9IHRoaXMuX2NhY2hlZERhdGFbY29tYmluZWRLZXldID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7ICRhc3NvY2lhdGlvbjogYXNzb2NpYXRpb25zLCAkdG9EaWN0aW9uYXJ5OiBrZXkgfSwgY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuY2FjaGVkXyh0aGlzLm1ldGEua2V5RmllbGQsIGFzc29jaWF0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnM6IGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9uczogZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBjcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghY3JlYXRlT3B0aW9ucykgeyBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMgPSB7fTsgXG4gICAgICAgIH1cblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIShhd2FpdCB0aGlzLmJlZm9yZUNyZWF0ZV8oY29udGV4dCkpKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyBcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7ICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghKGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5sYXRlc3Q7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5cGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieXBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIG1hbnkgZXhpc3RpbmcgZW50aXRlcyB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gdXBkYXRlT3B0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5PcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVNYW55XyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieXBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlwYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSB1cGRhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHJhd09wdGlvbnMsXG4gICAgICAgICAgICBvcHRpb25zOiB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pLCAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgdG9VcGRhdGU7XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdG9VcGRhdGUgPSBhd2FpdCB0aGlzLmJlZm9yZVVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRvVXBkYXRlKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5yZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBzdWNjZXNzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoIShhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvVXBkYXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b1VwZGF0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9VcGRhdGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gT2JqZWN0LmZyZWV6ZShjb250ZXh0LmxhdGVzdCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7ICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmxhdGVzdDtcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2ludGVybmFsQWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY29udGV4dC5xdWVyeUtleSkge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1VQREFURSwgdGhpcywgY29udGV4dCk7XG5cbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoc3VjY2Vzcykge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLCBvciBjcmVhdGUgb25lIGlmIG5vdCBmb3VuZC5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovICAgIFxuICAgIHN0YXRpYyBhc3luYyByZXBsYWNlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgcmF3T3B0aW9ucyA9IHVwZGF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciByZXBsYWNpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAuLi51cGRhdGVPcHRpb25zLCAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgcmF3T3B0aW9ucyxcbiAgICAgICAgICAgIG9wdGlvbnM6IHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgbGV0IHJhd09wdGlvbnMgPSBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXdPcHRpb25zLFxuICAgICAgICAgICAgb3B0aW9uczogZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IHRvRGVsZXRlO1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdG9EZWxldGUgPSBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCF0b0RlbGV0ZSkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQucmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgc3VjY2VzcyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKCEoYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9ICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIHRvRGVsZXRlID0gYXdhaXQgdGhpcy5faW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0b0RlbGV0ZSA9IGF3YWl0IHRoaXMuX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghdG9EZWxldGUpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgXG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5faW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQucXVlcnlLZXkpIHtcbiAgICAgICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9ERUxFVEUsIHRoaXMsIGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKHN1Y2Nlc3MpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb250ZXh0LnJldHVybjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gY29udGV4dC5vcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICBsZXQgdmFsdWUgPSByYXdbZmllbGROYW1lXTtcblxuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieXBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8qKiAgdG9kbzogZml4IGRlcGVuZGVuY3lcbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8ud3JpdGVPbmNlKSB7ICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wid3JpdGVPbmNlXCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzTmlsKGV4aXN0aW5nW2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgV3JpdGUtb25jZSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHVwZGF0ZSBvbmNlIGl0IHdhcyBzZXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAqL1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkgJiYgdmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSB2YWx1ZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUodmFsdWUsIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgSW52YWxpZCBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eS5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVycm9yOiBlcnJvci5tZXNzYWdlIHx8IGVycm9yLnN0YWNrIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnR0aXkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGxhdGVzdCA9IGNvbnRleHQubGF0ZXN0ID0gdGhpcy5fdHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmUgcnVsZXMgdG8gZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi4gRGV0YWlsOiBgICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICB7IGVycm9yOiBlcnJvciB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSAmJiB2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgLy90aGVyZSBpcyBzcGVjaWFsIGlucHV0IGNvbHVtbiB3aGljaCBtYXliZSBhIGZ1bmN0aW9uIG9yIGFuIGV4cHJlc3Npb25cbiAgICAgICAgICAgICAgICBvcE9wdGlvbnMuJHJlcXVpcmVTcGxpdENvbHVtbnMgPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGZpZWxkSW5mbyk7XG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIGNvbW1pdCBvciByb2xsYmFjayBpcyBjYWxsZWQgaWYgdHJhbnNhY3Rpb24gaXMgY3JlYXRlZCB3aXRoaW4gdGhlIGV4ZWN1dG9yLlxuICAgICAqIEBwYXJhbSB7Kn0gZXhlY3V0b3IgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7IFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTtcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBkZWxldGUgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uOyAgIFxuICAgICAgICAgICAgfSAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy5fdHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLl90cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMsIG51bGwsIHRydWUpO1xuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZyA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMuX3RyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIW5vcm1hbGl6ZWRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMobm9ybWFsaXplZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBjcmVhdGUgcHJvY2Vzc2luZywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUHJlIHVwZGF0ZSBwcm9jZXNzaW5nLCByZXR1cm4gZmFsc2UgdG8gc3RvcCB1cGNvbWluZyBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgdXBkYXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQcmUgZGVsZXRlIHByb2Nlc3NpbmcsIHJldHVybiBmYWxzZSB0byBzdG9wIHVwY29taW5nIG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFByZSBkZWxldGUgcHJvY2Vzc2luZywgbXVsdGlwbGUgcmVjb3JkcywgcmV0dXJuIGZhbHNlIHRvIHN0b3AgdXBjb21pbmcgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLCBtdWx0aXBsZSByZWNvcmRzIFxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCAgICAgIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcsIG11bHRpcGxlIHJlY29yZHMgXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZmluZEFsbCBwcm9jZXNzaW5nXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7Kn0gcmVjb3JkcyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5ID09PSAnc3RyaW5nJykgeyBcbiAgICAgICAgICAgICAgICBrZXlGaWVsZCA9IGNvbnRleHQub3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZWNvcmRzLnJlZHVjZSgodGFibGUsIHYpID0+IHtcbiAgICAgICAgICAgICAgICB0YWJsZVt2W2tleUZpZWxkXV0gPSB2O1xuICAgICAgICAgICAgICAgIHJldHVybiB0YWJsZTtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplLCBhcnJheVRvSW5PcGVyYXRvcikge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAob29yVHlwZXNUb0J5cGFzcy5oYXModmFsdWUub29yVHlwZSkpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2LCBrKSA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yICYmIGtbMF0gIT09ICckJykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7ICBcbiAgICAgICAgICAgIGxldCByZXQgPSB2YWx1ZS5tYXAodiA9PiB0aGlzLl90cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUsIGFycmF5VG9Jbk9wZXJhdG9yKSk7XG4gICAgICAgICAgICByZXR1cm4gYXJyYXlUb0luT3BlcmF0b3IgPyB7ICRpbjogcmV0IH0gOiByZXQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=