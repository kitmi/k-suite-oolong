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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJEc09wZXJhdGlvbkVycm9yIiwiQnVzaW5lc3NFcnJvciIsIkZlYXR1cmVzIiwiUnVsZXMiLCJpc05vdGhpbmciLCJORUVEX09WRVJSSURFIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCIkcGtWYWx1ZXMiLCJwaWNrIiwiY2FzdEFycmF5IiwibWV0YSIsImtleUZpZWxkIiwicG9wdWxhdGUiLCJkYXRhIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJjYWNoZWRfIiwiX2NhY2hlZERhdGEiLCJmaW5kQWxsXyIsIiR0b0RpY3Rpb25hcnkiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJjb250ZXh0IiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwiJGFzc29jaWF0aW9uIiwiJHJlbGF0aW9uc2hpcHMiLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZGIiLCJjb25uZWN0b3IiLCJmaW5kXyIsIm5hbWUiLCIkc2tpcE9ybSIsImxlbmd0aCIsInVuZGVmaW5lZCIsIl9tYXBSZWNvcmRzVG9PYmplY3RzIiwicmVzdWx0IiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJyZXQiLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCIkb2Zmc2V0Iiwib2Zmc2V0IiwiJGxpbWl0IiwibGltaXQiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsImFzc29jaWF0aW9ucyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImlzRW1wdHkiLCJjb25uZWN0aW9uIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwibGF0ZXN0IiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVPbmVfIiwidXBkYXRlT3B0aW9ucyIsIiRieVBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwidXBkYXRlXyIsImFmdGVyVXBkYXRlXyIsImFmdGVyVXBkYXRlTWFueV8iLCJkZWxldGVPbmVfIiwiZGVsZXRlT3B0aW9ucyIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwibm90RmluaXNoZWQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJiZWZvcmVEZWxldGVfIiwiZGVsZXRlXyIsImFmdGVyRGVsZXRlXyIsImFmdGVyRGVsZXRlTWFueV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsImhhc0tleU5hbWVPbmx5IiwiaGFzTm90TnVsbEtleSIsImhhc0tleXMiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlIiwiY29udGFpbnNVbmlxdWVLZXlPbmx5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZmllbGRJbmZvIiwiZmllbGROYW1lIiwicmVhZE9ubHkiLCJoYXMiLCJmcmVlemVBZnRlck5vbkRlZmF1bHQiLCJkZWZhdWx0Iiwib3B0aW9uYWwiLCJzYW5pdGl6ZSIsImVycm9yIiwibWVzc2FnZSIsInN0YWNrIiwiZm9yY2VVcGRhdGUiLCJ1cGRhdGVCeURiIiwiYXV0byIsImNyZWF0ZUJ5RGIiLCJoYXNPd25Qcm9wZXJ0eSIsInRyYW5zbGF0ZVZhbHVlIiwiJHZhcmlhYmxlcyIsIlJVTEVfQUZURVJfVkFMSURBVElPTiIsInN0YXR1cyIsImFwcGx5TW9kaWZpZXJzXyIsIm1hcFZhbHVlcyIsInZhbHVlIiwia2V5IiwiX3NlcmlhbGl6ZUJ5VHlwZSIsImV4ZWN1dG9yIiwiYmluZCIsImNvbW1pdF8iLCJyb2xsYmFja18iLCJpbnB1dCIsImRlcHMiLCJmaWVsZERlcGVuZGVuY2llcyIsImhhc0RlcGVuZHMiLCJkZXAiLCJkIiwic3RhZ2UiLCJmaWVsZCIsInNwbGl0IiwiYXRMZWFzdE9uZU5vdE51bGwiLCJmZWF0dXJlcyIsIl9oYXNSZXNlcnZlZEtleXMiLCJvYmoiLCJ2IiwiayIsIm9wdGlvbnMiLCJBcnJheSIsImlzQXJyYXkiLCJub3JtYWxpemVkT3B0aW9ucyIsInF1ZXJ5IiwiZm9yT3duIiwiJGJ5UGFzc0Vuc3VyZVVuaXF1ZSIsIiRncm91cEJ5IiwiaGF2aW5nIiwiJHByb2plY3Rpb24iLCJFcnJvciIsImFzc29jcyIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIl9zZXJpYWxpemUiLCJ2YXJpYWJsZXMiLCJza2lwU2VyaWFsaXplIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwibWFwIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxRQUFRLEdBQUdDLE9BQU8sQ0FBQyxtQkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFB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LENBQVA7QUFDSDs7QUFFRCxRQUFJQyxhQUFKLEVBQW1CLE9BQU9yQyxLQUFQO0FBRW5CLFdBQU8sS0FBS21DLFVBQUwsQ0FBZ0JuQyxLQUFoQixDQUFQO0FBQ0g7O0FBeDFCYTs7QUEyMUJsQjhDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnJMLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgRGF0YVZhbGlkYXRpb25FcnJvciwgT29sb25nVXNhZ2VFcnJvciwgRHNPcGVyYXRpb25FcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4uL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4uL3V0aWxzL2xhbmcnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBHZXQgYW4gb2JqZWN0IG9mIHRoZSBwcmltYXJ5IGtleSB2YWx1ZXMuXG4gICAgICovXG4gICAgZ2V0ICRwa1ZhbHVlcygpIHtcbiAgICAgICAgcmV0dXJuIF8ucGljayh0aGlzLCBfLmNhc3RBcnJheSh0aGlzLmNvbnN0cnVjdG9yLm1ldGEua2V5RmllbGQpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3B1bGF0ZSBkYXRhIGZyb20gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEByZXR1cm4ge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBwb3B1bGF0ZShkYXRhKSB7XG4gICAgICAgIGxldCBNb2RlbENsYXNzID0gdGhpcztcbiAgICAgICAgcmV0dXJuIG5ldyBNb2RlbENsYXNzKGRhdGEpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IF8uaXNQbGFpbk9iamVjdChkYXRhKTsgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBhIHBrLWluZGV4ZWQgaGFzaHRhYmxlIHdpdGggYWxsIHVuZGVsZXRlZCBkYXRhXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNhY2hlZF8oKSB7XG4gICAgICAgIGlmICghdGhpcy5fY2FjaGVkRGF0YSkge1xuICAgICAgICAgICAgdGhpcy5fY2FjaGVkRGF0YSA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAkdG9EaWN0aW9uYXJ5OiB0cnVlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX2NhY2hlZERhdGE7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gJiYgIWZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5maW5kT3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgJiYgIWZpbmRPcHRpb25zLiRza2lwT3JtKSB7ICBcbiAgICAgICAgICAgICAgICAvL3Jvd3MsIGNvbG91bW5zLCBhbGlhc01hcCAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZHNbMF0ubGVuZ3RoID09PSAwKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFmaW5kT3B0aW9ucy4kc2tpcE9ybSkgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRyZWxhdGlvbnNoaXBzKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKTsgICAgICAgICAgICBcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kb2Zmc2V0KSkge1xuICAgICAgICAgICAgICAgIHJldC5vZmZzZXQgPSBmaW5kT3B0aW9ucy4kb2Zmc2V0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoIWlzTm90aGluZyhmaW5kT3B0aW9ucy4kbGltaXQpKSB7XG4gICAgICAgICAgICAgICAgcmV0LmxpbWl0ID0gZmluZE9wdGlvbnMuJGxpbWl0O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gcmV0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICAvKlxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVNYW55XyhyZWNvcmRzLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIHJlY29yZHMuZm9yRWFjaChkYXRhID0+IHtcbiAgICAgICAgICAgIFxuXG5cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9Ki9cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIHRydWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IHVwZGF0ZU9wdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlTWFueV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmYWxzZSk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMuJGFzc29jaWF0aW9uICYmICF1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyh1cGRhdGVPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlTWFueV8oY29udGV4dCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlT25lXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoISgnJHJldHJpZXZlRGVsZXRlZCcgaW4gZGVsZXRlT3B0aW9ucykpIHtcbiAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgdHJ1ZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgZGVsZXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZSAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlTWFueV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2RlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZhbHNlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBkZWxldGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgIHByZTogZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IG5vdEZpbmlzaGVkID0gYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuICAgICAgICBpZiAoIW5vdEZpbmlzaGVkKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyRGVsZXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpO1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmV4aXN0aW5nO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgbGV0IGhhc0tleU5hbWVPbmx5ID0gZmFsc2U7XG5cbiAgICAgICAgbGV0IGhhc05vdE51bGxLZXkgPSBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiB7XG4gICAgICAgICAgICBsZXQgaGFzS2V5cyA9IF8uZXZlcnkoZmllbGRzLCBmID0+IGYgaW4gZGF0YSk7XG4gICAgICAgICAgICBoYXNLZXlOYW1lT25seSA9IGhhc0tleU5hbWVPbmx5IHx8IGhhc0tleXM7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBbIGhhc05vdE51bGxLZXksIGhhc0tleU5hbWVPbmx5IF07XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgWyBjb250YWluc1VuaXF1ZUtleUFuZFZhbHVlLCBjb250YWluc1VuaXF1ZUtleU9ubHkgXSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7ICAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5QW5kVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChjb250YWluc1VuaXF1ZUtleU9ubHkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcignT25lIG9mIHRoZSB1bmlxdWUga2V5IGZpZWxkIGFzIHF1ZXJ5IGNvbmRpdGlvbiBpcyBudWxsLicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEludmFsaWQgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJvcjogZXJyb3IubWVzc2FnZSB8fCBlcnJvci5zdGFjayBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBsYXRlc3QgPSBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcywgdHJ1ZSk7XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgaWYgKGVycm9yLnN0YXR1cykge1xuICAgICAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICBgRXJyb3Igb2NjdXJyZWQgZHVyaW5nIGFwcGx5aW5nIGZlYXR1cmVzIHJ1bGVzIHRvIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuIERldGFpbDogYCArIGVycm9yLm1lc3NhZ2UsXG4gICAgICAgICAgICAgICAgeyBlcnJvcjogZXJyb3IgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIC8vZmluYWwgcm91bmQgcHJvY2VzcyBiZWZvcmUgZW50ZXJpbmcgZGF0YWJhc2VcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBfLm1hcFZhbHVlcyhsYXRlc3QsICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICBsZXQgZmllbGRJbmZvID0gZmllbGRzW2tleV07XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkSW5mbztcblxuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZUJ5VHlwZSh2YWx1ZSwgZmllbGRJbmZvKTtcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIGlucHV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBbIHN0YWdlLCBmaWVsZCBdID0gZC5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIChzdGFnZSA9PT0gJ2xhdGVzdCcgfHwgc3RhZ2UgPT09ICdleGlzdG5nJykgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiAhb3B0aW9ucy4kYnlQYXNzRW5zdXJlVW5pcXVlKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG5vcm1hbGl6ZWRPcHRpb25zLiRncm91cEJ5KSkge1xuICAgICAgICAgICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGdyb3VwQnkuaGF2aW5nID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kZ3JvdXBCeS5oYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbikge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24gPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uLCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzLCBza2lwU2VyaWFsaXplKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFF1ZXJ5IHBhcmFtZXRlciBcIiR7dmFsdWUubmFtZX1cIiBpbiBjb25maWd1cmF0aW9uIG5vdCBmb3VuZC5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxldGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYpID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS5tYXAodiA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNraXBTZXJpYWxpemUpIHJldHVybiB2YWx1ZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19