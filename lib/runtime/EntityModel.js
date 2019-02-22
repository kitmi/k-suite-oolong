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
      findOptions.$association = this._prepareAssociations(findOptions);
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
      findOptions.$association = this._prepareAssociations(findOptions);
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

    if (normalizedOptions.$having) {
      normalizedOptions.$having = this.translateValue(normalizedOptions.$having, normalizedOptions.$variables);
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
            throw new OolongUsageError(`Query parameter "${value.name}" in configuration not found.`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIlV0aWwiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJFcnJvcnMiLCJHZW5lcmF0b3JzIiwiVHlwZXMiLCJEYXRhVmFsaWRhdGlvbkVycm9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkRzT3BlcmF0aW9uRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiRmVhdHVyZXMiLCJSdWxlcyIsImlzTm90aGluZyIsIk5FRURfT1ZFUlJJREUiLCJFbnRpdHlNb2RlbCIsImNvbnN0cnVjdG9yIiwicmF3RGF0YSIsIk9iamVjdCIsImFzc2lnbiIsIiRwa1ZhbHVlcyIsInBpY2siLCJjYXN0QXJyYXkiLCJtZXRhIiwia2V5RmllbGQiLCJwb3B1bGF0ZSIsImRhdGEiLCJNb2RlbENsYXNzIiwiZ2V0VW5pcXVlS2V5RmllbGRzRnJvbSIsImZpbmQiLCJ1bmlxdWVLZXlzIiwiZmllbGRzIiwiZXZlcnkiLCJmIiwiaXNOaWwiLCJnZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbSIsImlzUGxhaW5PYmplY3QiLCJ1a0ZpZWxkcyIsImZpbmRPbmVfIiwiZmluZE9wdGlvbnMiLCJjb25uT3B0aW9ucyIsIl9wcmVwYXJlUXVlcmllcyIsImNvbnRleHQiLCJhcHBseVJ1bGVzXyIsIlJVTEVfQkVGT1JFX0ZJTkQiLCIkYXNzb2NpYXRpb24iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsIl9zYWZlRXhlY3V0ZV8iLCJyZWNvcmRzIiwiZGIiLCJjb25uZWN0b3IiLCJmaW5kXyIsIm5hbWUiLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsIiR1bmJveGluZyIsImZpbmRBbGxfIiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsIm1hcCIsInJvdyIsInRvdGFsSXRlbXMiLCJpdGVtcyIsImNyZWF0ZV8iLCJjcmVhdGVPcHRpb25zIiwicmF3IiwiYXNzb2NpYXRpb25zIiwiX2V4dHJhY3RBc3NvY2lhdGlvbnMiLCJuZWVkQ3JlYXRlQXNzb2NzIiwiaXNFbXB0eSIsImNvbm5lY3Rpb24iLCJiZWdpblRyYW5zYWN0aW9uXyIsIl9wcmVwYXJlRW50aXR5RGF0YV8iLCJSVUxFX0JFRk9SRV9DUkVBVEUiLCJsYXRlc3QiLCJhZnRlckNyZWF0ZV8iLCJfY3JlYXRlQXNzb2NzXyIsInVwZGF0ZV8iLCJ1cGRhdGVPcHRpb25zIiwiJGJ5UGFzc1JlYWRPbmx5IiwiZW50aXR5IiwicmVhc29uIiwiX3VwZGF0ZV8iLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiZGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCJub3RGaW5pc2hlZCIsIlJVTEVfQkVGT1JFX0RFTEVURSIsImJlZm9yZURlbGV0ZV8iLCJleGlzdGluZyIsIl9jb250YWluc1VuaXF1ZUtleSIsIl9lbnN1cmVDb250YWluc1VuaXF1ZUtleSIsImNvbmRpdGlvbiIsImNvbnRhaW5zVW5pcXVlS2V5IiwiaXNVcGRhdGluZyIsImkxOG4iLCJvcE9wdGlvbnMiLCJfZGVwZW5kc09uRXhpc3RpbmdEYXRhIiwiZWFjaEFzeW5jXyIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJmb3JjZVVwZGF0ZSIsInVwZGF0ZUJ5RGIiLCJhdXRvIiwiY3JlYXRlQnlEYiIsImhhc093blByb3BlcnR5IiwiUlVMRV9BRlRFUl9WQUxJREFUSU9OIiwiYXBwbHlNb2RpZmllcnNfIiwidHJhbnNsYXRlVmFsdWUiLCIkdmFyaWFibGVzIiwiZXhlY3V0b3IiLCJiaW5kIiwiY29tbWl0XyIsImVycm9yIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJzcGxpdCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwiZm9yU2luZ2xlUmVjb3JkIiwiQXJyYXkiLCJpc0FycmF5Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRoYXZpbmciLCIkcHJvamVjdGlvbiIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidmFyaWFibGVzIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwib29sVHlwZSIsIm1hcFZhbHVlcyIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVFLEVBQUFBLENBQUY7QUFBS0MsRUFBQUE7QUFBTCxJQUF3QkYsSUFBSSxDQUFDQyxDQUFuQzs7QUFDQSxNQUFNRSxNQUFNLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXRCOztBQUNBLE1BQU1LLFVBQVUsR0FBR0wsT0FBTyxDQUFDLGNBQUQsQ0FBMUI7O0FBQ0EsTUFBTU0sS0FBSyxHQUFHTixPQUFPLENBQUMsU0FBRCxDQUFyQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLG1CQUFGO0FBQXVCQyxFQUFBQSxnQkFBdkI7QUFBeUNDLEVBQUFBLGdCQUF6QztBQUEyREMsRUFBQUE7QUFBM0QsSUFBNkVOLE1BQW5GOztBQUNBLE1BQU1PLFFBQVEsR0FBR1gsT0FBTyxDQUFDLGtCQUFELENBQXhCOztBQUNBLE1BQU1ZLEtBQUssR0FBR1osT0FBTyxDQUFDLGVBQUQs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LElBQW9CLEVBQUVRLEtBQUssQ0FBQ3hHLElBQU4sSUFBY3lHLFNBQVMsQ0FBQ1QsS0FBMUIsQ0FBeEIsRUFBMEQ7QUFDdEQsa0JBQU0sSUFBSTVJLGdCQUFKLENBQXNCLG9CQUFtQm9KLEtBQUssQ0FBQ3hHLElBQUssK0JBQXBELENBQU47QUFDSDs7QUFFRCxpQkFBT3lHLFNBQVMsQ0FBQ1QsS0FBVixDQUFnQlEsS0FBSyxDQUFDeEcsSUFBdEIsQ0FBUDtBQUNILFNBVk0sTUFVQSxJQUFJd0csS0FBSyxDQUFDRSxPQUFOLEtBQWtCLGFBQXRCLEVBQXFDO0FBQ3hDLGlCQUFPLEtBQUtKLHFCQUFMLENBQTJCRSxLQUFLLENBQUN4RyxJQUFqQyxDQUFQO0FBQ0g7O0FBRUQsY0FBTSxJQUFJb0csS0FBSixDQUFVLDRCQUE0QkksS0FBSyxDQUFDUyxPQUE1QyxDQUFOO0FBQ0g7O0FBRUQsYUFBT25LLENBQUMsQ0FBQ29LLFNBQUYsQ0FBWVYsS0FBWixFQUFvQmYsQ0FBRCxJQUFPLEtBQUtwQixjQUFMLENBQW9Cb0IsQ0FBcEIsRUFBdUJnQixTQUF2QixDQUExQixDQUFQO0FBQ0g7O0FBRUQsUUFBSVosS0FBSyxDQUFDQyxPQUFOLENBQWNVLEtBQWQsQ0FBSixFQUEwQjtBQUN0QixhQUFPQSxLQUFLLENBQUM5RixHQUFOLENBQVUrRSxDQUFDLElBQUksS0FBS3BCLGNBQUwsQ0FBb0JvQixDQUFwQixFQUF1QmdCLFNBQXZCLENBQWYsQ0FBUDtBQUNIOztBQUVELFdBQU8sS0FBS0YsVUFBTCxDQUFnQkMsS0FBaEIsQ0FBUDtBQUNIOztBQTVwQmE7O0FBK3BCbEJXLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnpKLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCB9ID0gVXRpbC5fO1xuY29uc3QgRXJyb3JzID0gcmVxdWlyZSgnLi9FcnJvcnMnKTtcbmNvbnN0IEdlbmVyYXRvcnMgPSByZXF1aXJlKCcuL0dlbmVyYXRvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi90eXBlcycpO1xuY29uc3QgeyBEYXRhVmFsaWRhdGlvbkVycm9yLCBPb2xvbmdVc2FnZUVycm9yLCBEc09wZXJhdGlvbkVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSBFcnJvcnM7XG5jb25zdCBGZWF0dXJlcyA9IHJlcXVpcmUoJy4vZW50aXR5RmVhdHVyZXMnKTtcbmNvbnN0IFJ1bGVzID0gcmVxdWlyZSgnLi4vZW51bS9SdWxlcycpO1xuXG5jb25zdCB7IGlzTm90aGluZyB9ID0gcmVxdWlyZSgnLi4vdXRpbHMvbGFuZycpO1xuXG5jb25zdCBORUVEX09WRVJSSURFID0gJ1Nob3VsZCBiZSBvdmVycmlkZWQgYnkgZHJpdmVyLXNwZWNpZmljIHN1YmNsYXNzLic7XG5cbi8qKlxuICogQmFzZSBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgRW50aXR5TW9kZWwge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtyYXdEYXRhXSAtIFJhdyBkYXRhIG9iamVjdCBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3RvcihyYXdEYXRhKSB7XG4gICAgICAgIGlmIChyYXdEYXRhKSB7XG4gICAgICAgICAgICAvL29ubHkgcGljayB0aG9zZSB0aGF0IGFyZSBmaWVsZHMgb2YgdGhpcyBlbnRpdHlcbiAgICAgICAgICAgIE9iamVjdC5hc3NpZ24odGhpcywgcmF3RGF0YSk7XG4gICAgICAgIH0gXG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIEdldCBhbiBvYmplY3Qgb2YgdGhlIHByaW1hcnkga2V5IHZhbHVlcy5cbiAgICAgKi9cbiAgICBnZXQgJHBrVmFsdWVzKCkge1xuICAgICAgICByZXR1cm4gXy5waWNrKHRoaXMsIF8uY2FzdEFycmF5KHRoaXMuY29uc3RydWN0b3IubWV0YS5rZXlGaWVsZCkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvcHVsYXRlIGRhdGEgZnJvbSBkYXRhYmFzZS5cbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHJldHVybiB7RW50aXR5TW9kZWx9XG4gICAgICovXG4gICAgc3RhdGljIHBvcHVsYXRlKGRhdGEpIHtcbiAgICAgICAgbGV0IE1vZGVsQ2xhc3MgPSB0aGlzO1xuICAgICAgICByZXR1cm4gbmV3IE1vZGVsQ2xhc3MoZGF0YSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGZpZWxkIG5hbWVzIGFycmF5IG9mIGEgdW5pcXVlIGtleSBmcm9tIGlucHV0IGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBJbnB1dCBkYXRhLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXRVbmlxdWVLZXlGaWVsZHNGcm9tKGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogR2V0IGtleS12YWx1ZSBwYWlycyBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oZGF0YSkgeyAgXG4gICAgICAgIHByZTogXy5pc1BsYWluT2JqZWN0KGRhdGEpOyAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCB1a0ZpZWxkcyA9IHRoaXMuZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKTtcbiAgICAgICAgcmV0dXJuIF8ucGljayhkYXRhLCB1a0ZpZWxkcyk7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIEZpbmQgb25lIHJlY29yZCwgcmV0dXJucyBhIG1vZGVsIG9iamVjdCBjb250YWluaW5nIHRoZSByZWNvcmQgb3IgdW5kZWZpbmVkIGlmIG5vdGhpbmcgZm91bmQuXG4gICAgICogQHBhcmFtIHtvYmplY3R8YXJyYXl9IGNvbmRpdGlvbiAtIFF1ZXJ5IGNvbmRpdGlvbiwga2V5LXZhbHVlIHBhaXIgd2lsbCBiZSBqb2luZWQgd2l0aCAnQU5EJywgYXJyYXkgZWxlbWVudCB3aWxsIGJlIGpvaW5lZCB3aXRoICdPUicuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtmaW5kT3B0aW9uc10gLSBmaW5kT3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb25dIC0gSm9pbmluZ3NcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRwcm9qZWN0aW9uXSAtIFNlbGVjdGVkIGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHF1ZXJ5XSAtIEV4dHJhIGNvbmRpdGlvblxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGdyb3VwQnldIC0gR3JvdXAgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kb3JkZXJCeV0gLSBPcmRlciBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRvZmZzZXRdIC0gT2Zmc2V0XG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kbGltaXRdIC0gTGltaXQgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikgeyAgXG4gICAgICAgICAgICAgICAgLy9yb3dzLCBjb2xvdW1ucywgYWxpYXNNYXAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChyZWNvcmRzWzBdLmxlbmd0aCA9PT0gMCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZHMubGVuZ3RoID09PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzZXJ0OiByZWNvcmRzLmxlbmd0aCA9PT0gMTtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSByZWNvcmRzWzBdO1xuXG4gICAgICAgICAgICBpZiAoY29udGV4dC5maW5kT3B0aW9ucy4kdW5ib3hpbmcpIHJldHVybiByZXN1bHQ7XG5cbiAgICAgICAgICAgIHJldHVybiB0aGlzLnBvcHVsYXRlKHJlc3VsdCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEZpbmQgcmVjb3JkcyBtYXRjaGluZyB0aGUgY29uZGl0aW9uLCByZXR1cm5zIGFuIGFycmF5IG9mIG1vZGVsIG9iamVjdCBvciBhbiBhcnJheSBvZiByZWNvcmRzIGRpcmVjdGx5IGlmICR1bmJveGluZyA9IHRydWUuICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2ZpbmRPcHRpb25zXSAtIGZpbmRPcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbl0gLSBKb2luaW5nc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJHByb2plY3Rpb25dIC0gU2VsZWN0ZWQgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kZ3JvdXBCeV0gLSBHcm91cCBieSBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRvcmRlckJ5XSAtIE9yZGVyIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJG9mZnNldF0gLSBPZmZzZXRcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiRsaW1pdF0gLSBMaW1pdCBcbiAgICAgKiBAcHJvcGVydHkge251bWJlcn0gW2ZpbmRPcHRpb25zLiR0b3RhbENvdW50XSAtIFJldHVybiB0b3RhbENvdW50ICAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZmluZE9wdGlvbnMuJGluY2x1ZGVEZWxldGVkPWZhbHNlXSAtIEluY2x1ZGUgdGhvc2UgbWFya2VkIGFzIGxvZ2ljYWwgZGVsZXRlZC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7YXJyYXl9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRBbGxfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGZpbmRPcHRpb25zID0gdGhpcy5fcHJlcGFyZVF1ZXJpZXMoZmluZE9wdGlvbnMpO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB0b3RhbENvdW50O1xuXG4gICAgICAgIGxldCByb3dzID0gYXdhaXQgdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJlY29yZHMgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5maW5kXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5maW5kT3B0aW9ucywgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgaWYgKCFyZWNvcmRzKSB0aHJvdyBuZXcgRHNPcGVyYXRpb25FcnJvcignY29ubmVjdG9yLmZpbmRfKCkgcmV0dXJucyB1bmRlZmluZWQgZGF0YSByZWNvcmQuJyk7XG5cbiAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pIHtcbiAgICAgICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdG90YWxDb3VudCA9IHJlY29yZHNbM107XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJlY29yZHMgPSB0aGlzLl9tYXBSZWNvcmRzVG9PYmplY3RzKHJlY29yZHMsIGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbik7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1sxXTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkcyA9IHJlY29yZHNbMF07XG4gICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbnRleHQuZmluZE9wdGlvbnMuJHVuYm94aW5nKSByZXR1cm4gcmVjb3JkcztcblxuICAgICAgICAgICAgcmV0dXJuIHJlY29yZHMubWFwKHJvdyA9PiB0aGlzLnBvcHVsYXRlKHJvdykpO1xuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHVuYm94aW5nPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGNyZWF0ZU9wdGlvbnMgfHwgKGNyZWF0ZU9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNyZWF0ZU9wdGlvbnMuJHVuYm94aW5nID8gY29udGV4dC5sYXRlc3QgOiB0aGlzLnBvcHVsYXRlKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB3aXRoIGdpdmVuIGRhdGEuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgLSBFbnRpdHkgZGF0YSB3aXRoIGF0IGxlYXN0IG9uZSB1bmlxdWUga2V5IChwYWlyKSBnaXZlblxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kdW5ib3hpbmc9ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl1cbiAgICAgKiBAcmV0dXJucyB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBhc3luYyBfdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICByYXc6IGRhdGEsIFxuICAgICAgICAgICAgdXBkYXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLl9wcmVwYXJlRW50aXR5RGF0YV8oY29udGV4dCwgdHJ1ZSAvKiBpcyB1cGRhdGluZyAqLyk7ICAgICAgICAgIFxuXG4gICAgICAgICAgICBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9VUERBVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IudXBkYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5hZnRlclVwZGF0ZV8oY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB1cGRhdGVPcHRpb25zLiR1bmJveGluZyA/IGNvbnRleHQubGF0ZXN0IDogdGhpcy5wb3B1bGF0ZShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2VcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiR1bmJveGluZz1mYWxzZV0gLSBXaGVuIGZldGNoQXJyYXkgPSB0cnVlLCB0aGUgcmVzdWx0IHdpbGwgYmUgcmV0dXJuZWQgZGlyZWN0bHkgd2l0aG91dCBjcmVhdGluZyBtb2RlbCBvYmplY3RzLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGRlbGV0ZV8oZGVsZXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgcHJlOiBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcblxuICAgICAgICBpZiAoXy5pc0VtcHR5KGRlbGV0ZU9wdGlvbnMuJHF1ZXJ5KSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0VtcHR5IGNvbmRpdGlvbiBpcyBub3QgYWxsb3dlZCBmb3IgZGVsZXRpbmcgYW4gZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgZGVsZXRlT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IG5vdEZpbmlzaGVkID0gYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfREVMRVRFLCB0aGlzLCBjb250ZXh0KTsgICAgIFxuICAgICAgICBpZiAoIW5vdEZpbmlzaGVkKSB7XG4gICAgICAgICAgICByZXR1cm4gY29udGV4dC5sYXRlc3Q7XG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4ge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5iZWZvcmVEZWxldGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBjb250ZXh0LnJlc3VsdCA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmRlbGV0ZV8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5LFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBkZWxldGVPcHRpb25zLiR1bmJveGluZyA/IGNvbnRleHQuZXhpc3RpbmcgOiB0aGlzLnBvcHVsYXRlKGNvbnRleHQuZXhpc3RpbmcpO1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDaGVjayB3aGV0aGVyIGEgZGF0YSByZWNvcmQgY29udGFpbnMgcHJpbWFyeSBrZXkgb3IgYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgcGFpci5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2NvbnRhaW5zVW5pcXVlS2V5KGRhdGEpIHtcbiAgICAgICAgcmV0dXJuIF8uZmluZCh0aGlzLm1ldGEudW5pcXVlS2V5cywgZmllbGRzID0+IF8uZXZlcnkoZmllbGRzLCBmID0+ICFfLmlzTmlsKGRhdGFbZl0pKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRW5zdXJlIHRoZSBjb25kaXRpb24gY29udGFpbnMgb25lIG9mIHRoZSB1bmlxdWUga2V5cy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbikge1xuICAgICAgICBsZXQgY29udGFpbnNVbmlxdWVLZXkgPSB0aGlzLl9jb250YWluc1VuaXF1ZUtleShjb25kaXRpb24pO1xuXG4gICAgICAgIGlmICghY29udGFpbnNVbmlxdWVLZXkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICByZWFzb246ICdTaW5nbGUgcmVjb3JkIG9wZXJhdGlvbiByZXF1aXJlcyBjb25kaXRpb24gdG8gYmUgY29udGFpbmluZyB1bmlxdWUga2V5LicsXG4gICAgICAgICAgICAgICAgICAgIGNvbmRpdGlvblxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICk7XG4gICAgICAgIH1cbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogUHJlcGFyZSB2YWxpZCBhbmQgc2FuaXRpemVkIGVudGl0eSBkYXRhIGZvciBzZW5kaW5nIHRvIGRhdGFiYXNlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0IC0gT3BlcmF0aW9uIGNvbnRleHQuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGNvbnRleHQucmF3IC0gUmF3IGlucHV0IGRhdGEuXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNvbm5PcHRpb25zXVxuICAgICAqIEBwYXJhbSB7Ym9vbH0gaXNVcGRhdGluZyAtIEZsYWcgZm9yIHVwZGF0aW5nIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCBpc1VwZGF0aW5nID0gZmFsc2UpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGE7XG4gICAgICAgIGxldCBpMThuID0gdGhpcy5pMThuO1xuICAgICAgICBsZXQgeyBuYW1lLCBmaWVsZHMgfSA9IG1ldGE7ICAgICAgICBcblxuICAgICAgICBsZXQgeyByYXcgfSA9IGNvbnRleHQ7XG4gICAgICAgIGxldCBsYXRlc3QgPSB7fSwgZXhpc3Rpbmc7XG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gbGF0ZXN0OyAgICAgICBcblxuICAgICAgICBpZiAoIWNvbnRleHQuaTE4bikge1xuICAgICAgICAgICAgY29udGV4dC5pMThuID0gaTE4bjtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBvcE9wdGlvbnMgPSBpc1VwZGF0aW5nID8gY29udGV4dC51cGRhdGVPcHRpb25zIDogY29udGV4dC5jcmVhdGVPcHRpb25zO1xuXG4gICAgICAgIGlmIChpc1VwZGF0aW5nICYmIHRoaXMuX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShyYXcpKSB7XG4gICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBvcE9wdGlvbnMuJHF1ZXJ5LCAkdW5ib3hpbmc6IHRydWUgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGF3YWl0IFV0aWwuZWFjaEFzeW5jXyhmaWVsZHMsIGFzeW5jIChmaWVsZEluZm8sIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgaWYgKGZpZWxkTmFtZSBpbiByYXcpIHtcbiAgICAgICAgICAgICAgICAvL2ZpZWxkIHZhbHVlIGdpdmVuIGluIHJhdyBkYXRhXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5yZWFkT25seSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzVXBkYXRpbmcgfHwgIW9wT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkuaGFzKGZpZWxkTmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vcmVhZCBvbmx5LCBub3QgYWxsb3cgdG8gc2V0IGJ5IGlucHV0IHZhbHVlXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgUmVhZC1vbmx5IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgc2V0IGJ5IG1hbnVhbCBpbnB1dC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby5mcmVlemVBZnRlck5vbkRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBleGlzdGluZywgJ1wiZnJlZXplQWZ0ZXJOb25EZWZhdWx0XCIgcXVhbGlmaWVyIHJlcXVpcmVzIGV4aXN0aW5nIGRhdGEuJztcblxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdbZmllbGROYW1lXSAhPT0gZmllbGRJbmZvLmRlZmF1bHQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vZnJlZXplQWZ0ZXJOb25EZWZhdWx0LCBub3QgYWxsb3cgdG8gY2hhbmdlIGlmIHZhbHVlIGlzIG5vbi1kZWZhdWx0XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgRnJlZXplQWZ0ZXJOb25EZWZhdWx0IGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgY2hhbmdlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLCAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvKiogIHRvZG86IGZpeCBkZXBlbmRlbmN5XG4gICAgICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgZmllbGRJbmZvLndyaXRlT25jZSkgeyAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcIndyaXRlT25jZVwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG4gICAgICAgICAgICAgICAgICAgIGlmICghXy5pc05pbChleGlzdGluZ1tmaWVsZE5hbWVdKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFdyaXRlLW9uY2UgZmllbGQgXCIke2ZpZWxkTmFtZX1cIiBpcyBub3QgYWxsb3dlZCB0byBiZSB1cGRhdGUgb25jZSBpdCB3YXMgc2V0LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gKi9cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvL3Nhbml0aXplIGZpcnN0XG4gICAgICAgICAgICAgICAgaWYgKGlzTm90aGluZyhyYXdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBUaGUgXCIke2ZpZWxkTmFtZX1cIiB2YWx1ZSBvZiBcIiR7bmFtZX1cIiBlbnRpdHkgY2Fubm90IGJlIG51bGwuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gVHlwZXMuc2FuaXRpemUocmF3W2ZpZWxkTmFtZV0sIGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy9ub3QgZ2l2ZW4gaW4gcmF3IGRhdGFcbiAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkSW5mby5mb3JjZVVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBmb3JjZSB1cGRhdGUgcG9saWN5LCBlLmcuIHVwZGF0ZVRpbWVzdGFtcFxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLnVwZGF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vcmVxdWlyZSBnZW5lcmF0b3IgdG8gcmVmcmVzaCBhdXRvIGdlbmVyYXRlZCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoXG4gICAgICAgICAgICAgICAgICAgICAgICBgXCIke2ZpZWxkTmFtZX1cIiBvZiBcIiR7bmFtZX1cIiBlbnR0aXkgaXMgcmVxdWlyZWQgZm9yIGVhY2ggdXBkYXRlLmAsIHsgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mb1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApOyAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAvL25ldyByZWNvcmRcbiAgICAgICAgICAgIGlmICghZmllbGRJbmZvLmNyZWF0ZUJ5RGIpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy9oYXMgZGVmYXVsdCBzZXR0aW5nIGluIG1ldGEgZGF0YVxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGZpZWxkSW5mby5kZWZhdWx0O1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZmllbGRJbmZvLmF1dG8pIHtcbiAgICAgICAgICAgICAgICAgICAgLy9hdXRvbWF0aWNhbGx5IGdlbmVyYXRlZFxuICAgICAgICAgICAgICAgICAgICBsYXRlc3RbZmllbGROYW1lXSA9IGF3YWl0IEdlbmVyYXRvcnMuZGVmYXVsdChmaWVsZEluZm8sIGkxOG4pO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgLy9taXNzaW5nIHJlcXVpcmVkXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudGl0eSBpcyByZXF1aXJlZC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSAvLyBlbHNlIGRlZmF1bHQgdmFsdWUgc2V0IGJ5IGRhdGFiYXNlIG9yIGJ5IHJ1bGVzXG4gICAgICAgIH0pO1xuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQUZURVJfVkFMSURBVElPTiwgdGhpcywgY29udGV4dCk7ICAgIFxuXG4gICAgICAgIGF3YWl0IHRoaXMuYXBwbHlNb2RpZmllcnNfKGNvbnRleHQsIGlzVXBkYXRpbmcpO1xuXG4gICAgICAgIGNvbnRleHQubGF0ZXN0ID0gdGhpcy50cmFuc2xhdGVWYWx1ZShsYXRlc3QsIG9wT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICByZXR1cm4gY29udGV4dDtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3NhZmVFeGVjdXRlXyhleGVjdXRvciwgY29udGV4dCkge1xuICAgICAgICBleGVjdXRvciA9IGV4ZWN1dG9yLmJpbmQodGhpcyk7XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY29ubk9wdGlvbnMgJiYgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgcmV0dXJuIGV4ZWN1dG9yKGNvbnRleHQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIC8vaWYgdGhlIGV4ZWN1dG9yIGhhdmUgaW5pdGlhdGVkIGEgdHJhbnNhY3Rpb25cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgJiYgXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uICYmIFxuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmNvbW1pdF8oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICAvL3dlIGhhdmUgdG8gcm9sbGJhY2sgaWYgZXJyb3Igb2NjdXJyZWQgaW4gYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3Iucm9sbGJhY2tfKGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbik7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2RlcGVuZHNPbkV4aXN0aW5nRGF0YShpbnB1dCkge1xuICAgICAgICAvL2NoZWNrIG1vZGlmaWVyIGRlcGVuZGVuY2llc1xuICAgICAgICBsZXQgZGVwcyA9IHRoaXMubWV0YS5maWVsZERlcGVuZGVuY2llcztcbiAgICAgICAgbGV0IGhhc0RlcGVuZHMgPSBmYWxzZTtcblxuICAgICAgICBpZiAoZGVwcykgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChkZXBzLCAoZGVwLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGROYW1lIGluIGlucHV0KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmZpbmQoZGVwLCBkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBbIHN0YWdlLCBmaWVsZCBdID0gZC5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIChzdGFnZSA9PT0gJ2xhdGVzdCcgfHwgc3RhZ2UgPT09ICdleGlzdG5nJykgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc0RlcGVuZHMpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8vY2hlY2sgYnkgc3BlY2lhbCBydWxlc1xuICAgICAgICBsZXQgYXRMZWFzdE9uZU5vdE51bGwgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXRMZWFzdE9uZU5vdE51bGw7XG4gICAgICAgIGlmIChhdExlYXN0T25lTm90TnVsbCkge1xuICAgICAgICAgICAgaGFzRGVwZW5kcyA9IF8uZmluZChhdExlYXN0T25lTm90TnVsbCwgZmllbGRzID0+IF8uZmluZChmaWVsZHMsIGZpZWxkID0+IChmaWVsZCBpbiBpbnB1dCkgJiYgXy5pc05pbChpbnB1dFtmaWVsZF0pKSk7XG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaGFzUmVzZXJ2ZWRLZXlzKG9iaikge1xuICAgICAgICByZXR1cm4gXy5maW5kKG9iaiwgKHYsIGspID0+IGtbMF0gPT09ICckJyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlUXVlcmllcyhvcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgPSBmYWxzZSkge1xuICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChvcHRpb25zKSkge1xuICAgICAgICAgICAgaWYgKGZvclNpbmdsZVJlY29yZCAmJiBBcnJheS5pc0FycmF5KHRoaXMubWV0YS5rZXlGaWVsZCkpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignQ2Fubm90IHVzZSBhIHNpbmd1bGFyIHZhbHVlIGFzIGNvbmRpdGlvbiB0byBxdWVyeSBhZ2FpbnN0IGEgZW50aXR5IHdpdGggY29tYmluZWQgcHJpbWFyeSBrZXkuJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBvcHRpb25zID8geyAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudHJhbnNsYXRlVmFsdWUob3B0aW9ucykgfSB9IDoge307XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbm9ybWFsaXplZE9wdGlvbnMgPSB7fSwgcXVlcnkgPSB7fTtcblxuICAgICAgICBfLmZvck93bihvcHRpb25zLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zW2tdID0gdjtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcXVlcnlba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB7IC4uLnF1ZXJ5LCAuLi5ub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgfTtcblxuICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkKSB7XG4gICAgICAgICAgICB0aGlzLl9lbnN1cmVDb250YWluc1VuaXF1ZUtleShub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcXVlcnkgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRoYXZpbmcpIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRoYXZpbmcgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKG5vcm1hbGl6ZWRPcHRpb25zLiRoYXZpbmcsIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uKSB7XG4gICAgICAgICAgICBub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24sIG5vcm1hbGl6ZWRPcHRpb25zLiR2YXJpYWJsZXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG5vcm1hbGl6ZWRPcHRpb25zO1xuICAgIH1cblxuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cygpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTsgICAgXG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9jcmVhdGVBc3NvY3NfKGNvbnRleHQsIGFzc29jcykge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIHRyYW5zbGF0ZVZhbHVlKHZhbHVlLCB2YXJpYWJsZXMpIHtcbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdTZXNzaW9uVmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICgoIXZhcmlhYmxlcy5zZXNzaW9uIHx8ICEodmFsdWUubmFtZSBpbiAgdmFyaWFibGVzLnNlc3Npb24pKSAmJiAhdmFsdWUub3B0aW9uYWwpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBlcnJBcmdzID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ01lc3NhZ2UpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ01lc3NhZ2UpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHZhbHVlLm1pc3NpbmdTdGF0dXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlcnJBcmdzLnB1c2godmFsdWUubWlzc2luZ1N0YXR1cyB8fCBIdHRwQ29kZS5CQURfUkVRVUVTVCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKC4uLmVyckFyZ3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhcmlhYmxlcy5zZXNzaW9uW3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1F1ZXJ5VmFyaWFibGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVmFyaWFibGVzIGNvbnRleHQgbWlzc2luZy4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGlmICghdmFyaWFibGVzLnF1ZXJ5IHx8ICEodmFsdWUubmFtZSBpbiB2YXJpYWJsZXMucXVlcnkpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgUXVlcnkgcGFyYW1ldGVyIFwiJHt2YWx1ZS5uYW1lfVwiIGluIGNvbmZpZ3VyYXRpb24gbm90IGZvdW5kLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnF1ZXJ5W3ZhbHVlLm5hbWVdO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fdHJhbnNsYXRlU3ltYm9sVG9rZW4odmFsdWUubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdOb3QgaW1wbGV0ZW1lbnRlZCB5ZXQuICcgKyB2YWx1ZS5vb2xUeXBlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwVmFsdWVzKHZhbHVlLCAodikgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm1hcCh2ID0+IHRoaXMudHJhbnNsYXRlVmFsdWUodiwgdmFyaWFibGVzKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2VyaWFsaXplKHZhbHVlKTtcbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gRW50aXR5TW9kZWw7Il19