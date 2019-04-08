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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsInZhbHVlT2ZLZXkiLCJkYXRhIiwiQXJyYXkiLCJpc0FycmF5IiwibWV0YSIsImtleUZpZWxkIiwicGljayIsInBvcHVsYXRlIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsImNhY2hlZF8iLCJrZXkiLCJjYWNoZWREYXRhIiwiX2NhY2hlZERhdGFBbHRLZXkiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJfY2FjaGVkRGF0YSIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJjb25uT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImNvbnRleHQiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCIkYXNzb2NpYXRpb24iLCIkcmVsYXRpb25zaGlwcyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiX3NhZmVFeGVjdXRlXyIsInJlY29yZHMiLCJkYiIsImNvbm5lY3RvciIsImZpbmRfIiwibmFtZSIsIiRza2lwT3JtIiwibGVuZ3RoIiwidW5kZWZpbmVkIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyZXN1bHQiLCJ0b3RhbENvdW50Iiwicm93cyIsIiR0b3RhbENvdW50IiwiYWZ0ZXJGaW5kQWxsXyIsInJldCIsInRvdGFsSXRlbXMiLCJpdGVtcyIsIiRvZmZzZXQiLCJvZmZzZXQiLCIkbGltaXQiLCJsaW1pdCIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwiYXNzb2NpYXRpb25zIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiaXNFbXB0eSIsImJlZm9yZUNyZWF0ZV8iLCJjb25uZWN0aW9uIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwibGF0ZXN0IiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieVBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwidXBkYXRlXyIsImFmdGVyVXBkYXRlXyIsImFmdGVyVXBkYXRlTWFueV8iLCJyZXBsYWNlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiZGVsZXRlT25lXyIsImRlbGV0ZU9wdGlvbnMiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwibm90RmluaXNoZWQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJiZWZvcmVEZWxldGVfIiwiYmVmb3JlRGVsZXRlTWFueV8iLCJkZWxldGVfIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsImV4aXN0aW5nIiwiX2NvbnRhaW5zVW5pcXVlS2V5IiwiaGFzS2V5TmFtZU9ubHkiLCJoYXNOb3ROdWxsS2V5IiwiaGFzS2V5cyIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUiLCJjb250YWluc1VuaXF1ZUtleU9ubHkiLCJpc1VwZGF0aW5nIiwiaTE4biIsIm9wT3B0aW9ucyIsIl9kZXBlbmRzT25FeGlzdGluZ0RhdGEiLCJmaWVsZEluZm8iLCJmaWVsZE5hbWUiLCJyZWFkT25seSIsImhhcyIsImZyZWV6ZUFmdGVyTm9uRGVmYXVsdCIsImRlZmF1bHQiLCJvcHRpb25hbCIsInNhbml0aXplIiwiZXJyb3IiLCJtZXNzYWdlIiwic3RhY2siLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwidHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwic3RhdHVzIiwiYXBwbHlNb2RpZmllcnNfIiwibWFwVmFsdWVzIiwidmFsdWUiLCJfc2VyaWFsaXplQnlUeXBlIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsInJvbGxiYWNrXyIsImlucHV0IiwiZGVwcyIsImZpZWxkRGVwZW5kZW5jaWVzIiwiaGFzRGVwZW5kcyIsImRlcCIsImQiLCJzdGFnZSIsImZpZWxkIiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2IiwiayIsIm9wdGlvbnMiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5UGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJB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S0FBSyxDQUFDL0YsSUFBTixJQUFjK0gsU0FBUyxDQUFDVixLQUExQixDQUF4QixFQUEwRDtBQUN0RCxrQkFBTSxJQUFJakwsZ0JBQUosQ0FBc0Isb0JBQW1CMkosS0FBSyxDQUFDL0YsSUFBSywrQkFBcEQsQ0FBTjtBQUNIOztBQUVELGlCQUFPK0gsU0FBUyxDQUFDVixLQUFWLENBQWdCdEIsS0FBSyxDQUFDL0YsSUFBdEIsQ0FBUDtBQUNILFNBVk0sTUFVQSxJQUFJK0YsS0FBSyxDQUFDa0MsT0FBTixLQUFrQixhQUF0QixFQUFxQztBQUN4QyxpQkFBTyxLQUFLSixxQkFBTCxDQUEyQjlCLEtBQUssQ0FBQy9GLElBQWpDLENBQVA7QUFDSDs7QUFFRCxjQUFNLElBQUkySCxLQUFKLENBQVUsNEJBQTRCNUIsS0FBSyxDQUFDa0MsT0FBNUMsQ0FBTjtBQUNIOztBQUVELGFBQU9wTSxDQUFDLENBQUNpSyxTQUFGLENBQVlDLEtBQVosRUFBb0JrQixDQUFELElBQU8sS0FBS3hCLGNBQUwsQ0FBb0J3QixDQUFwQixFQUF1QmMsU0FBdkIsQ0FBMUIsQ0FBUDtBQUNIOztBQUVELFFBQUk3SyxLQUFLLENBQUNDLE9BQU4sQ0FBYzRJLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixhQUFPQSxLQUFLLENBQUN4SCxHQUFOLENBQVUwSSxDQUFDLElBQUksS0FBS3hCLGNBQUwsQ0FBb0J3QixDQUFwQixFQUF1QmMsU0FBdkIsQ0FBZixDQUFQO0FBQ0g7O0FBRUQsUUFBSUMsYUFBSixFQUFtQixPQUFPakMsS0FBUDtBQUVuQixXQUFPLEtBQUsrQixVQUFMLENBQWdCL0IsS0FBaEIsQ0FBUDtBQUNIOztBQWw0QmE7O0FBcTRCbEJ5QyxNQUFNLENBQUNDLE9BQVAsR0FBaUI5TCxXQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBIdHRwQ29kZSA9IHJlcXVpcmUoJ2h0dHAtc3RhdHVzLWNvZGVzJyk7XG5jb25zdCB7IF8sIGVhY2hBc3luY18sIGdldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIHN0YXRpYyB2YWx1ZU9mS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSA/IF8ucGljayhkYXRhLCB0aGlzLm1ldGEua2V5RmllbGQpIDogZGF0YVt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwga2V5UGF0aC5zcGxpdCgnLicpLm1hcChwID0+ICc6JytwKS5qb2luKCcuJykpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oa2V5KSB7XG4gICAgICAgIGlmIChrZXkpIHtcbiAgICAgICAgICAgIGxldCBjYWNoZWREYXRhO1xuXG4gICAgICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGFBbHRLZXkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9jYWNoZWREYXRhQWx0S2V5ID0ge307XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHRoaXMuX2NhY2hlZERhdGFBbHRLZXlba2V5XSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhQWx0S2V5W2tleV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmICghY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgICAgIGNhY2hlZERhdGEgPSB0aGlzLl9jYWNoZWREYXRhQWx0S2V5W2tleV0gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHRvRGljdGlvbmFyeToga2V5IH0pO1xuICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNhY2hlZERhdGE7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIXRoaXMuX2NhY2hlZERhdGEpIHtcbiAgICAgICAgICAgIHRoaXMuX2NhY2hlZERhdGEgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgJHRvRGljdGlvbmFyeTogdHJ1ZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9jYWNoZWREYXRhO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3Jkcy5sZW5ndGggPT09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhc3NlcnQ6IHJlY29yZHMubGVuZ3RoID09PSAxO1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IHJlY29yZHNbMF07XG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIHJlY29yZHMuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtmaW5kT3B0aW9ucy4kaW5jbHVkZURlbGV0ZWQ9ZmFsc2VdIC0gSW5jbHVkZSB0aG9zZSBtYXJrZWQgYXMgbG9naWNhbCBkZWxldGVkLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHthcnJheX1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZEFsbF8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgZmluZE9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhmaW5kT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLmFmdGVyRmluZEFsbF8oY29udGV4dCwgcmVjb3Jkcyk7ICAgICAgICAgICAgXG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJG9mZnNldCkpIHtcbiAgICAgICAgICAgICAgICByZXQub2Zmc2V0ID0gZmluZE9wdGlvbnMuJG9mZnNldDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKCFpc05vdGhpbmcoZmluZE9wdGlvbnMuJGxpbWl0KSkge1xuICAgICAgICAgICAgICAgIHJldC5saW1pdCA9IGZpbmRPcHRpb25zLiRsaW1pdDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJldDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICAvKlxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVNYW55XyhyZWNvcmRzLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIHJlY29yZHMuZm9yRWFjaChkYXRhID0+IHtcbiAgICAgICAgICAgIFxuXG5cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9Ki9cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMuJGFzc29jaWF0aW9uICYmICF1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyh1cGRhdGVPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHJlcGxhY2VPbmVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgcmVwbGFjaW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgLi4udXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9kb1JlcGxhY2VPbmVfKGNvbnRleHQpOyAvLyBkaWZmZXJlbnQgZGJtcyBoYXMgZGlmZmVyZW50IHJlcGxhY2luZyBzdHJhdGVneVxuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVPbmVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIGRlbGV0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgcHJlOiBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgbm90RmluaXNoZWQgPSBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG4gICAgICAgIGlmICghbm90RmluaXNoZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmV4aXN0aW5nO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmUgcnVsZXMgdG8gZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi4gRGV0YWlsOiBgICsgZXJyb3IubWVzc2FnZSxcbiAgICAgICAgICAgICAgICB7IGVycm9yOiBlcnJvciB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgLy9maW5hbCByb3VuZCBwcm9jZXNzIGJlZm9yZSBlbnRlcmluZyBkYXRhYmFzZVxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IF8ubWFwVmFsdWVzKGxhdGVzdCwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgIGxldCBmaWVsZEluZm8gPSBmaWVsZHNba2V5XTtcbiAgICAgICAgICAgIGFzc2VydDogZmllbGRJbmZvO1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplQnlUeXBlKHZhbHVlLCBmaWVsZEluZm8pO1xuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmICFvcHRpb25zLiRieVBhc3NFbnN1cmVVbmlxdWUpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qobm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkpKSB7XG4gICAgICAgICAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZykge1xuICAgICAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5LmhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMsIHNraXBTZXJpYWxpemUpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGV0ZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodikgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc2tpcFNlcmlhbGl6ZSkgcmV0dXJuIHZhbHVlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=