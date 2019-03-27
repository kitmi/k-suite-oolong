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

      if (forSingleRecord) {
        await this.afterUpdate_(context);
      } else {
        await this.afterUpdateMany_(context);
      }

      return context.latest;
    }, context);
  }

  static async deleteOne_(deleteOptions, connOptions) {
    if (!('$retrieveDeleted' in deleteOptions)) {
      deleteOptions.$retrieveDeleted = true;
    }

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

      throw new DsOperationError(`Error occurred during applying features rules to entity "${this.meta.name}". Detail: ` + error.message, {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsIiRwa1ZhbHVlcyIsInBpY2siLCJjYXN0QXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwb3B1bGF0ZSIsImRhdGEiLCJNb2RlbENsYXNzIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsImZpbmQiLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzUGxhaW5PYmplY3QiLCJ1a0ZpZWxkcyIsImdldE5lc3RlZE9iamVjdCIsImVudGl0eU9iaiIsImtleVBhdGgiLCJzcGxpdCIsIm1hcCIsInAiLCJqb2luIiwiY2FjaGVkXyIsIl9jYWNoZWREYXRhIiwiZmluZEFsbF8iLCIkdG9EaWN0aW9uYXJ5IiwiZmluZE9uZV8iLCJmaW5kT3B0aW9ucyIsImNvbm5PcHRpb25zIiwiX3ByZXBhcmVRdWVyaWVzIiwiY29udGV4dCIsImFwcGx5UnVsZXNfIiwiUlVMRV9CRUZPUkVfRklORCIsIiRhc3NvY2lhdGlvbiIsIiRyZWxhdGlvbnNoaXBzIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImRiIiwiY29ubmVjdG9yIiwiZmluZF8iLCJuYW1lIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsInRvdGFsQ291bnQiLCJyb3dzIiwiJHRvdGFsQ291bnQiLCJhZnRlckZpbmRBbGxfIiwicmV0IiwidG90YWxJdGVtcyIsIml0ZW1zIiwiJG9mZnNldCIsIm9mZnNldCIsIiRsaW1pdCIsImxpbWl0IiwiY3JlYXRlXyIsImNyZWF0ZU9wdGlvbnMiLCJyYXciLCJhc3NvY2lhdGlvbnMiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsIm5lZWRDcmVhdGVBc3NvY3MiLCJpc0VtcHR5IiwiY29ubmVjdGlvbiIsImJlZ2luVHJhbnNhY3Rpb25fIiwiX3ByZXBhcmVFbnRpdHlEYXRhXyIsIlJVTEVfQkVGT1JFX0NSRUFURSIsImxhdGVzdCIsImFmdGVyQ3JlYXRlXyIsIl9jcmVhdGVBc3NvY3NfIiwidXBkYXRlT25lXyIsInVwZGF0ZU9wdGlvbnMiLCIkYnlQYXNzUmVhZE9ubHkiLCJlbnRpdHkiLCJyZWFzb24iLCJfdXBkYXRlXyIsInVwZGF0ZU1hbnlfIiwiZm9yU2luZ2xlUmVjb3JkIiwiY29uZGl0aW9uRmllbGRzIiwiJHF1ZXJ5Iiwib21pdCIsIlJVTEVfQkVGT1JFX1VQREFURSIsInVwZGF0ZV8iLCJhZnRlclVwZGF0ZV8iLCJhZnRlclVwZGF0ZU1hbnlfIiwiZGVsZXRlT25lXyIsImRlbGV0ZU9wdGlvbnMiLCIkcmV0cmlldmVEZWxldGVkIiwiX2RlbGV0ZV8iLCJkZWxldGVNYW55XyIsIm5vdEZpbmlzaGVkIiwiUlVMRV9CRUZPUkVfREVMRVRFIiwiYmVmb3JlRGVsZXRlXyIsImRlbGV0ZV8iLCJhZnRlckRlbGV0ZV8iLCJhZnRlckRlbGV0ZU1hbnlfIiwiZXhpc3RpbmciLCJfY29udGFpbnNVbmlxdWVLZXkiLCJoYXNLZXlOYW1lT25seSIsImhhc05vdE51bGxLZXkiLCJoYXNLZXlzIiwiX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5IiwiY29uZGl0aW9uIiwiY29udGFpbnNVbmlxdWVLZXlBbmRWYWx1ZSIsImNvbnRhaW5zVW5pcXVlS2V5T25seSIsImlzVXBkYXRpbmciLCJpMThuIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJlcnJvciIsIm1lc3NhZ2UiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJ0cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCJzdGF0dXMiLCJhcHBseU1vZGlmaWVyc18iLCJtYXBWYWx1ZXMiLCJ2YWx1ZSIsImtleSIsIl9zZXJpYWxpemVCeVR5cGUiLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJhdExlYXN0T25lTm90TnVsbCIsImZlYXR1cmVzIiwiX2hhc1Jlc2VydmVkS2V5cyIsIm9iaiIsInYiLCJrIiwib3B0aW9ucyIsIkFycmF5IiwiaXNBcnJheSIsIm5vcm1hbGl6ZWRPcHRpb25zIiwicXVlcnkiLCJmb3JPd24iLCIkYnlQYXNzRW5zdXJlVW5pcXVlIiwiJGdyb3VwQnkiLCJoYXZpbmciLCIkcHJvamVjdGlvbiIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsInZhcmlhYmxlcyIsInNraXBTZXJpYWxpemUiLCJvb3JUeXBlIiwic2Vzc2lvbiIsImVyckFyZ3MiLCJtaXNzaW5nTWVzc2FnZSIsInB1c2giLCJtaXNzaW5nU3RhdHVzIiwiQkFEX1JFUVVFU1QiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FB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QUFLLENBQUNxQyxPQUE1QyxDQUFOO0FBQ0g7O0FBRUQsYUFBT2hNLENBQUMsQ0FBQzBKLFNBQUYsQ0FBWUMsS0FBWixFQUFvQm1CLENBQUQsSUFBTyxLQUFLekIsY0FBTCxDQUFvQnlCLENBQXBCLEVBQXVCZ0IsU0FBdkIsQ0FBMUIsQ0FBUDtBQUNIOztBQUVELFFBQUliLEtBQUssQ0FBQ0MsT0FBTixDQUFjdkIsS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLGFBQU9BLEtBQUssQ0FBQ2xILEdBQU4sQ0FBVXFJLENBQUMsSUFBSSxLQUFLekIsY0FBTCxDQUFvQnlCLENBQXBCLEVBQXVCZ0IsU0FBdkIsQ0FBZixDQUFQO0FBQ0g7O0FBRUQsUUFBSUMsYUFBSixFQUFtQixPQUFPcEMsS0FBUDtBQUVuQixXQUFPLEtBQUtrQyxVQUFMLENBQWdCbEMsS0FBaEIsQ0FBUDtBQUNIOztBQTUxQmE7O0FBKzFCbEI0QyxNQUFNLENBQUNDLE9BQVAsR0FBaUIxTCxXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18sIGdldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIEdldCBhbiBvYmplY3Qgb2YgdGhlIHByaW1hcnkga2V5IHZhbHVlcy5cbiAgICAgKi9cbiAgICBnZXQgJHBrVmFsdWVzKCkge1xuICAgICAgICByZXR1cm4gXy5waWNrKHRoaXMsIF8uY2FzdEFycmF5KHRoaXMuY29uc3RydWN0b3IubWV0YS5rZXlGaWVsZCkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwga2V5UGF0aC5zcGxpdCgnLicpLm1hcChwID0+ICc6JytwKS5qb2luKCcuJykpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oKSB7XG4gICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX2NhY2hlZERhdGE7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5maW5kT3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICAvKlxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVNYW55XyhyZWNvcmRzLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIHJlY29yZHMuZm9yRWFjaChkYXRhID0+IHtcbiAgICAgICAgICAgIFxuXG5cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9Ki9cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMuJGFzc29jaWF0aW9uICYmICF1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyh1cGRhdGVPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoISgnJHJldHJpZXZlRGVsZXRlZCcgaW4gZGVsZXRlT3B0aW9ucykpIHtcbiAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIHByZTogZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IG5vdEZpbmlzaGVkID0gYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuICAgICAgICBpZiAoIW5vdEZpbmlzaGVkKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmV4aXN0aW5nO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmVzIHJ1bGVzIHRvIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuIERldGFpbDogYCArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgeyBlcnJvcjogZXJyb3IgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZSh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIGlucHV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBbIHN0YWdlLCBmaWVsZCBdID0gZC5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIChzdGFnZSA9PT0gJ2xhdGVzdCcgfHwgc3RhZ2UgPT09ICdleGlzdG5nJykgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlQYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxldGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYpID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS5tYXAodiA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBTZXJpYWxpemUpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19