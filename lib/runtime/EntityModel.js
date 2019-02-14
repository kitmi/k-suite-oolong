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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIlV0aWwiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsIiRwa1ZhbHVlcyIsInBpY2siLCJjYXN0QXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwb3B1bGF0ZSIsImRhdGEiLCJNb2RlbENsYXNzIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsImZpbmQiLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzUGxhaW5PYmplY3QiLCJ1a0ZpZWxkcyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJjb25uT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImNvbnRleHQiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCIkYXNzb2NpYXRpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZGIiLCJjb25uZWN0b3IiLCJmaW5kXyIsIm5hbWUiLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsIiR1bmJveGluZyIsImZpbmRBbGxfIiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsIm1hcCIsInJvdyIsInRvdGFsSXRlbXMiLCJpdGVtcyIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwiYXNzb2NpYXRpb25zIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiaXNFbXB0eSIsImNvbm5lY3Rpb24iLCJiZWdpblRyYW5zYWN0aW9uXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJsYXRlc3QiLCJhZnRlckNyZWF0ZV8iLCJfY3JlYXRlQXNzb2NzXyIsInVwZGF0ZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiZGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCJub3RGaW5pc2hlZCIsIlJVTEVfQkVGT1JFX0RFTEVURSIsImJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZWFjaEFzeW5jXyIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIndyaXRlT25jZSIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiYXBwbHlNb2RpZmllcnNfIiwidHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsImVycm9yIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJzcGxpdCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwiZm9yU2luZ2xlUmVjb3JkIiwiQXJyYXkiLCJpc0FycmF5Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidmFyaWFibGVzIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwib29sVHlwZSIsIm1hcFZhbHVlcyIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVFLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFBTCxJQUF3QkYsSUFBSSxDQUFDQyxDQUFuQzs7QUFDQSxNQUFNRSxNQUFNLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLG1CQUFGO0FBQXVCQyxFQUFBQSxnQkFBdkI7QUFBeUNDLEVBQUFBLGdCQUF6QztBQUEyREMsRUFBQUE7QUFBM0QsSUFBNkVOLE1BQW5GOztBQUNBLE1BQU1PLFFBQVEsR0FBR1gsT0FBTyxDQUFDLGtCQUFELENBQXhCOztBQUNBLE1BQU1ZLEtBQUssR0FBR1osT0FBTyxDQUFDLGVBQUQsQ0FBckI7O0FBRUEs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QUFDUCxLQUFYLElBQW9CLEVBQUVNLEtBQUssQ0FBQ3ZHLElBQU4sSUFBY3dHLFNBQVMsQ0FBQ1AsS0FBMUIsQ0FBeEIsRUFBMEQ7QUFDdEQsa0JBQU0sSUFBSTNJLGFBQUosQ0FBa0JYLFFBQVEsQ0FBQ29LLFdBQTNCLENBQU47QUFDSDs7QUFFRCxpQkFBT1AsU0FBUyxDQUFDUCxLQUFWLENBQWdCTSxLQUFLLENBQUN2RyxJQUF0QixDQUFQO0FBQ0gsU0FWTSxNQVVBLElBQUl1RyxLQUFLLENBQUNFLE9BQU4sS0FBa0IsYUFBdEIsRUFBcUM7QUFDeEMsaUJBQU8sS0FBS0oscUJBQUwsQ0FBMkJFLEtBQUssQ0FBQ3ZHLElBQWpDLENBQVA7QUFDSDs7QUFFRCxjQUFNLElBQUltRyxLQUFKLENBQVUsNEJBQTRCSSxLQUFLLENBQUNTLE9BQTVDLENBQU47QUFDSDs7QUFFRCxhQUFPbEssQ0FBQyxDQUFDbUssU0FBRixDQUFZVixLQUFaLEVBQW9CYixDQUFELElBQU8sS0FBS3BCLGNBQUwsQ0FBb0JvQixDQUFwQixFQUF1QmMsU0FBdkIsQ0FBMUIsQ0FBUDtBQUNIOztBQUVELFFBQUlWLEtBQUssQ0FBQ0MsT0FBTixDQUFjUSxLQUFkLENBQUosRUFBMEI7QUFDdEIsYUFBT0EsS0FBSyxDQUFDN0YsR0FBTixDQUFVZ0YsQ0FBQyxJQUFJLEtBQUtwQixjQUFMLENBQW9Cb0IsQ0FBcEIsRUFBdUJjLFNBQXZCLENBQWYsQ0FBUDtBQUNIOztBQUVELFdBQU8sS0FBS0YsVUFBTCxDQUFnQkMsS0FBaEIsQ0FBUDtBQUNIOztBQW5wQmE7O0FBc3BCbEJXLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnhKLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCB9ID0gVXRpbC5fO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIEdldCBhbiBvYmplY3Qgb2YgdGhlIHByaW1hcnkga2V5IHZhbHVlcy5cbiAgICAgKi9cbiAgICBnZXQgJHBrVmFsdWVzKCkge1xuICAgICAgICByZXR1cm4gXy5waWNrKHRoaXMsIF8uY2FzdEFycmF5KHRoaXMuY29uc3RydWN0b3IubWV0YS5rZXlGaWVsZCkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuZmluZE9wdGlvbnMuJHVuYm94aW5nKSByZXR1cm4gcmVzdWx0O1xuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5wb3B1bGF0ZShyZXN1bHQpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBGaW5kIHJlY29yZHMgbWF0Y2hpbmcgdGhlIGNvbmRpdGlvbiwgcmV0dXJucyBhbiBhcnJheSBvZiBtb2RlbCBvYmplY3Qgb3IgYW4gYXJyYXkgb2YgcmVjb3JkcyBkaXJlY3RseSBpZiAkdW5ib3hpbmcgPSB0cnVlLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kdG90YWxDb3VudF0gLSBSZXR1cm4gdG90YWxDb3VudCAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikge1xuICAgICAgICAgICAgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRvdGFsQ291bnQ7XG5cbiAgICAgICAgbGV0IHJvd3MgPSBhd2FpdCB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcmVjb3JkcyA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmZpbmRfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmZpbmRPcHRpb25zLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5maW5kT3B0aW9ucy4kdW5ib3hpbmcpIHJldHVybiByZWNvcmRzO1xuXG4gICAgICAgICAgICByZXR1cm4gcmVjb3Jkcy5tYXAocm93ID0+IHRoaXMucG9wdWxhdGUocm93KSk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuXG4gICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgcmV0dXJuIHsgdG90YWxJdGVtczogdG90YWxDb3VudCwgaXRlbXM6IHJvd3MgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByb3dzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gRW50aXR5IGRhdGEgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kdW5ib3hpbmc9ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oZGF0YSwgY3JlYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgY3JlYXRlT3B0aW9ucyB8fCAoY3JlYXRlT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICBsZXQgWyByYXcsIGFzc29jaWF0aW9ucyBdID0gdGhpcy5fZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXcsIFxuICAgICAgICAgICAgY3JlYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07ICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IG5lZWRDcmVhdGVBc3NvY3MgPSBmYWxzZTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShhc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICBuZWVkQ3JlYXRlQXNzb2NzID0gdHJ1ZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9DUkVBVEUsIHRoaXMsIGNvbnRleHQpOyAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5jcmVhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlckNyZWF0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGlmIChuZWVkQ3JlYXRlQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5fY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gY3JlYXRlT3B0aW9ucy4kdW5ib3hpbmcgPyBjb250ZXh0LmxhdGVzdCA6IHRoaXMucG9wdWxhdGUoY29udGV4dC5sYXRlc3QpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2VcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIGFzeW5jIF91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICghdXBkYXRlT3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbkZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoY29uZGl0aW9uRmllbGRzKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdQcmltYXJ5IGtleSB2YWx1ZShzKSBvciBhdCBsZWFzdCBvbmUgZ3JvdXAgb2YgdW5pcXVlIGtleSB2YWx1ZShzKSBpcyByZXF1aXJlZCBmb3IgdXBkYXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHsgJHF1ZXJ5OiBfLnBpY2soZGF0YSwgY29uZGl0aW9uRmllbGRzKSB9O1xuICAgICAgICAgICAgZGF0YSA9IF8ub21pdChkYXRhLCBjb25kaXRpb25GaWVsZHMpO1xuICAgICAgICB9XG5cbiAgICAgICAgdXBkYXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKHVwZGF0ZU9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHVwZGF0ZU9wdGlvbnMuJHVuYm94aW5nID8gY29udGV4dC5sYXRlc3QgOiB0aGlzLnBvcHVsYXRlKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2RlbGV0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2RlbGV0ZU9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZD1mYWxzZV0gLSBSZXRyaWV2ZSB0aGUgdXBkYXRlZCBlbnRpdHkgZnJvbSBkYXRhYmFzZVxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcGh5c2ljYWxEZWxldGlvbj1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXSBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBwcmU6IGRlbGV0ZU9wdGlvbnM7XG5cbiAgICAgICAgZGVsZXRlT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGRlbGV0ZU9wdGlvbnMsIHRydWUgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgbm90RmluaXNoZWQgPSBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG4gICAgICAgIGlmICghbm90RmluaXNoZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGRlbGV0ZU9wdGlvbnMuJHVuYm94aW5nID8gY29udGV4dC5leGlzdGluZyA6IHRoaXMucG9wdWxhdGUoY29udGV4dC5leGlzdGluZyk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBjb250YWluc1VuaXF1ZUtleSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7XG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbjogJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGNvbmRpdGlvbiB0byBiZSBjb250YWluaW5nIHVuaXF1ZSBrZXkuJyxcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGlzVXBkYXRpbmcgPyBjb250ZXh0LnVwZGF0ZU9wdGlvbnMgOiBjb250ZXh0LmNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgdGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykpIHtcbiAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnksICR1bmJveGluZzogdHJ1ZSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBleGlzdGluZzsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgYXdhaXQgVXRpbC5lYWNoQXN5bmNfKGZpZWxkcywgYXN5bmMgKGZpZWxkSW5mbywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIHJhdykge1xuICAgICAgICAgICAgICAgIC8vZmllbGQgdmFsdWUgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnJlYWRPbmx5KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNVcGRhdGluZyB8fCAhb3BPcHRpb25zLiRieVBhc3NSZWFkT25seS5oYXMoZmllbGROYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9yZWFkIG9ubHksIG5vdCBhbGxvdyB0byBzZXQgYnkgaW5wdXQgdmFsdWVcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBSZWFkLW9ubHkgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBzZXQgYnkgbWFudWFsIGlucHV0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLmZyZWV6ZUFmdGVyTm9uRGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJmcmVlemVBZnRlck5vbkRlZmF1bHRcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1tmaWVsZE5hbWVdICE9PSBmaWVsZEluZm8uZGVmYXVsdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9mcmVlemVBZnRlck5vbkRlZmF1bHQsIG5vdCBhbGxvdyB0byBjaGFuZ2UgaWYgdmFsdWUgaXMgbm9uLWRlZmF1bHRcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBGcmVlemVBZnRlck5vbkRlZmF1bHQgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSBjaGFuZ2VkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vc2FuaXRpemUgZmlyc3RcbiAgICAgICAgICAgICAgICBpZiAoaXNOb3RoaW5nKHJhd1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFRoZSBcIiR7ZmllbGROYW1lfVwiIHZhbHVlIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBjYW5ub3QgYmUgbnVsbC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZShyYXdbZmllbGROYW1lXSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudHRpeSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcykge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5xdWVyeVt2YWx1ZS5uYW1lXTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3RyYW5zbGF0ZVN5bWJvbFRva2VuKHZhbHVlLm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTm90IGltcGxldGVtZW50ZWQgeWV0LiAnICsgdmFsdWUub29sVHlwZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBfLm1hcFZhbHVlcyh2YWx1ZSwgKHYpID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS5tYXAodiA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3NlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IEVudGl0eU1vZGVsOyJdfQ==