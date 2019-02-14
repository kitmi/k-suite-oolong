"use strict";

require("source-map-support/register");

const HttpCode = require('http-status-codes');

const Util = require('rk-utils');

const {
  _,
  getValueByPath
} = Util._;

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

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions.$association);
    }

    return this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$association);
      } else if (records.length === 0) {
        return undefined;
      }

      if (!(records.length === 1)) {
        throw new Error("Assertion failed: records.length === 1");
      }

      let result = records[0];
      if (context.findOptions.$unboxing) return result;
      return this.populate(result);
    }, context);
  }

  static async findAll_(findOptions, connOptions) {
    findOptions = this._prepareQueries(findOptions);
    let context = {
      findOptions,
      connOptions
    };
    await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions.$association);
    }

    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association) {
        if (findOptions.$totalCount) {
          totalCount = records[3];
        }

        records = this._mapRecordsToObjects(records, findOptions.$association);
      } else {
        if (findOptions.$totalCount) {
          totalCount = records[1];
          records = records[0];
        }
      }

      if (context.findOptions.$unboxing) return records;
      return records.map(row => this.populate(row));
    }, context);

    if (findOptions.$totalCount) {
      return {
        totalItems: totalCount,
        items: rows
      };
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

      return createOptions.$unboxing ? context.latest : this.populate(context.latest);
    }, context);
  }

  static async update_(data, updateOptions, connOptions) {
    if (updateOptions && updateOptions.$byPassReadOnly) {
      throw new OolongUsageError('Unexpected usage.', {
        entity: this.meta.name,
        reason: '$byPassReadOnly option is not allow to be set from public update_ method.',
        updateOptions
      });
    }

    return this._update_(data, updateOptions, connOptions);
  }

  static async _update_(data, updateOptions, connOptions) {
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

    updateOptions = this._prepareQueries(updateOptions, true);
    let context = {
      raw: data,
      updateOptions,
      connOptions
    };
    return this._safeExecute_(async context => {
      await this._prepareEntityData_(context, true);
      await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.updateOptions.$query, context.connOptions);
      await this.afterUpdate_(context);
      return updateOptions.$unboxing ? context.latest : this.populate(context.latest);
    }, context);
  }

  static async delete_(deleteOptions, connOptions) {
    if (!deleteOptions) {
      throw new Error("Function  precondition failed: deleteOptions");
    }

    deleteOptions = this._prepareQueries(deleteOptions, true);

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
      return deleteOptions.$unboxing ? context.existing : this.populate(context.existing);
    }, context);
  }

  static _containsUniqueKey(data) {
    return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
  }

  static _ensureContainsUniqueKey(condition) {
    let containsUniqueKey = this._containsUniqueKey(condition);

    if (!containsUniqueKey) {
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
        $query: opOptions.$query,
        $unboxing: true
      }, context.connOptions);
      context.existing = existing;
    }

    await Util.eachAsync_(fields, async (fieldInfo, fieldName) => {
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

        if (isUpdating && fieldInfo.writeOnce) {
          if (!existing) {
            throw new Error('"writeOnce" qualifier requires existing data.');
          }

          if (!_.isNil(existing[fieldName])) {
            throw new DataValidationError(`Write-once field "${fieldName}" is not allowed to be update once it was set.`, {
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
          latest[fieldName] = Types.sanitize(raw[fieldName], fieldInfo, i18n);
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
    await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);
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

    if (forSingleRecord) {
      this._ensureContainsUniqueKey(normalizedOptions.$query);
    }

    normalizedOptions.$query = this.translateValue(normalizedOptions.$query, normalizedOptions.$variables);
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
            console.log('param', value.name);
            console.log(variables.query);
            throw new BusinessError(HttpCode.BAD_REQUEST);
          }

          return variables.query[value.name];
        } else if (value.oorType === 'SymbolToken') {
          return this._translateSymbolToken(value.name);
        }

        throw new Error('Not impletemented yet. ' + value.oolType);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIlV0aWwiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsIiRwa1ZhbHVlcyIsInBpY2siLCJjYXN0QXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwb3B1bGF0ZSIsImRhdGEiLCJNb2RlbENsYXNzIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsImZpbmQiLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzUGxhaW5PYmplY3QiLCJ1a0ZpZWxkcyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJjb25uT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImNvbnRleHQiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCIkYXNzb2NpYXRpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZGIiLCJjb25uZWN0b3IiLCJmaW5kXyIsIm5hbWUiLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsIiR1bmJveGluZyIsImZpbmRBbGxfIiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsIm1hcCIsInJvdyIsInRvdGFsSXRlbXMiLCJpdGVtcyIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwiYXNzb2NpYXRpb25zIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiaXNFbXB0eSIsImNvbm5lY3Rpb24iLCJiZWdpblRyYW5zYWN0aW9uXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJsYXRlc3QiLCJhZnRlckNyZWF0ZV8iLCJfY3JlYXRlQXNzb2NzXyIsInVwZGF0ZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiZGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCJub3RGaW5pc2hlZCIsIlJVTEVfQkVGT1JFX0RFTEVURSIsImJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZWFjaEFzeW5jXyIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIndyaXRlT25jZSIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiYXBwbHlNb2RpZmllcnNfIiwidHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsImVycm9yIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJzcGxpdCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwiZm9yU2luZ2xlUmVjb3JkIiwiQXJyYXkiLCJpc0FycmF5Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidmFyaWFibGVzIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwiY29uc29sZSIsImxvZyIsIm9vbFR5cGUiLCJtYXBWYWx1ZXMiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFFBQVEsR0FBR0MsT0FBTyxDQUFDLG1CQUFELENBQXhCOztBQUNBLE1BQU1DLElBQUksR0FBR0QsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFRSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBd0JGLElBQUksQ0FBQ0MsQ0FBbkM7O0FBQ0EsTUFBTUUsTUFBTSxHQUFHSixPQUFPLENBQUMsVUFBRCxDQUF0Qjs7QUFDQSxNQUFNSyxVQUFVLEdBQUdMLE9BQU8sQ0FBQyxjQUFELENBQTFCOztBQUNBLE1BQU1NLEtBQUssR0FBR04sT0FBTyxDQUFDLFNBQUQsQ0FBckI7O0FBQ0EsTUFBTTtBQUFFTyxFQUFBQSxtQkFBRjtBQUF1QkMsRUFBQUEsZ0JBQXZCO0FBQXlDQyxFQUFBQSxnQkFBekM7QUFBMkRDLEVBQUFBO0FBQTNELElBQTZFTixNQUFuRjs7QUFDQSxNQUFNTyxRQUFRLEdBQUdYLE9BQU8sQ0FBQyxrQkFBRCxDQUF4Qjs7QUFDQSxNQUFNWSxLQUFLLEdBQUdaLE9BQU8sQ0FBQyxl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c3QgSHR0cENvZGUgPSByZXF1aXJlKCdodHRwLXN0YXR1cy1jb2RlcycpO1xuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoIH0gPSBVdGlsLl87XG5jb25zdCBFcnJvcnMgPSByZXF1aXJlKCcuL0Vycm9ycycpO1xuY29uc3QgR2VuZXJhdG9ycyA9IHJlcXVpcmUoJy4vR2VuZXJhdG9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuL3R5cGVzJyk7XG5jb25zdCB7IERhdGFWYWxpZGF0aW9uRXJyb3IsIE9vbG9uZ1VzYWdlRXJyb3IsIERzT3BlcmF0aW9uRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IEVycm9ycztcbmNvbnN0IEZlYXR1cmVzID0gcmVxdWlyZSgnLi9lbnRpdHlGZWF0dXJlcycpO1xuY29uc3QgUnVsZXMgPSByZXF1aXJlKCcuLi9lbnVtL1J1bGVzJyk7XG5cbmNvbnN0IHsgaXNOb3RoaW5nIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbmNvbnN0IE5FRURfT1ZFUlJJREUgPSAnU2hvdWxkIGJlIG92ZXJyaWRlZCBieSBkcml2ZXItc3BlY2lmaWMgc3ViY2xhc3MuJztcblxuLyoqXG4gKiBCYXNlIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBFbnRpdHlNb2RlbCB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW3Jhd0RhdGFdIC0gUmF3IGRhdGEgb2JqZWN0IFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKHJhd0RhdGEpIHtcbiAgICAgICAgaWYgKHJhd0RhdGEpIHtcbiAgICAgICAgICAgIC8vb25seSBwaWNrIHRob3NlIHRoYXQgYXJlIGZpZWxkcyBvZiB0aGlzIGVudGl0eVxuICAgICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLCByYXdEYXRhKTtcbiAgICAgICAgfSBcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogR2V0IGFuIG9iamVjdCBvZiB0aGUgcHJpbWFyeSBrZXkgdmFsdWVzLlxuICAgICAqL1xuICAgIGdldCAkcGtWYWx1ZXMoKSB7XG4gICAgICAgIHJldHVybiBfLnBpY2sodGhpcywgXy5jYXN0QXJyYXkodGhpcy5jb25zdHJ1Y3Rvci5tZXRhLmtleUZpZWxkKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9wdWxhdGUgZGF0YSBmcm9tIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7Kn0gZGF0YSBcbiAgICAgKiBAcmV0dXJuIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgcG9wdWxhdGUoZGF0YSkge1xuICAgICAgICBsZXQgTW9kZWxDbGFzcyA9IHRoaXM7XG4gICAgICAgIHJldHVybiBuZXcgTW9kZWxDbGFzcyhkYXRhKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgZmllbGQgbmFtZXMgYXJyYXkgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQga2V5LXZhbHVlIHBhaXJzIG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShkYXRhKSB7ICBcbiAgICAgICAgcHJlOiBfLmlzUGxhaW5PYmplY3QoZGF0YSk7ICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHVrRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICByZXR1cm4gXy5waWNrKGRhdGEsIHVrRmllbGRzKTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogRmluZCBvbmUgcmVjb3JkLCByZXR1cm5zIGEgbW9kZWwgb2JqZWN0IGNvbnRhaW5pbmcgdGhlIHJlY29yZCBvciB1bmRlZmluZWQgaWYgbm90aGluZyBmb3VuZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdHxhcnJheX0gY29uZGl0aW9uIC0gUXVlcnkgY29uZGl0aW9uLCBrZXktdmFsdWUgcGFpciB3aWxsIGJlIGpvaW5lZCB3aXRoICdBTkQnLCBhcnJheSBlbGVtZW50IHdpbGwgYmUgam9pbmVkIHdpdGggJ09SJy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7Kn1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZmluZE9uZV8oZmluZE9wdGlvbnMsIGNvbm5PcHRpb25zKSB7IFxuICAgICAgICBwcmU6IGZpbmRPcHRpb25zO1xuXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuICAgICAgICBcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgZmluZE9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyBcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9GSU5ELCB0aGlzLCBjb250ZXh0KTsgIFxuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHtcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiA9IHRoaXMuX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzZXJ0OiByZWNvcmRzLmxlbmd0aCA9PT0gMTtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5maW5kT3B0aW9ucy4kdW5ib3hpbmcpIHJldHVybiByZXN1bHQ7XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnBvcHVsYXRlKHJlc3VsdCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIG1vZGVsIG9iamVjdCBvciBhbiBhcnJheSBvZiByZWNvcmRzIGRpcmVjdGx5IGlmICR1bmJveGluZyA9IHRydWUuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzNdO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbMV07XG4gICAgICAgICAgICAgICAgICAgIHJlY29yZHMgPSByZWNvcmRzWzBdO1xuICAgICAgICAgICAgICAgIH0gICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb250ZXh0LmZpbmRPcHRpb25zLiR1bmJveGluZykgcmV0dXJuIHJlY29yZHM7XG5cbiAgICAgICAgICAgIHJldHVybiByZWNvcmRzLm1hcChyb3cgPT4gdGhpcy5wb3B1bGF0ZShyb3cpKTtcbiAgICAgICAgfSwgY29udGV4dCk7XG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICByZXR1cm4geyB0b3RhbEl0ZW1zOiB0b3RhbENvdW50LCBpdGVtczogcm93cyB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJvd3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2NyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtFbnRpdHlNb2RlbH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyhkYXRhLCBjcmVhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBjcmVhdGVPcHRpb25zIHx8IChjcmVhdGVPcHRpb25zID0ge30pO1xuXG4gICAgICAgIGxldCBbIHJhdywgYXNzb2NpYXRpb25zIF0gPSB0aGlzLl9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdywgXG4gICAgICAgICAgICBjcmVhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgICAgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgbmVlZENyZWF0ZUFzc29jcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgIG5lZWRDcmVhdGVBc3NvY3MgPSB0cnVlO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0KTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0NSRUFURSwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNyZWF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyQ3JlYXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgaWYgKG5lZWRDcmVhdGVBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLl9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBjcmVhdGVPcHRpb25zLiR1bmJveGluZyA/IGNvbnRleHQubGF0ZXN0IDogdGhpcy5wb3B1bGF0ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgd2l0aCBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSAocGFpcikgZ2l2ZW5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW3VwZGF0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZVxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAodXBkYXRlT3B0aW9ucyAmJiB1cGRhdGVPcHRpb25zLiRieVBhc3NSZWFkT25seSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICByZWFzb246ICckYnlQYXNzUmVhZE9ubHkgb3B0aW9uIGlzIG5vdCBhbGxvdyB0byBiZSBzZXQgZnJvbSBwdWJsaWMgdXBkYXRlXyBtZXRob2QuJyxcbiAgICAgICAgICAgICAgICB1cGRhdGVPcHRpb25zXG4gICAgICAgICAgICB9KTsgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCF1cGRhdGVPcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uRmllbGRzID0gdGhpcy5nZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpO1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShjb25kaXRpb25GaWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ByaW1hcnkga2V5IHZhbHVlKHMpIG9yIGF0IGxlYXN0IG9uZSBncm91cCBvZiB1bmlxdWUga2V5IHZhbHVlKHMpIGlzIHJlcXVpcmVkIGZvciB1cGRhdGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zID0geyAkcXVlcnk6IF8ucGljayhkYXRhLCBjb25kaXRpb25GaWVsZHMpIH07XG4gICAgICAgICAgICBkYXRhID0gXy5vbWl0KGRhdGEsIGNvbmRpdGlvbkZpZWxkcyk7XG4gICAgICAgIH1cblxuICAgICAgICB1cGRhdGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXModXBkYXRlT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3OiBkYXRhLCBcbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIHRydWUgLyogaXMgdXBkYXRpbmcgKi8pOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfVVBEQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnVwZGF0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0LCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJVcGRhdGVfKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gdXBkYXRlT3B0aW9ucy4kdW5ib3hpbmcgPyBjb250ZXh0LmxhdGVzdCA6IHRoaXMucG9wdWxhdGUoY29udGV4dC5sYXRlc3QpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kdW5ib3hpbmc9ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHByZTogZGVsZXRlT3B0aW9ucztcblxuICAgICAgICBkZWxldGVPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZGVsZXRlT3B0aW9ucywgdHJ1ZSAvKiBmb3Igc2luZ2xlIHJlY29yZCAqLyk7XG5cbiAgICAgICAgaWYgKF8uaXNFbXB0eShkZWxldGVPcHRpb25zLiRxdWVyeSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdFbXB0eSBjb25kaXRpb24gaXMgbm90IGFsbG93ZWQgZm9yIGRlbGV0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIGRlbGV0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBub3RGaW5pc2hlZCA9IGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0RFTEVURSwgdGhpcywgY29udGV4dCk7ICAgICBcbiAgICAgICAgaWYgKCFub3RGaW5pc2hlZCkge1xuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9ICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYmVmb3JlRGVsZXRlXyhjb250ZXh0KTtcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5kZWxldGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5kZWxldGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gZGVsZXRlT3B0aW9ucy4kdW5ib3hpbmcgPyBjb250ZXh0LmV4aXN0aW5nIDogdGhpcy5wb3B1bGF0ZShjb250ZXh0LmV4aXN0aW5nKTtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2hlY2sgd2hldGhlciBhIGRhdGEgcmVjb3JkIGNvbnRhaW5zIHByaW1hcnkga2V5IG9yIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IHBhaXIuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICovXG4gICAgc3RhdGljIF9jb250YWluc1VuaXF1ZUtleShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEVuc3VyZSB0aGUgY29uZGl0aW9uIGNvbnRhaW5zIG9uZSBvZiB0aGUgdW5pcXVlIGtleXMuXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICovXG4gICAgc3RhdGljIF9lbnN1cmVDb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pIHtcbiAgICAgICAgbGV0IGNvbnRhaW5zVW5pcXVlS2V5ID0gdGhpcy5fY29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKTtcblxuICAgICAgICBpZiAoIWNvbnRhaW5zVW5pcXVlS2V5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgcmVhc29uOiAnU2luZ2xlIHJlY29yZCBvcGVyYXRpb24gcmVxdWlyZXMgY29uZGl0aW9uIHRvIGJlIGNvbnRhaW5pbmcgdW5pcXVlIGtleS4nLFxuICAgICAgICAgICAgICAgICAgICBjb25kaXRpb25cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICApO1xuICAgICAgICB9XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFByZXBhcmUgdmFsaWQgYW5kIHNhbml0aXplZCBlbnRpdHkgZGF0YSBmb3Igc2VuZGluZyB0byBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dCAtIE9wZXJhdGlvbiBjb250ZXh0LlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBjb250ZXh0LnJhdyAtIFJhdyBpbnB1dCBkYXRhLlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jb25uT3B0aW9uc11cbiAgICAgKiBAcGFyYW0ge2Jvb2x9IGlzVXBkYXRpbmcgLSBGbGFnIGZvciB1cGRhdGluZyBleGlzdGluZyBlbnRpdHkuXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgaXNVcGRhdGluZyA9IGZhbHNlKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhO1xuICAgICAgICBsZXQgaTE4biA9IHRoaXMuaTE4bjtcbiAgICAgICAgbGV0IHsgbmFtZSwgZmllbGRzIH0gPSBtZXRhOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHsgcmF3IH0gPSBjb250ZXh0O1xuICAgICAgICBsZXQgbGF0ZXN0ID0ge30sIGV4aXN0aW5nO1xuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGxhdGVzdDsgICAgICAgXG5cbiAgICAgICAgaWYgKCFjb250ZXh0LmkxOG4pIHtcbiAgICAgICAgICAgIGNvbnRleHQuaTE4biA9IGkxOG47XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgb3BPcHRpb25zID0gaXNVcGRhdGluZyA/IGNvbnRleHQudXBkYXRlT3B0aW9ucyA6IGNvbnRleHQuY3JlYXRlT3B0aW9ucztcblxuICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiB0aGlzLl9kZXBlbmRzT25FeGlzdGluZ0RhdGEocmF3KSkge1xuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9IC8vIGVsc2UgYWxyZWFkeSBpbiBhIHRyYW5zYWN0aW9uICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogb3BPcHRpb25zLiRxdWVyeSwgJHVuYm94aW5nOiB0cnVlIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGV4aXN0aW5nOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBhd2FpdCBVdGlsLmVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1VwZGF0aW5nIHx8ICFvcE9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcocmF3W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IFR5cGVzLnNhbml0aXplKHJhd1tmaWVsZE5hbWVdLCBmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vbm90IGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICBpZiAoaXNVcGRhdGluZykge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uZm9yY2VVcGRhdGUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZm9yY2UgdXBkYXRlIHBvbGljeSwgZS5nLiB1cGRhdGVUaW1lc3RhbXBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby51cGRhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3JlcXVpcmUgZ2VuZXJhdG9yIHRvIHJlZnJlc2ggYXV0byBnZW5lcmF0ZWQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKFxuICAgICAgICAgICAgICAgICAgICAgICAgYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50dGl5IGlzIHJlcXVpcmVkIGZvciBlYWNoIHVwZGF0ZS5gLCB7ICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm9cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTsgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgLy9uZXcgcmVjb3JkXG4gICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5jcmVhdGVCeURiKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGRlZmF1bHQgc2V0dGluZyBpbiBtZXRhIGRhdGFcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBmaWVsZEluZm8uZGVmYXVsdDtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5hdXRvKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vYXV0b21hdGljYWxseSBnZW5lcmF0ZWRcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vbWlzc2luZyByZXF1aXJlZFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgaXMgcmVxdWlyZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gLy8gZWxzZSBkZWZhdWx0IHZhbHVlIHNldCBieSBkYXRhYmFzZSBvciBieSBydWxlc1xuICAgICAgICB9KTtcblxuICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0FGVEVSX1ZBTElEQVRJT04sIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICBhd2FpdCB0aGlzLmFwcGx5TW9kaWZpZXJzXyhjb250ZXh0LCBpc1VwZGF0aW5nKTtcblxuICAgICAgICBjb250ZXh0LmxhdGVzdCA9IHRoaXMudHJhbnNsYXRlVmFsdWUobGF0ZXN0LCBvcE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgcmV0dXJuIGNvbnRleHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9zYWZlRXhlY3V0ZV8oZXhlY3V0b3IsIGNvbnRleHQpIHtcbiAgICAgICAgZXhlY3V0b3IgPSBleGVjdXRvci5iaW5kKHRoaXMpO1xuXG4gICAgICAgIGlmIChjb250ZXh0LmNvbm5PcHRpb25zICYmIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgIHJldHVybiBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgfSBcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IGF3YWl0IGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICAvL2lmIHRoZSBleGVjdXRvciBoYXZlIGluaXRpYXRlZCBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jb21taXRfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgLy93ZSBoYXZlIHRvIHJvbGxiYWNrIGlmIGVycm9yIG9jY3VycmVkIGluIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLnJvbGxiYWNrXyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH0gXG4gICAgfVxuXG4gICAgc3RhdGljIF9kZXBlbmRzT25FeGlzdGluZ0RhdGEoaW5wdXQpIHtcbiAgICAgICAgLy9jaGVjayBtb2RpZmllciBkZXBlbmRlbmNpZXNcbiAgICAgICAgbGV0IGRlcHMgPSB0aGlzLm1ldGEuZmllbGREZXBlbmRlbmNpZXM7XG4gICAgICAgIGxldCBoYXNEZXBlbmRzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKGRlcHMpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoZGVwcywgKGRlcCwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiBpbnB1dCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5maW5kKGRlcCwgZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgWyBzdGFnZSwgZmllbGQgXSA9IGQuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAoc3RhZ2UgPT09ICdsYXRlc3QnIHx8IHN0YWdlID09PSAnZXhpc3RuZycpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvL2NoZWNrIGJ5IHNwZWNpYWwgcnVsZXNcbiAgICAgICAgbGV0IGF0TGVhc3RPbmVOb3ROdWxsID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF0TGVhc3RPbmVOb3ROdWxsO1xuICAgICAgICBpZiAoYXRMZWFzdE9uZU5vdE51bGwpIHtcbiAgICAgICAgICAgIGhhc0RlcGVuZHMgPSBfLmZpbmQoYXRMZWFzdE9uZU5vdE51bGwsIGZpZWxkcyA9PiBfLmZpbmQoZmllbGRzLCBmaWVsZCA9PiAoZmllbGQgaW4gaW5wdXQpICYmIF8uaXNOaWwoaW5wdXRbZmllbGRdKSkpO1xuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHJldHVybiBmYWxzZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2hhc1Jlc2VydmVkS2V5cyhvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZChvYmosICh2LCBrKSA9PiBrWzBdID09PSAnJCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZVF1ZXJpZXMob3B0aW9ucywgZm9yU2luZ2xlUmVjb3JkID0gZmFsc2UpIHtcbiAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3Qob3B0aW9ucykpIHtcbiAgICAgICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQgJiYgQXJyYXkuaXNBcnJheSh0aGlzLm1ldGEua2V5RmllbGQpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0Nhbm5vdCB1c2UgYSBzaW5ndWxhciB2YWx1ZSBhcyBjb25kaXRpb24gdG8gcXVlcnkgYWdhaW5zdCBhIGVudGl0eSB3aXRoIGNvbWJpbmVkIHByaW1hcnkga2V5LicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gb3B0aW9ucyA/IHsgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnRyYW5zbGF0ZVZhbHVlKG9wdGlvbnMpIH0gfSA6IHt9O1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG5vcm1hbGl6ZWRPcHRpb25zID0ge30sIHF1ZXJ5ID0ge307XG5cbiAgICAgICAgXy5mb3JPd24ob3B0aW9ucywgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICBub3JtYWxpemVkT3B0aW9uc1trXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHF1ZXJ5W2tdID0gdjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0geyAuLi5xdWVyeSwgLi4ubm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5IH07XG5cbiAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICAgICAgdGhpcy5fZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5ID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnksIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIHJldHVybiBub3JtYWxpemVkT3B0aW9ucztcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX21hcFJlY29yZHNUb09iamVjdHMoKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7ICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyB0cmFuc2xhdGVWYWx1ZSh2YWx1ZSwgdmFyaWFibGVzKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU2Vzc2lvblZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoKCF2YXJpYWJsZXMuc2Vzc2lvbiB8fCAhKHZhbHVlLm5hbWUgaW4gIHZhcmlhYmxlcy5zZXNzaW9uKSkgJiYgIXZhbHVlLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgZXJyQXJncyA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdNZXNzYWdlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdNZXNzYWdlKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nU3RhdHVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyQXJncy5wdXNoKHZhbHVlLm1pc3NpbmdTdGF0dXMgfHwgSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvciguLi5lcnJBcmdzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMuc2Vzc2lvblt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdRdWVyeVZhcmlhYmxlJykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1ZhcmlhYmxlcyBjb250ZXh0IG1pc3NpbmcuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXZhcmlhYmxlcy5xdWVyeSB8fCAhKHZhbHVlLm5hbWUgaW4gdmFyaWFibGVzLnF1ZXJ5KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ3BhcmFtJywgdmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyh2YXJpYWJsZXMucXVlcnkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoSHR0cENvZGUuQkFEX1JFUVVFU1QpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGV0ZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb2xUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodikgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19