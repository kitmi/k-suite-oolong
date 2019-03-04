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

      if (findOptions.$association && !findOptions.$skipOrm) {
        if (records[0].length === 0) return undefined;
        records = this._mapRecordsToObjects(records, findOptions.$association);
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

    if (findOptions.$association) {
      findOptions.$association = this._prepareAssociations(findOptions);
    }

    let totalCount;
    let rows = await this._safeExecute_(async context => {
      let records = await this.db.connector.find_(this.meta.name, context.findOptions, context.connOptions);
      if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

      if (findOptions.$association && !findOptions.$skipOrm) {
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

      return this.afterFindAll_(context, records);
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

      return context.latest;
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
      await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context);
      context.result = await this.db.connector.update_(this.meta.name, context.latest, context.updateOptions.$query, context.connOptions);
      await this.afterUpdate_(context);
      return context.latest;
    }, context);
  }

  static async delete_(deleteOptions, connOptions) {
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
      return context.existing;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0VudGl0eU1vZGVsLmpzIl0sIm5hbWVzIjpbIkh0dHBDb2RlIiwicmVxdWlyZSIsIl8iLCJlYWNoQXN5bmNfIiwiRXJyb3JzIiwiR2VuZXJhdG9ycyIsIlR5cGVzIiwiRGF0YVZhbGlkYXRpb25FcnJvciIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJEc09wZXJhdGlvbkVycm9yIiwiQnVzaW5lc3NFcnJvciIsIkZlYXR1cmVzIiwiUnVsZXMiLCJpc05vdGhpbmciLCJORUVEX09WRVJSSURFIiwiRW50aXR5TW9kZWwiLCJjb25zdHJ1Y3RvciIsInJhd0RhdGEiLCJPYmplY3QiLCJhc3NpZ24iLCIkcGtWYWx1ZXMiLCJwaWNrIiwiY2FzdEFycmF5IiwibWV0YSIsImtleUZpZWxkIiwicG9wdWxhdGUiLCJkYXRhIiwiTW9kZWxDbGFzcyIsImdldFVuaXF1ZUtleUZpZWxkc0Zyb20iLCJmaW5kIiwidW5pcXVlS2V5cyIsImZpZWxkcyIsImV2ZXJ5IiwiZiIsImlzTmlsIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJpc1BsYWluT2JqZWN0IiwidWtGaWVsZHMiLCJmaW5kT25lXyIsImZpbmRPcHRpb25zIiwiY29ubk9wdGlvbnMiLCJfcHJlcGFyZVF1ZXJpZXMiLCJjb250ZXh0IiwiYXBwbHlSdWxlc18iLCJSVUxFX0JFRk9SRV9GSU5EIiwiJGFzc29jaWF0aW9uIiwiX3ByZXBhcmVBc3NvY2lhdGlvbnMiLCJfc2FmZUV4ZWN1dGVfIiwicmVjb3JkcyIsImRiIiwiY29ubmVjdG9yIiwiZmluZF8iLCJuYW1lIiwiJHNraXBPcm0iLCJsZW5ndGgiLCJ1bmRlZmluZWQiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJlc3VsdCIsImZpbmRBbGxfIiwidG90YWxDb3VudCIsInJvd3MiLCIkdG90YWxDb3VudCIsImFmdGVyRmluZEFsbF8iLCJ0b3RhbEl0ZW1zIiwiaXRlbXMiLCJjcmVhdGVfIiwiY3JlYXRlT3B0aW9ucyIsInJhdyIsImFzc29jaWF0aW9ucyIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwibmVlZENyZWF0ZUFzc29jcyIsImlzRW1wdHkiLCJjb25uZWN0aW9uIiwiYmVnaW5UcmFuc2FjdGlvbl8iLCJfcHJlcGFyZUVudGl0eURhdGFfIiwiUlVMRV9CRUZPUkVfQ1JFQVRFIiwibGF0ZXN0IiwiYWZ0ZXJDcmVhdGVfIiwiX2NyZWF0ZUFzc29jc18iLCJ1cGRhdGVfIiwidXBkYXRlT3B0aW9ucyIsIiRieVBhc3NSZWFkT25seSIsImVudGl0eSIsInJlYXNvbiIsIl91cGRhdGVfIiwidXBkYXRlTWFueV8iLCJmb3JTaW5nbGVSZWNvcmQiLCJjb25kaXRpb25GaWVsZHMiLCIkcXVlcnkiLCJvbWl0IiwiUlVMRV9CRUZPUkVfVVBEQVRFIiwiYWZ0ZXJVcGRhdGVfIiwiZGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCJfZGVsZXRlXyIsImRlbGV0ZU1hbnlfIiwibm90RmluaXNoZWQiLCJSVUxFX0JFRk9SRV9ERUxFVEUiLCJiZWZvcmVEZWxldGVfIiwiZXhpc3RpbmciLCJfY29udGFpbnNVbmlxdWVLZXkiLCJfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkiLCJjb25kaXRpb24iLCJjb250YWluc1VuaXF1ZUtleSIsImlzVXBkYXRpbmciLCJpMThuIiwib3BPcHRpb25zIiwiX2RlcGVuZHNPbkV4aXN0aW5nRGF0YSIsImZpZWxkSW5mbyIsImZpZWxkTmFtZSIsInJlYWRPbmx5IiwiaGFzIiwiZnJlZXplQWZ0ZXJOb25EZWZhdWx0IiwiZGVmYXVsdCIsIm9wdGlvbmFsIiwic2FuaXRpemUiLCJlcnJvciIsIm1lc3NhZ2UiLCJzdGFjayIsImZvcmNlVXBkYXRlIiwidXBkYXRlQnlEYiIsImF1dG8iLCJjcmVhdGVCeURiIiwiaGFzT3duUHJvcGVydHkiLCJSVUxFX0FGVEVSX1ZBTElEQVRJT04iLCJhcHBseU1vZGlmaWVyc18iLCJ0cmFuc2xhdGVWYWx1ZSIsIiR2YXJpYWJsZXMiLCJleGVjdXRvciIsImJpbmQiLCJjb21taXRfIiwicm9sbGJhY2tfIiwiaW5wdXQiLCJkZXBzIiwiZmllbGREZXBlbmRlbmNpZXMiLCJoYXNEZXBlbmRzIiwiZGVwIiwiZCIsInN0YWdlIiwiZmllbGQiLCJzcGxpdCIsImF0TGVhc3RPbmVOb3ROdWxsIiwiZmVhdHVyZXMiLCJfaGFzUmVzZXJ2ZWRLZXlzIiwib2JqIiwidiIsImsiLCJvcHRpb25zIiwiQXJyYXkiLCJpc0FycmF5Iiwibm9ybWFsaXplZE9wdGlvbnMiLCJxdWVyeSIsImZvck93biIsIiRoYXZpbmciLCIkcHJvamVjdGlvbiIsIkVycm9yIiwiYXNzb2NzIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidmFyaWFibGVzIiwib29yVHlwZSIsInNlc3Npb24iLCJlcnJBcmdzIiwibWlzc2luZ01lc3NhZ2UiLCJwdXNoIiwibWlzc2luZ1N0YXR1cyIsIkJBRF9SRVFVRVNUIiwib29sVHlwZSIsIm1hcFZhbHVlcyIsIm1hcCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsUUFBUSxHQUFHQyxPQUFPLENBQUMsbUJBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBb0JGLE9BQU8sQ0FBQyxVQUFELENBQWpDOztBQUNBLE1BQU1HLE1BQU0sR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBdEI7O0FBQ0EsTUFBTUksVUFBVSxHQUFHSixPQUFPLENBQUMsY0FBRCxDQUExQjs7QUFDQSxNQUFNSyxLQUFLLEdBQUdMLE9BQU8sQ0FBQyxTQUFELENBQXJCOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsbUJBQUY7QUFBdUJDLEVBQUFBLGdCQUF2QjtBQUF5Q0MsRUFBQUEsZ0JBQXpDO0FBQTJEQyxFQUFBQTtBQUEzRCxJQUE2RU4sTUFBbkY7O0FBQ0EsTUFBTU8sUUFBUSxHQUFHVixPQUFPLENBQUMsa0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsZUFBRCxDQUFyQjs7QUFFQSxNQUFNO0FBQUVZLEVBQUFBO0FBQUYsSUFBZ0JaLE9BQU8sQ0FBQyxlQUFELENBQTdCOztBQUVBLE1BQU1hLGFBQWEsR0FBRyxrREFBdEI7O0FBTUEsTUFBTUMsV0FBTixDQUFrQjtBQUlkQyxFQUFBQSxXQUFXLENBQUNDLE9BQUQsRUFBVTtBQUNqQixRQUFJQSxPQUFKLEVBQWE7QUFFVEMsTUFBQUEsTUFBTSxDQUFDQyxNQUFQLENBQWMsSUFBZCxFQUFvQkYsT0FBcEI7QUFDSDtBQUNKOztBQUtELE1BQUlHLFNBQUosR0FBZ0I7QUFDWixXQUFPbEIsQ0FBQyxDQUFDbUIsSUFBRixDQUFPLElBQVAsRUFBYW5CLENBQUMsQ0FBQ29CLFNBQUYsQ0FBWSxLQUFLTixXQUFMLENBQWlCTyxJQUFqQixDQUFzQkMsUUFBbEMsQ0FBYixDQUFQO0FBQ0g7O0FBT0QsU0FBT0MsUUFBUCxDQUFnQkMsSUFBaEIsRUFBc0I7QUFDbEIsUUFBSUMsVUFBVSxHQUFHLElBQWpCO0FBQ0EsV0FBTyxJQUFJQSxVQUFKLENBQWVELElBQWYsQ0FBUDtBQUNIOztBQU1ELFNBQU9FLHNCQUFQLENBQThCRixJQUE5QixFQUFvQztBQUNoQyxXQUFPeEIsQ0FBQyxDQUFDMkIsSUFBRixDQUFPLEtBQUtOLElBQUwsQ0FBVU8sVUFBakIsRUFBNkJDLE1BQU0sSUFBSTdCLENBQUMsQ0FBQzhCLEtBQUYsQ0FBUUQsTUFBUixFQUFnQkUsQ0FBQyxJQUFJLENBQUMvQixDQUFDLENBQUNnQyxLQUFGLENBQVFSLElBQUksQ0FBQ08sQ0FBRCxDQUFaLENBQXRCLENBQXZDLENBQVA7QUFDSDs7QUFNRCxTQUFPRSwwQkFBUCxDQUFrQ1QsSUFBbEMsRUFBd0M7QUFBQSxTQUMvQnhCLENBQUMsQ0FBQ2tDLGFBQUYsQ0FBZ0JWLElBQWhCLENBRCtCO0FBQUE7QUFBQTs7QUFHcEMsUUFBSVcsUUFBUSxHQUFHLEtBQUtULHNCQUFMLENBQTRCRixJQUE1QixDQUFmO0FBQ0EsV0FBT3hCLENBQUMsQ0FBQ21CLElBQUYsQ0FBT0ssSUFBUCxFQUFhVyxRQUFiLENBQVA7QUFDSDs7QUFrQkQsZUFBYUMsUUFBYixDQUFzQkMsV0FBdEIsRUFBbUNDLFdBQW5DLEVBQWdEO0FBQUEsU0FDdkNELFdBRHVDO0FBQUE7QUFBQTs7QUFHNUNBLElBQUFBLFdBQVcsR0FBRyxLQUFLRSxlQUFMLENBQXFCRixXQUFyQixFQUFrQyxJQUFsQyxDQUFkO0FBRUEsUUFBSUcsT0FBTyxHQUFHO0FBQ1ZILE1BQUFBLFdBRFU7QUFFVkMsTUFBQUE7QUFGVSxLQUFkO0FBS0EsVUFBTTdCLFFBQVEsQ0FBQ2dDLFdBQVQsQ0FBcUIvQixLQUFLLENBQUNnQyxnQkFBM0IsRUFBNkMsSUFBN0MsRUFBbURGLE9BQW5ELENBQU47O0FBRUEsUUFBSUgsV0FBVyxDQUFDTSxZQUFoQixFQUE4QjtBQUMxQk4sTUFBQUEsV0FBVyxDQUFDTSxZQUFaLEdBQTJCLEtBQUtDLG9CQUFMLENBQTBCUCxXQUExQixDQUEzQjtBQUNIOztBQUVELFdBQU8sS0FBS1EsYUFBTCxDQUFtQixNQUFPTCxPQUFQLElBQW1CO0FBQ3pDLFVBQUlNLE9BQU8sR0FBRyxNQUFNLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsS0FBbEIsQ0FDaEIsS0FBSzVCLElBQUwsQ0FBVTZCLElBRE0sRUFFaEJWLE9BQU8sQ0FBQ0gsV0FGUSxFQUdoQkcsT0FBTyxDQUFDRixXQUhRLENBQXBCO0FBS0EsVUFBSSxDQUFDUSxPQUFMLEVBQWMsTUFBTSxJQUFJdkMsZ0JBQUosQ0FBcUIsa0RBQXJCLENBQU47O0FBRWQsVUFBSThCLFdBQVcsQ0FBQ00sWUFBWixJQUE0QixDQUFDTixXQUFXLENBQUNjLFFBQTdDLEVBQXVEO0FBRW5ELFlBQUlMLE9BQU8sQ0FBQyxDQUFELENBQVAsQ0FBV00sTUFBWCxLQUFzQixDQUExQixFQUE2QixPQUFPQyxTQUFQO0FBRTdCUCxRQUFBQSxPQUFPLEdBQUcsS0FBS1Esb0JBQUwsQ0FBMEJSLE9BQTFCLEVBQW1DVCxXQUFXLENBQUNNLFlBQS9DLENBQVY7QUFDSCxPQUxELE1BS08sSUFBSUcsT0FBTyxDQUFDTSxNQUFSLEtBQW1CLENBQXZCLEVBQTBCO0FBQzdCLGVBQU9DLFNBQVA7QUFDSDs7QUFmd0MsWUFpQmpDUCxPQUFPLENBQUNNLE1BQVIsS0FBbUIsQ0FqQmM7QUFBQTtBQUFBOztBQWtCekMsVUFBSUcsTUFBTSxHQUFHVCxPQUFPLENBQUMsQ0FBRCxDQUFwQjtBQUVBLGFBQU9TLE1BQVA7QUFDSCxLQXJCTSxFQXFCSmYsT0FyQkksQ0FBUDtBQXNCSDs7QUFrQkQsZUFBYWdCLFFBQWIsQ0FBc0JuQixXQUF0QixFQUFtQ0MsV0FBbkMsRUFBZ0Q7QUFDNUNELElBQUFBLFdBQVcsR0FBRyxLQUFLRSxlQUFMLENBQXFCRixXQUFyQixDQUFkO0FBRUEsUUFBSUcsT0FBTyxHQUFHO0FBQ1ZILE1BQUFBLFdBRFU7QUFFVkMsTUFBQUE7QUFGVSxLQUFkO0FBS0EsVUFBTTdCLFFBQVEsQ0FBQ2dDLFdBQVQsQ0FBcUIvQixLQUFLLENBQUNnQyxnQkFBM0IsRUFBNkMsSUFBN0MsRUFBbURGLE9BQW5ELENBQU47O0FBRUEsUUFBSUgsV0FBVyxDQUFDTSxZQUFoQixFQUE4QjtBQUMxQk4sTUFBQUEsV0FBVyxDQUFDTSxZQUFaLEdBQTJCLEtBQUtDLG9CQUFMLENBQTBCUCxXQUExQixDQUEzQjtBQUNIOztBQUVELFFBQUlvQixVQUFKO0FBRUEsUUFBSUMsSUFBSSxHQUFHLE1BQU0sS0FBS2IsYUFBTCxDQUFtQixNQUFPTCxPQUFQLElBQW1CO0FBQ25ELFVBQUlNLE9BQU8sR0FBRyxNQUFNLEtBQUtDLEVBQUwsQ0FBUUMsU0FBUixDQUFrQkMsS0FBbEIsQ0FDaEIsS0FBSzVCLElBQUwsQ0FBVTZCLElBRE0sRUFFaEJWLE9BQU8sQ0FBQ0gsV0FGUSxFQUdoQkcsT0FBTyxDQUFDRixXQUhRLENBQXBCO0FBTUEsVUFBSSxDQUFDUSxPQUFMLEVBQWMsTUFBTSxJQUFJdkMsZ0JBQUosQ0FBcUIsa0RBQXJCLENBQU47O0FBRWQsVUFBSThCLFdBQVcsQ0FBQ00sWUFBWixJQUE0QixDQUFDTixXQUFXLENBQUNjLFFBQTdDLEVBQXVEO0FBQ25ELFlBQUlkLFdBQVcsQ0FBQ3NCLFdBQWhCLEVBQTZCO0FBQ3pCRixVQUFBQSxVQUFVLEdBQUdYLE9BQU8sQ0FBQyxDQUFELENBQXBCO0FBQ0g7O0FBQ0RBLFFBQUFBLE9BQU8sR0FBRyxLQUFLUSxvQkFBTCxDQUEwQlIsT0FBMUIsRUFBbUNULFdBQVcsQ0FBQ00sWUFBL0MsQ0FBVjtBQUNILE9BTEQsTUFLTztBQUNILFlBQUlOLFdBQVcsQ0FBQ3NCLFdBQWhCLEVBQTZCO0FBQ3pCRixVQUFBQSxVQUFVLEdBQUdYLE9BQU8sQ0FBQyxDQUFELENBQXBCO0FBQ0FBLFVBQUFBLE9BQU8sR0FBR0EsT0FBTyxDQUFDLENBQUQsQ0FBakI7QUFDSDtBQUNKOztBQUVELGFBQU8sS0FBS2MsYUFBTCxDQUFtQnBCLE9BQW5CLEVBQTRCTSxPQUE1QixDQUFQO0FBQ0gsS0F0QmdCLEVBc0JkTixPQXRCYyxDQUFqQjs7QUF3QkEsUUFBSUgsV0FBVyxDQUFDc0IsV0FBaEIsRUFBNkI7QUFDekIsYUFBTztBQUFFRSxRQUFBQSxVQUFVLEVBQUVKLFVBQWQ7QUFBMEJLLFFBQUFBLEtBQUssRUFBRUo7QUFBakMsT0FBUDtBQUNIOztBQUVELFdBQU9BLElBQVA7QUFDSDs7QUFXRCxlQUFhSyxPQUFiLENBQXFCdkMsSUFBckIsRUFBMkJ3QyxhQUEzQixFQUEwQzFCLFdBQTFDLEVBQXVEO0FBQ25EMEIsSUFBQUEsYUFBYSxLQUFLQSxhQUFhLEdBQUcsRUFBckIsQ0FBYjs7QUFFQSxRQUFJLENBQUVDLEdBQUYsRUFBT0MsWUFBUCxJQUF3QixLQUFLQyxvQkFBTCxDQUEwQjNDLElBQTFCLENBQTVCOztBQUVBLFFBQUlnQixPQUFPLEdBQUc7QUFDVnlCLE1BQUFBLEdBRFU7QUFFVkQsTUFBQUEsYUFGVTtBQUdWMUIsTUFBQUE7QUFIVSxLQUFkO0FBTUEsUUFBSThCLGdCQUFnQixHQUFHLEtBQXZCOztBQUVBLFFBQUksQ0FBQ3BFLENBQUMsQ0FBQ3FFLE9BQUYsQ0FBVUgsWUFBVixDQUFMLEVBQThCO0FBQzFCRSxNQUFBQSxnQkFBZ0IsR0FBRyxJQUFuQjtBQUNIOztBQUVELFdBQU8sS0FBS3ZCLGFBQUwsQ0FBbUIsTUFBT0wsT0FBUCxJQUFtQjtBQUN6QyxVQUFJNEIsZ0JBQUosRUFBc0I7QUFDbEIsWUFBSSxDQUFDNUIsT0FBTyxDQUFDRixXQUFULElBQXdCLENBQUNFLE9BQU8sQ0FBQ0YsV0FBUixDQUFvQmdDLFVBQWpELEVBQTZEO0FBQ3pEOUIsVUFBQUEsT0FBTyxDQUFDRixXQUFSLEtBQXdCRSxPQUFPLENBQUNGLFdBQVIsR0FBc0IsRUFBOUM7QUFFQUUsVUFBQUEsT0FBTyxDQUFDRixXQUFSLENBQW9CZ0MsVUFBcEIsR0FBaUMsTUFBTSxLQUFLdkIsRUFBTCxDQUFRQyxTQUFSLENBQWtCdUIsaUJBQWxCLEVBQXZDO0FBQ0g7QUFDSjs7QUFFRCxZQUFNLEtBQUtDLG1CQUFMLENBQXlCaEMsT0FBekIsQ0FBTjtBQUVBLFlBQU0vQixRQUFRLENBQUNnQyxXQUFULENBQXFCL0IsS0FBSyxDQUFDK0Qsa0JBQTNCLEVBQStDLElBQS9DLEVBQXFEakMsT0FBckQsQ0FBTjtBQUVBQSxNQUFBQSxPQUFPLENBQUNlLE1BQVIsR0FBaUIsTUFBTSxLQUFLUixFQUFMLENBQVFDLFNBQVIsQ0FBa0JlLE9BQWxCLENBQ25CLEtBQUsxQyxJQUFMLENBQVU2QixJQURTLEVBRW5CVixPQUFPLENBQUNrQyxNQUZXLEVBR25CbEMsT0FBTyxDQUFDRixXQUhXLENBQXZCO0FBTUEsWUFBTSxLQUFLcUMsWUFBTCxDQUFrQm5DLE9BQWxCLENBQU47O0FBRUEsVUFBSTRCLGdCQUFKLEVBQXNCO0FBQ2xCLGNBQU0sS0FBS1EsY0FBTCxDQUFvQnBDLE9BQXBCLEVBQTZCMEIsWUFBN0IsQ0FBTjtBQUNIOztBQUVELGFBQU8xQixPQUFPLENBQUNrQyxNQUFmO0FBQ0gsS0ExQk0sRUEwQkpsQyxPQTFCSSxDQUFQO0FBMkJIOztBQVlELGVBQWFxQyxPQUFiLENBQXFCckQsSUFBckIsRUFBMkJzRCxhQUEzQixFQUEwQ3hDLFdBQTFDLEVBQXVEO0FBQ25ELFFBQUl3QyxhQUFhLElBQUlBLGFBQWEsQ0FBQ0MsZUFBbkMsRUFBb0Q7QUFDaEQsWUFBTSxJQUFJekUsZ0JBQUosQ0FBcUIsbUJBQXJCLEVBQTBDO0FBQzVDMEUsUUFBQUEsTUFBTSxFQUFFLEtBQUszRCxJQUFMLENBQVU2QixJQUQwQjtBQUU1QytCLFFBQUFBLE1BQU0sRUFBRSwyRUFGb0M7QUFHNUNILFFBQUFBO0FBSDRDLE9BQTFDLENBQU47QUFLSDs7QUFFRCxXQUFPLEtBQUtJLFFBQUwsQ0FBYzFELElBQWQsRUFBb0JzRCxhQUFwQixFQUFtQ3hDLFdBQW5DLENBQVA7QUFDSDs7QUFRRCxlQUFhNkMsV0FBYixDQUF5QjNELElBQXpCLEVBQStCc0QsYUFBL0IsRUFBOEN4QyxXQUE5QyxFQUEyRDtBQUN2RCxRQUFJd0MsYUFBYSxJQUFJQSxhQUFhLENBQUNDLGVBQW5DLEVBQW9EO0FBQ2hELFlBQU0sSUFBSXpFLGdCQUFKLENBQXFCLG1CQUFyQixFQUEwQztBQUM1QzBFLFFBQUFBLE1BQU0sRUFBRSxLQUFLM0QsSUFBTCxDQUFVNkIsSUFEMEI7QUFFNUMrQixRQUFBQSxNQUFNLEVBQUUsMkVBRm9DO0FBRzVDSCxRQUFBQTtBQUg0QyxPQUExQyxDQUFOO0FBS0g7O0FBRUQsV0FBTyxLQUFLSSxRQUFMLENBQWMxRCxJQUFkLEVBQW9Cc0QsYUFBcEIsRUFBbUN4QyxXQUFuQyxFQUFnRCxLQUFoRCxDQUFQO0FBQ0g7O0FBRUQsZUFBYTRDLFFBQWIsQ0FBc0IxRCxJQUF0QixFQUE0QnNELGFBQTVCLEVBQTJDeEMsV0FBM0MsRUFBd0Q4QyxlQUF4RCxFQUF5RTtBQUNyRSxRQUFJLENBQUNOLGFBQUwsRUFBb0I7QUFDaEIsVUFBSU8sZUFBZSxHQUFHLEtBQUszRCxzQkFBTCxDQUE0QkYsSUFBNUIsQ0FBdEI7O0FBQ0EsVUFBSXhCLENBQUMsQ0FBQ3FFLE9BQUYsQ0FBVWdCLGVBQVYsQ0FBSixFQUFnQztBQUM1QixjQUFNLElBQUkvRSxnQkFBSixDQUFxQix1R0FBckIsQ0FBTjtBQUNIOztBQUNEd0UsTUFBQUEsYUFBYSxHQUFHO0FBQUVRLFFBQUFBLE1BQU0sRUFBRXRGLENBQUMsQ0FBQ21CLElBQUYsQ0FBT0ssSUFBUCxFQUFhNkQsZUFBYjtBQUFWLE9BQWhCO0FBQ0E3RCxNQUFBQSxJQUFJLEdBQUd4QixDQUFDLENBQUN1RixJQUFGLENBQU8vRCxJQUFQLEVBQWE2RCxlQUFiLENBQVA7QUFDSDs7QUFFRFAsSUFBQUEsYUFBYSxHQUFHLEtBQUt2QyxlQUFMLENBQXFCdUMsYUFBckIsRUFBb0NNLGVBQXBDLENBQWhCO0FBRUEsUUFBSTVDLE9BQU8sR0FBRztBQUNWeUIsTUFBQUEsR0FBRyxFQUFFekMsSUFESztBQUVWc0QsTUFBQUEsYUFGVTtBQUdWeEMsTUFBQUE7QUFIVSxLQUFkO0FBTUEsV0FBTyxLQUFLTyxhQUFMLENBQW1CLE1BQU9MLE9BQVAsSUFBbUI7QUFDekMsWUFBTSxLQUFLZ0MsbUJBQUwsQ0FBeUJoQyxPQUF6QixFQUFrQyxJQUFsQyxDQUFOO0FBRUEsWUFBTS9CLFFBQVEsQ0FBQ2dDLFdBQVQsQ0FBcUIvQixLQUFLLENBQUM4RSxrQkFBM0IsRUFBK0MsSUFBL0MsRUFBcURoRCxPQUFyRCxDQUFOO0FBRUFBLE1BQUFBLE9BQU8sQ0FBQ2UsTUFBUixHQUFpQixNQUFNLEtBQUtSLEVBQUwsQ0FBUUMsU0FBUixDQUFrQjZCLE9BQWxCLENBQ25CLEtBQUt4RCxJQUFMLENBQVU2QixJQURTLEVBRW5CVixPQUFPLENBQUNrQyxNQUZXLEVBR25CbEMsT0FBTyxDQUFDc0MsYUFBUixDQUFzQlEsTUFISCxFQUluQjlDLE9BQU8sQ0FBQ0YsV0FKVyxDQUF2QjtBQU9BLFlBQU0sS0FBS21ELFlBQUwsQ0FBa0JqRCxPQUFsQixDQUFOO0FBRUEsYUFBT0EsT0FBTyxDQUFDa0MsTUFBZjtBQUNILEtBZk0sRUFlSmxDLE9BZkksQ0FBUDtBQWdCSDs7QUFXRCxlQUFha0QsT0FBYixDQUFxQkMsYUFBckIsRUFBb0NyRCxXQUFwQyxFQUFpRDtBQUM3QyxXQUFPLEtBQUtzRCxRQUFMLENBQWNELGFBQWQsRUFBNkJyRCxXQUE3QixFQUEwQyxJQUExQyxDQUFQO0FBQ0g7O0FBV0QsZUFBYXVELFdBQWIsQ0FBeUJGLGFBQXpCLEVBQXdDckQsV0FBeEMsRUFBcUQ7QUFDakQsV0FBTyxLQUFLc0QsUUFBTCxDQUFjRCxhQUFkLEVBQTZCckQsV0FBN0IsRUFBMEMsS0FBMUMsQ0FBUDtBQUNIOztBQVdELGVBQWFzRCxRQUFiLENBQXNCRCxhQUF0QixFQUFxQ3JELFdBQXJDLEVBQWtEOEMsZUFBbEQsRUFBbUU7QUFBQSxTQUMxRE8sYUFEMEQ7QUFBQTtBQUFBOztBQUcvREEsSUFBQUEsYUFBYSxHQUFHLEtBQUtwRCxlQUFMLENBQXFCb0QsYUFBckIsRUFBb0NQLGVBQXBDLENBQWhCOztBQUVBLFFBQUlwRixDQUFDLENBQUNxRSxPQUFGLENBQVVzQixhQUFhLENBQUNMLE1BQXhCLENBQUosRUFBcUM7QUFDakMsWUFBTSxJQUFJaEYsZ0JBQUosQ0FBcUIsd0RBQXJCLENBQU47QUFDSDs7QUFFRCxRQUFJa0MsT0FBTyxHQUFHO0FBQ1ZtRCxNQUFBQSxhQURVO0FBRVZyRCxNQUFBQTtBQUZVLEtBQWQ7QUFLQSxRQUFJd0QsV0FBVyxHQUFHLE1BQU1yRixRQUFRLENBQUNnQyxXQUFULENBQXFCL0IsS0FBSyxDQUFDcUYsa0JBQTNCLEVBQStDLElBQS9DLEVBQXFEdkQsT0FBckQsQ0FBeEI7O0FBQ0EsUUFBSSxDQUFDc0QsV0FBTCxFQUFrQjtBQUNkLGFBQU90RCxPQUFPLENBQUNrQyxNQUFmO0FBQ0g7O0FBRUQsV0FBTyxLQUFLN0IsYUFBTCxDQUFtQixNQUFPTCxPQUFQLElBQW1CO0FBQ3pDLFlBQU0sS0FBS3dELGFBQUwsQ0FBbUJ4RCxPQUFuQixDQUFOO0FBRUFBLE1BQUFBLE9BQU8sQ0FBQ2UsTUFBUixHQUFpQixNQUFNLEtBQUtSLEVBQUwsQ0FBUUMsU0FBUixDQUFrQjBDLE9BQWxCLENBQ25CLEtBQUtyRSxJQUFMLENBQVU2QixJQURTLEVBRW5CVixPQUFPLENBQUNtRCxhQUFSLENBQXNCTCxNQUZILEVBR25COUMsT0FBTyxDQUFDRixXQUhXLENBQXZCO0FBTUEsYUFBT0UsT0FBTyxDQUFDeUQsUUFBZjtBQUNILEtBVk0sRUFVSnpELE9BVkksQ0FBUDtBQVdIOztBQU1ELFNBQU8wRCxrQkFBUCxDQUEwQjFFLElBQTFCLEVBQWdDO0FBQzVCLFdBQU94QixDQUFDLENBQUMyQixJQUFGLENBQU8sS0FBS04sSUFBTCxDQUFVTyxVQUFqQixFQUE2QkMsTUFBTSxJQUFJN0IsQ0FBQyxDQUFDOEIsS0FBRixDQUFRRCxNQUFSLEVBQWdCRSxDQUFDLElBQUksQ0FBQy9CLENBQUMsQ0FBQ2dDLEtBQUYsQ0FBUVIsSUFBSSxDQUFDTyxDQUFELENBQVosQ0FBdEIsQ0FBdkMsQ0FBUDtBQUNIOztBQU1ELFNBQU9vRSx3QkFBUCxDQUFnQ0MsU0FBaEMsRUFBMkM7QUFDdkMsUUFBSUMsaUJBQWlCLEdBQUcsS0FBS0gsa0JBQUwsQ0FBd0JFLFNBQXhCLENBQXhCOztBQUVBLFFBQUksQ0FBQ0MsaUJBQUwsRUFBd0I7QUFDcEIsWUFBTSxJQUFJL0YsZ0JBQUosQ0FBcUIsbUJBQXJCLEVBQTBDO0FBQ3hDMEUsUUFBQUEsTUFBTSxFQUFFLEtBQUszRCxJQUFMLENBQVU2QixJQURzQjtBQUV4QytCLFFBQUFBLE1BQU0sRUFBRSx5RUFGZ0M7QUFHeENtQixRQUFBQTtBQUh3QyxPQUExQyxDQUFOO0FBTUg7QUFDSjs7QUFTRCxlQUFhNUIsbUJBQWIsQ0FBaUNoQyxPQUFqQyxFQUEwQzhELFVBQVUsR0FBRyxLQUF2RCxFQUE4RDtBQUMxRCxRQUFJakYsSUFBSSxHQUFHLEtBQUtBLElBQWhCO0FBQ0EsUUFBSWtGLElBQUksR0FBRyxLQUFLQSxJQUFoQjtBQUNBLFFBQUk7QUFBRXJELE1BQUFBLElBQUY7QUFBUXJCLE1BQUFBO0FBQVIsUUFBbUJSLElBQXZCO0FBRUEsUUFBSTtBQUFFNEMsTUFBQUE7QUFBRixRQUFVekIsT0FBZDtBQUNBLFFBQUlrQyxNQUFNLEdBQUcsRUFBYjtBQUFBLFFBQWlCdUIsUUFBakI7QUFDQXpELElBQUFBLE9BQU8sQ0FBQ2tDLE1BQVIsR0FBaUJBLE1BQWpCOztBQUVBLFFBQUksQ0FBQ2xDLE9BQU8sQ0FBQytELElBQWIsRUFBbUI7QUFDZi9ELE1BQUFBLE9BQU8sQ0FBQytELElBQVIsR0FBZUEsSUFBZjtBQUNIOztBQUVELFFBQUlDLFNBQVMsR0FBR0YsVUFBVSxHQUFHOUQsT0FBTyxDQUFDc0MsYUFBWCxHQUEyQnRDLE9BQU8sQ0FBQ3dCLGFBQTdEOztBQUVBLFFBQUlzQyxVQUFVLElBQUksS0FBS0csc0JBQUwsQ0FBNEJ4QyxHQUE1QixDQUFsQixFQUFvRDtBQUNoRCxVQUFJLENBQUN6QixPQUFPLENBQUNGLFdBQVQsSUFBd0IsQ0FBQ0UsT0FBTyxDQUFDRixXQUFSLENBQW9CZ0MsVUFBakQsRUFBNkQ7QUFDekQ5QixRQUFBQSxPQUFPLENBQUNGLFdBQVIsS0FBd0JFLE9BQU8sQ0FBQ0YsV0FBUixHQUFzQixFQUE5QztBQUVBRSxRQUFBQSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JnQyxVQUFwQixHQUFpQyxNQUFNLEtBQUt2QixFQUFMLENBQVFDLFNBQVIsQ0FBa0J1QixpQkFBbEIsRUFBdkM7QUFDSDs7QUFFRDBCLE1BQUFBLFFBQVEsR0FBRyxNQUFNLEtBQUs3RCxRQUFMLENBQWM7QUFBRWtELFFBQUFBLE1BQU0sRUFBRWtCLFNBQVMsQ0FBQ2xCO0FBQXBCLE9BQWQsRUFBNEM5QyxPQUFPLENBQUNGLFdBQXBELENBQWpCO0FBQ0FFLE1BQUFBLE9BQU8sQ0FBQ3lELFFBQVIsR0FBbUJBLFFBQW5CO0FBQ0g7O0FBRUQsVUFBTWhHLFVBQVUsQ0FBQzRCLE1BQUQsRUFBUyxPQUFPNkUsU0FBUCxFQUFrQkMsU0FBbEIsS0FBZ0M7QUFDckQsVUFBSUEsU0FBUyxJQUFJMUMsR0FBakIsRUFBc0I7QUFFbEIsWUFBSXlDLFNBQVMsQ0FBQ0UsUUFBZCxFQUF3QjtBQUNwQixjQUFJLENBQUNOLFVBQUQsSUFBZSxDQUFDRSxTQUFTLENBQUN6QixlQUFWLENBQTBCOEIsR0FBMUIsQ0FBOEJGLFNBQTlCLENBQXBCLEVBQThEO0FBRTFELGtCQUFNLElBQUl0RyxtQkFBSixDQUF5QixvQkFBbUJzRyxTQUFVLDZDQUF0RCxFQUFvRztBQUN0RzNCLGNBQUFBLE1BQU0sRUFBRTlCLElBRDhGO0FBRXRHd0QsY0FBQUEsU0FBUyxFQUFFQTtBQUYyRixhQUFwRyxDQUFOO0FBSUg7QUFDSjs7QUFFRCxZQUFJSixVQUFVLElBQUlJLFNBQVMsQ0FBQ0kscUJBQTVCLEVBQW1EO0FBQUEsZUFDdkNiLFFBRHVDO0FBQUEsNEJBQzdCLDJEQUQ2QjtBQUFBOztBQUcvQyxjQUFJQSxRQUFRLENBQUNVLFNBQUQsQ0FBUixLQUF3QkQsU0FBUyxDQUFDSyxPQUF0QyxFQUErQztBQUUzQyxrQkFBTSxJQUFJMUcsbUJBQUosQ0FBeUIsZ0NBQStCc0csU0FBVSxpQ0FBbEUsRUFBb0c7QUFDdEczQixjQUFBQSxNQUFNLEVBQUU5QixJQUQ4RjtBQUV0R3dELGNBQUFBLFNBQVMsRUFBRUE7QUFGMkYsYUFBcEcsQ0FBTjtBQUlIO0FBQ0o7O0FBY0QsWUFBSS9GLFNBQVMsQ0FBQ3NELEdBQUcsQ0FBQzBDLFNBQUQsQ0FBSixDQUFiLEVBQStCO0FBQzNCLGNBQUksQ0FBQ0QsU0FBUyxDQUFDTSxRQUFmLEVBQXlCO0FBQ3JCLGtCQUFNLElBQUkzRyxtQkFBSixDQUF5QixRQUFPc0csU0FBVSxlQUFjekQsSUFBSywwQkFBN0QsRUFBd0Y7QUFDMUY4QixjQUFBQSxNQUFNLEVBQUU5QixJQURrRjtBQUUxRndELGNBQUFBLFNBQVMsRUFBRUE7QUFGK0UsYUFBeEYsQ0FBTjtBQUlIOztBQUVEaEMsVUFBQUEsTUFBTSxDQUFDaUMsU0FBRCxDQUFOLEdBQW9CLElBQXBCO0FBQ0gsU0FURCxNQVNPO0FBQ0gsY0FBSTtBQUNBakMsWUFBQUEsTUFBTSxDQUFDaUMsU0FBRCxDQUFOLEdBQW9CdkcsS0FBSyxDQUFDNkcsUUFBTixDQUFlaEQsR0FBRyxDQUFDMEMsU0FBRCxDQUFsQixFQUErQkQsU0FBL0IsRUFBMENILElBQTFDLENBQXBCO0FBQ0gsV0FGRCxDQUVFLE9BQU9XLEtBQVAsRUFBYztBQUNaLGtCQUFNLElBQUk3RyxtQkFBSixDQUF5QixZQUFXc0csU0FBVSxlQUFjekQsSUFBSyxXQUFqRSxFQUE2RTtBQUMvRThCLGNBQUFBLE1BQU0sRUFBRTlCLElBRHVFO0FBRS9Fd0QsY0FBQUEsU0FBUyxFQUFFQSxTQUZvRTtBQUcvRVEsY0FBQUEsS0FBSyxFQUFFQSxLQUFLLENBQUNDLE9BQU4sSUFBaUJELEtBQUssQ0FBQ0U7QUFIaUQsYUFBN0UsQ0FBTjtBQUtIO0FBQ0o7O0FBRUQ7QUFDSDs7QUFHRCxVQUFJZCxVQUFKLEVBQWdCO0FBQ1osWUFBSUksU0FBUyxDQUFDVyxXQUFkLEVBQTJCO0FBRXZCLGNBQUlYLFNBQVMsQ0FBQ1ksVUFBZCxFQUEwQjtBQUN0QjtBQUNIOztBQUdELGNBQUlaLFNBQVMsQ0FBQ2EsSUFBZCxFQUFvQjtBQUNoQjdDLFlBQUFBLE1BQU0sQ0FBQ2lDLFNBQUQsQ0FBTixHQUFvQixNQUFNeEcsVUFBVSxDQUFDNEcsT0FBWCxDQUFtQkwsU0FBbkIsRUFBOEJILElBQTlCLENBQTFCO0FBQ0E7QUFDSDs7QUFFRCxnQkFBTSxJQUFJbEcsbUJBQUosQ0FDRCxJQUFHc0csU0FBVSxTQUFRekQsSUFBSyx1Q0FEekIsRUFDaUU7QUFDL0Q4QixZQUFBQSxNQUFNLEVBQUU5QixJQUR1RDtBQUUvRHdELFlBQUFBLFNBQVMsRUFBRUE7QUFGb0QsV0FEakUsQ0FBTjtBQU1IOztBQUVEO0FBQ0g7O0FBR0QsVUFBSSxDQUFDQSxTQUFTLENBQUNjLFVBQWYsRUFBMkI7QUFDdkIsWUFBSWQsU0FBUyxDQUFDZSxjQUFWLENBQXlCLFNBQXpCLENBQUosRUFBeUM7QUFFckMvQyxVQUFBQSxNQUFNLENBQUNpQyxTQUFELENBQU4sR0FBb0JELFNBQVMsQ0FBQ0ssT0FBOUI7QUFFSCxTQUpELE1BSU8sSUFBSUwsU0FBUyxDQUFDTSxRQUFkLEVBQXdCO0FBQzNCO0FBQ0gsU0FGTSxNQUVBLElBQUlOLFNBQVMsQ0FBQ2EsSUFBZCxFQUFvQjtBQUV2QjdDLFVBQUFBLE1BQU0sQ0FBQ2lDLFNBQUQsQ0FBTixHQUFvQixNQUFNeEcsVUFBVSxDQUFDNEcsT0FBWCxDQUFtQkwsU0FBbkIsRUFBOEJILElBQTlCLENBQTFCO0FBRUgsU0FKTSxNQUlBO0FBRUgsZ0JBQU0sSUFBSWxHLG1CQUFKLENBQXlCLElBQUdzRyxTQUFVLFNBQVF6RCxJQUFLLHVCQUFuRCxFQUEyRTtBQUM3RThCLFlBQUFBLE1BQU0sRUFBRTlCLElBRHFFO0FBRTdFd0QsWUFBQUEsU0FBUyxFQUFFQTtBQUZrRSxXQUEzRSxDQUFOO0FBSUg7QUFDSjtBQUNKLEtBMUdlLENBQWhCO0FBNEdBLFVBQU1qRyxRQUFRLENBQUNnQyxXQUFULENBQXFCL0IsS0FBSyxDQUFDZ0gscUJBQTNCLEVBQWtELElBQWxELEVBQXdEbEYsT0FBeEQsQ0FBTjtBQUVBLFVBQU0sS0FBS21GLGVBQUwsQ0FBcUJuRixPQUFyQixFQUE4QjhELFVBQTlCLENBQU47QUFFQTlELElBQUFBLE9BQU8sQ0FBQ2tDLE1BQVIsR0FBaUIsS0FBS2tELGNBQUwsQ0FBb0JsRCxNQUFwQixFQUE0QjhCLFNBQVMsQ0FBQ3FCLFVBQXRDLENBQWpCO0FBRUEsV0FBT3JGLE9BQVA7QUFDSDs7QUFFRCxlQUFhSyxhQUFiLENBQTJCaUYsUUFBM0IsRUFBcUN0RixPQUFyQyxFQUE4QztBQUMxQ3NGLElBQUFBLFFBQVEsR0FBR0EsUUFBUSxDQUFDQyxJQUFULENBQWMsSUFBZCxDQUFYOztBQUVBLFFBQUl2RixPQUFPLENBQUNGLFdBQVIsSUFBdUJFLE9BQU8sQ0FBQ0YsV0FBUixDQUFvQmdDLFVBQS9DLEVBQTJEO0FBQ3RELGFBQU93RCxRQUFRLENBQUN0RixPQUFELENBQWY7QUFDSjs7QUFFRCxRQUFJO0FBQ0EsVUFBSWUsTUFBTSxHQUFHLE1BQU11RSxRQUFRLENBQUN0RixPQUFELENBQTNCO0FBR0FBLE1BQUFBLE9BQU8sQ0FBQ0YsV0FBUixJQUNJRSxPQUFPLENBQUNGLFdBQVIsQ0FBb0JnQyxVQUR4QixLQUVJLE1BQU0sS0FBS3ZCLEVBQUwsQ0FBUUMsU0FBUixDQUFrQmdGLE9BQWxCLENBQTBCeEYsT0FBTyxDQUFDRixXQUFSLENBQW9CZ0MsVUFBOUMsQ0FGVjtBQUlBLGFBQU9mLE1BQVA7QUFDSCxLQVRELENBU0UsT0FBTzJELEtBQVAsRUFBYztBQUVaMUUsTUFBQUEsT0FBTyxDQUFDRixXQUFSLElBQ0lFLE9BQU8sQ0FBQ0YsV0FBUixDQUFvQmdDLFVBRHhCLEtBRUksTUFBTSxLQUFLdkIsRUFBTCxDQUFRQyxTQUFSLENBQWtCaUYsU0FBbEIsQ0FBNEJ6RixPQUFPLENBQUNGLFdBQVIsQ0FBb0JnQyxVQUFoRCxDQUZWO0FBSUEsWUFBTTRDLEtBQU47QUFDSDtBQUNKOztBQUVELFNBQU9ULHNCQUFQLENBQThCeUIsS0FBOUIsRUFBcUM7QUFFakMsUUFBSUMsSUFBSSxHQUFHLEtBQUs5RyxJQUFMLENBQVUrRyxpQkFBckI7QUFDQSxRQUFJQyxVQUFVLEdBQUcsS0FBakI7O0FBRUEsUUFBSUYsSUFBSixFQUFVO0FBQ05FLE1BQUFBLFVBQVUsR0FBR3JJLENBQUMsQ0FBQzJCLElBQUYsQ0FBT3dHLElBQVAsRUFBYSxDQUFDRyxHQUFELEVBQU0zQixTQUFOLEtBQW9CO0FBQzFDLFlBQUlBLFNBQVMsSUFBSXVCLEtBQWpCLEVBQXdCO0FBQ3BCLGlCQUFPbEksQ0FBQyxDQUFDMkIsSUFBRixDQUFPMkcsR0FBUCxFQUFZQyxDQUFDLElBQUk7QUFDcEIsZ0JBQUksQ0FBRUMsS0FBRixFQUFTQyxLQUFULElBQW1CRixDQUFDLENBQUNHLEtBQUYsQ0FBUSxHQUFSLENBQXZCO0FBQ0EsbUJBQU8sQ0FBQ0YsS0FBSyxLQUFLLFFBQVYsSUFBc0JBLEtBQUssS0FBSyxTQUFqQyxLQUErQ3hJLENBQUMsQ0FBQ2dDLEtBQUYsQ0FBUWtHLEtBQUssQ0FBQ08sS0FBRCxDQUFiLENBQXREO0FBQ0gsV0FITSxDQUFQO0FBSUg7O0FBRUQsZUFBTyxLQUFQO0FBQ0gsT0FUWSxDQUFiOztBQVdBLFVBQUlKLFVBQUosRUFBZ0I7QUFDWixlQUFPLElBQVA7QUFDSDtBQUNKOztBQUdELFFBQUlNLGlCQUFpQixHQUFHLEtBQUt0SCxJQUFMLENBQVV1SCxRQUFWLENBQW1CRCxpQkFBM0M7O0FBQ0EsUUFBSUEsaUJBQUosRUFBdUI7QUFDbkJOLE1BQUFBLFVBQVUsR0FBR3JJLENBQUMsQ0FBQzJCLElBQUYsQ0FBT2dILGlCQUFQLEVBQTBCOUcsTUFBTSxJQUFJN0IsQ0FBQyxDQUFDMkIsSUFBRixDQUFPRSxNQUFQLEVBQWU0RyxLQUFLLElBQUtBLEtBQUssSUFBSVAsS0FBVixJQUFvQmxJLENBQUMsQ0FBQ2dDLEtBQUYsQ0FBUWtHLEtBQUssQ0FBQ08sS0FBRCxDQUFiLENBQTVDLENBQXBDLENBQWI7O0FBQ0EsVUFBSUosVUFBSixFQUFnQjtBQUNaLGVBQU8sSUFBUDtBQUNIO0FBQ0o7O0FBRUQsV0FBTyxLQUFQO0FBQ0g7O0FBRUQsU0FBT1EsZ0JBQVAsQ0FBd0JDLEdBQXhCLEVBQTZCO0FBQ3pCLFdBQU85SSxDQUFDLENBQUMyQixJQUFGLENBQU9tSCxHQUFQLEVBQVksQ0FBQ0MsQ0FBRCxFQUFJQyxDQUFKLEtBQVVBLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBUyxHQUEvQixDQUFQO0FBQ0g7O0FBRUQsU0FBT3pHLGVBQVAsQ0FBdUIwRyxPQUF2QixFQUFnQzdELGVBQWUsR0FBRyxLQUFsRCxFQUF5RDtBQUNyRCxRQUFJLENBQUNwRixDQUFDLENBQUNrQyxhQUFGLENBQWdCK0csT0FBaEIsQ0FBTCxFQUErQjtBQUMzQixVQUFJN0QsZUFBZSxJQUFJOEQsS0FBSyxDQUFDQyxPQUFOLENBQWMsS0FBSzlILElBQUwsQ0FBVUMsUUFBeEIsQ0FBdkIsRUFBMEQ7QUFDdEQsY0FBTSxJQUFJaEIsZ0JBQUosQ0FBcUIsK0ZBQXJCLENBQU47QUFDSDs7QUFFRCxhQUFPMkksT0FBTyxHQUFHO0FBQUUzRCxRQUFBQSxNQUFNLEVBQUU7QUFBRSxXQUFDLEtBQUtqRSxJQUFMLENBQVVDLFFBQVgsR0FBc0IsS0FBS3NHLGNBQUwsQ0FBb0JxQixPQUFwQjtBQUF4QjtBQUFWLE9BQUgsR0FBd0UsRUFBdEY7QUFDSDs7QUFFRCxRQUFJRyxpQkFBaUIsR0FBRyxFQUF4QjtBQUFBLFFBQTRCQyxLQUFLLEdBQUcsRUFBcEM7O0FBRUFySixJQUFBQSxDQUFDLENBQUNzSixNQUFGLENBQVNMLE9BQVQsRUFBa0IsQ0FBQ0YsQ0FBRCxFQUFJQyxDQUFKLEtBQVU7QUFDeEIsVUFBSUEsQ0FBQyxDQUFDLENBQUQsQ0FBRCxLQUFTLEdBQWIsRUFBa0I7QUFDZEksUUFBQUEsaUJBQWlCLENBQUNKLENBQUQsQ0FBakIsR0FBdUJELENBQXZCO0FBQ0gsT0FGRCxNQUVPO0FBQ0hNLFFBQUFBLEtBQUssQ0FBQ0wsQ0FBRCxDQUFMLEdBQVdELENBQVg7QUFDSDtBQUNKLEtBTkQ7O0FBUUFLLElBQUFBLGlCQUFpQixDQUFDOUQsTUFBbEIsR0FBMkIsRUFBRSxHQUFHK0QsS0FBTDtBQUFZLFNBQUdELGlCQUFpQixDQUFDOUQ7QUFBakMsS0FBM0I7O0FBRUEsUUFBSUYsZUFBSixFQUFxQjtBQUNqQixXQUFLZSx3QkFBTCxDQUE4QmlELGlCQUFpQixDQUFDOUQsTUFBaEQ7QUFDSDs7QUFFRDhELElBQUFBLGlCQUFpQixDQUFDOUQsTUFBbEIsR0FBMkIsS0FBS3NDLGNBQUwsQ0FBb0J3QixpQkFBaUIsQ0FBQzlELE1BQXRDLEVBQThDOEQsaUJBQWlCLENBQUN2QixVQUFoRSxDQUEzQjs7QUFFQSxRQUFJdUIsaUJBQWlCLENBQUNHLE9BQXRCLEVBQStCO0FBQzNCSCxNQUFBQSxpQkFBaUIsQ0FBQ0csT0FBbEIsR0FBNEIsS0FBSzNCLGNBQUwsQ0FBb0J3QixpQkFBaUIsQ0FBQ0csT0FBdEMsRUFBK0NILGlCQUFpQixDQUFDdkIsVUFBakUsQ0FBNUI7QUFDSDs7QUFFRCxRQUFJdUIsaUJBQWlCLENBQUNJLFdBQXRCLEVBQW1DO0FBQy9CSixNQUFBQSxpQkFBaUIsQ0FBQ0ksV0FBbEIsR0FBZ0MsS0FBSzVCLGNBQUwsQ0FBb0J3QixpQkFBaUIsQ0FBQ0ksV0FBdEMsRUFBbURKLGlCQUFpQixDQUFDdkIsVUFBckUsQ0FBaEM7QUFDSDs7QUFFRCxXQUFPdUIsaUJBQVA7QUFDSDs7QUFFRCxTQUFPeEcsb0JBQVAsR0FBOEI7QUFDMUIsVUFBTSxJQUFJNkcsS0FBSixDQUFVN0ksYUFBVixDQUFOO0FBQ0g7O0FBRUQsU0FBTzBDLG9CQUFQLEdBQThCO0FBQzFCLFVBQU0sSUFBSW1HLEtBQUosQ0FBVTdJLGFBQVYsQ0FBTjtBQUNIOztBQUVELFNBQU91RCxvQkFBUCxDQUE0QjNDLElBQTVCLEVBQWtDO0FBQzlCLFVBQU0sSUFBSWlJLEtBQUosQ0FBVTdJLGFBQVYsQ0FBTjtBQUNIOztBQUVELGVBQWFnRSxjQUFiLENBQTRCcEMsT0FBNUIsRUFBcUNrSCxNQUFyQyxFQUE2QztBQUN6QyxVQUFNLElBQUlELEtBQUosQ0FBVTdJLGFBQVYsQ0FBTjtBQUNIOztBQUVELFNBQU8rSSxxQkFBUCxDQUE2QnpHLElBQTdCLEVBQW1DO0FBQy9CLFVBQU0sSUFBSXVHLEtBQUosQ0FBVTdJLGFBQVYsQ0FBTjtBQUNIOztBQUVELFNBQU9nSixVQUFQLENBQWtCQyxLQUFsQixFQUF5QjtBQUNyQixVQUFNLElBQUlKLEtBQUosQ0FBVTdJLGFBQVYsQ0FBTjtBQUNIOztBQUVELFNBQU9nSCxjQUFQLENBQXNCaUMsS0FBdEIsRUFBNkJDLFNBQTdCLEVBQXdDO0FBQ3BDLFFBQUk5SixDQUFDLENBQUNrQyxhQUFGLENBQWdCMkgsS0FBaEIsQ0FBSixFQUE0QjtBQUN4QixVQUFJQSxLQUFLLENBQUNFLE9BQVYsRUFBbUI7QUFDZixZQUFJRixLQUFLLENBQUNFLE9BQU4sS0FBa0IsaUJBQXRCLEVBQXlDO0FBQ3JDLGNBQUksQ0FBQ0QsU0FBTCxFQUFnQjtBQUNaLGtCQUFNLElBQUl4SixnQkFBSixDQUFxQiw0QkFBckIsQ0FBTjtBQUNIOztBQUVELGNBQUksQ0FBQyxDQUFDd0osU0FBUyxDQUFDRSxPQUFYLElBQXNCLEVBQUVILEtBQUssQ0FBQzNHLElBQU4sSUFBZTRHLFNBQVMsQ0FBQ0UsT0FBM0IsQ0FBdkIsS0FBK0QsQ0FBQ0gsS0FBSyxDQUFDN0MsUUFBMUUsRUFBb0Y7QUFDaEYsZ0JBQUlpRCxPQUFPLEdBQUcsRUFBZDs7QUFDQSxnQkFBSUosS0FBSyxDQUFDSyxjQUFWLEVBQTBCO0FBQ3RCRCxjQUFBQSxPQUFPLENBQUNFLElBQVIsQ0FBYU4sS0FBSyxDQUFDSyxjQUFuQjtBQUNIOztBQUNELGdCQUFJTCxLQUFLLENBQUNPLGFBQVYsRUFBeUI7QUFDckJILGNBQUFBLE9BQU8sQ0FBQ0UsSUFBUixDQUFhTixLQUFLLENBQUNPLGFBQU4sSUFBdUJ0SyxRQUFRLENBQUN1SyxXQUE3QztBQUNIOztBQUVELGtCQUFNLElBQUk3SixhQUFKLENBQWtCLEdBQUd5SixPQUFyQixDQUFOO0FBQ0g7O0FBRUQsaUJBQU9ILFNBQVMsQ0FBQ0UsT0FBVixDQUFrQkgsS0FBSyxDQUFDM0csSUFBeEIsQ0FBUDtBQUNILFNBbEJELE1Ba0JPLElBQUkyRyxLQUFLLENBQUNFLE9BQU4sS0FBa0IsZUFBdEIsRUFBdUM7QUFDMUMsY0FBSSxDQUFDRCxTQUFMLEVBQWdCO0FBQ1osa0JBQU0sSUFBSXhKLGdCQUFKLENBQXFCLDRCQUFyQixDQUFOO0FBQ0g7O0FBRUQsY0FBSSxDQUFDd0osU0FBUyxDQUFDVCxLQUFYLElBQW9CLEVBQUVRLEtBQUssQ0FBQzNHLElBQU4sSUFBYzRHLFNBQVMsQ0FBQ1QsS0FBMUIsQ0FBeEIsRUFBMEQ7QUFDdEQsa0JBQU0sSUFBSS9JLGdCQUFKLENBQXNCLG9CQUFtQnVKLEtBQUssQ0FBQzNHLElBQUssK0JBQXBELENBQU47QUFDSDs7QUFFRCxpQkFBTzRHLFNBQVMsQ0FBQ1QsS0FBVixDQUFnQlEsS0FBSyxDQUFDM0csSUFBdEIsQ0FBUDtBQUNILFNBVk0sTUFVQSxJQUFJMkcsS0FBSyxDQUFDRSxPQUFOLEtBQWtCLGFBQXRCLEVBQXFDO0FBQ3hDLGlCQUFPLEtBQUtKLHFCQUFMLENBQTJCRSxLQUFLLENBQUMzRyxJQUFqQyxDQUFQO0FBQ0g7O0FBRUQsY0FBTSxJQUFJdUcsS0FBSixDQUFVLDRCQUE0QkksS0FBSyxDQUFDUyxPQUE1QyxDQUFOO0FBQ0g7O0FBRUQsYUFBT3RLLENBQUMsQ0FBQ3VLLFNBQUYsQ0FBWVYsS0FBWixFQUFvQmQsQ0FBRCxJQUFPLEtBQUtuQixjQUFMLENBQW9CbUIsQ0FBcEIsRUFBdUJlLFNBQXZCLENBQTFCLENBQVA7QUFDSDs7QUFFRCxRQUFJWixLQUFLLENBQUNDLE9BQU4sQ0FBY1UsS0FBZCxDQUFKLEVBQTBCO0FBQ3RCLGFBQU9BLEtBQUssQ0FBQ1csR0FBTixDQUFVekIsQ0FBQyxJQUFJLEtBQUtuQixjQUFMLENBQW9CbUIsQ0FBcEIsRUFBdUJlLFNBQXZCLENBQWYsQ0FBUDtBQUNIOztBQUVELFdBQU8sS0FBS0YsVUFBTCxDQUFnQkMsS0FBaEIsQ0FBUDtBQUNIOztBQXZzQmE7O0FBMHNCbEJZLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjdKLFdBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEh0dHBDb2RlID0gcmVxdWlyZSgnaHR0cC1zdGF0dXMtY29kZXMnKTtcbmNvbnN0IHsgXywgZWFjaEFzeW5jXyB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IEVycm9ycyA9IHJlcXVpcmUoJy4vRXJyb3JzJyk7XG5jb25zdCBHZW5lcmF0b3JzID0gcmVxdWlyZSgnLi9HZW5lcmF0b3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4vdHlwZXMnKTtcbmNvbnN0IHsgRGF0YVZhbGlkYXRpb25FcnJvciwgT29sb25nVXNhZ2VFcnJvciwgRHNPcGVyYXRpb25FcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gRXJyb3JzO1xuY29uc3QgRmVhdHVyZXMgPSByZXF1aXJlKCcuL2VudGl0eUZlYXR1cmVzJyk7XG5jb25zdCBSdWxlcyA9IHJlcXVpcmUoJy4uL2VudW0vUnVsZXMnKTtcblxuY29uc3QgeyBpc05vdGhpbmcgfSA9IHJlcXVpcmUoJy4uL3V0aWxzL2xhbmcnKTtcblxuY29uc3QgTkVFRF9PVkVSUklERSA9ICdTaG91bGQgYmUgb3ZlcnJpZGVkIGJ5IGRyaXZlci1zcGVjaWZpYyBzdWJjbGFzcy4nO1xuXG4vKipcbiAqIEJhc2UgZW50aXR5IG1vZGVsIGNsYXNzLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIEVudGl0eU1vZGVsIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbcmF3RGF0YV0gLSBSYXcgZGF0YSBvYmplY3QgXG4gICAgICovXG4gICAgY29uc3RydWN0b3IocmF3RGF0YSkge1xuICAgICAgICBpZiAocmF3RGF0YSkge1xuICAgICAgICAgICAgLy9vbmx5IHBpY2sgdGhvc2UgdGhhdCBhcmUgZmllbGRzIG9mIHRoaXMgZW50aXR5XG4gICAgICAgICAgICBPYmplY3QuYXNzaWduKHRoaXMsIHJhd0RhdGEpO1xuICAgICAgICB9IFxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBHZXQgYW4gb2JqZWN0IG9mIHRoZSBwcmltYXJ5IGtleSB2YWx1ZXMuXG4gICAgICovXG4gICAgZ2V0ICRwa1ZhbHVlcygpIHtcbiAgICAgICAgcmV0dXJuIF8ucGljayh0aGlzLCBfLmNhc3RBcnJheSh0aGlzLmNvbnN0cnVjdG9yLm1ldGEua2V5RmllbGQpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3B1bGF0ZSBkYXRhIGZyb20gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHsqfSBkYXRhIFxuICAgICAqIEByZXR1cm4ge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBwb3B1bGF0ZShkYXRhKSB7XG4gICAgICAgIGxldCBNb2RlbENsYXNzID0gdGhpcztcbiAgICAgICAgcmV0dXJuIG5ldyBNb2RlbENsYXNzKGRhdGEpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBmaWVsZCBuYW1lcyBhcnJheSBvZiBhIHVuaXF1ZSBrZXkgZnJvbSBpbnB1dCBkYXRhLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIC0gSW5wdXQgZGF0YS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0VW5pcXVlS2V5RmllbGRzRnJvbShkYXRhKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQodGhpcy5tZXRhLnVuaXF1ZUtleXMsIGZpZWxkcyA9PiBfLmV2ZXJ5KGZpZWxkcywgZiA9PiAhXy5pc05pbChkYXRhW2ZdKSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEdldCBrZXktdmFsdWUgcGFpcnMgb2YgYSB1bmlxdWUga2V5IGZyb20gaW5wdXQgZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIElucHV0IGRhdGEuXG4gICAgICovXG4gICAgc3RhdGljIGdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGRhdGEpIHsgIFxuICAgICAgICBwcmU6IF8uaXNQbGFpbk9iamVjdChkYXRhKTsgICAgXG4gICAgICAgIFxuICAgICAgICBsZXQgdWtGaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgIHJldHVybiBfLnBpY2soZGF0YSwgdWtGaWVsZHMpO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBGaW5kIG9uZSByZWNvcmQsIHJldHVybnMgYSBtb2RlbCBvYmplY3QgY29udGFpbmluZyB0aGUgcmVjb3JkIG9yIHVuZGVmaW5lZCBpZiBub3RoaW5nIGZvdW5kLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fGFycmF5fSBjb25kaXRpb24gLSBRdWVyeSBjb25kaXRpb24sIGtleS12YWx1ZSBwYWlyIHdpbGwgYmUgam9pbmVkIHdpdGggJ0FORCcsIGFycmF5IGVsZW1lbnQgd2lsbCBiZSBqb2luZWQgd2l0aCAnT1InLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0ICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMgeyp9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGZpbmRPbmVfKGZpbmRPcHRpb25zLCBjb25uT3B0aW9ucykgeyBcbiAgICAgICAgcHJlOiBmaW5kT3B0aW9ucztcblxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zLCB0cnVlIC8qIGZvciBzaW5nbGUgcmVjb3JkICovKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBjb250ZXh0ID0geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGZpbmRPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTsgXG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfRklORCwgdGhpcywgY29udGV4dCk7ICBcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKSB7XG4gICAgICAgICAgICBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24gPSB0aGlzLl9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZHMpIHRocm93IG5ldyBEc09wZXJhdGlvbkVycm9yKCdjb25uZWN0b3IuZmluZF8oKSByZXR1cm5zIHVuZGVmaW5lZCBkYXRhIHJlY29yZC4nKTtcblxuICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbiAmJiAhZmluZE9wdGlvbnMuJHNraXBPcm0pIHsgIFxuICAgICAgICAgICAgICAgIC8vcm93cywgY29sb3VtbnMsIGFsaWFzTWFwICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAocmVjb3Jkc1swXS5sZW5ndGggPT09IDApIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgICAgICAgICByZWNvcmRzID0gdGhpcy5fbWFwUmVjb3Jkc1RvT2JqZWN0cyhyZWNvcmRzLCBmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRzLmxlbmd0aCA9PT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc2VydDogcmVjb3Jkcy5sZW5ndGggPT09IDE7XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gcmVjb3Jkc1swXTtcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSwgY29udGV4dCk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRmluZCByZWNvcmRzIG1hdGNoaW5nIHRoZSBjb25kaXRpb24sIHJldHVybnMgYW4gYXJyYXkgb2YgcmVjb3Jkcy4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZmluZE9wdGlvbnNdIC0gZmluZE9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uXSAtIEpvaW5pbmdzXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtmaW5kT3B0aW9ucy4kcHJvamVjdGlvbl0gLSBTZWxlY3RlZCBmaWVsZHNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2ZpbmRPcHRpb25zLiRncm91cEJ5XSAtIEdyb3VwIGJ5IGZpZWxkc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZmluZE9wdGlvbnMuJG9yZGVyQnldIC0gT3JkZXIgYnkgZmllbGRzXG4gICAgICogQHByb3BlcnR5IHtudW1iZXJ9IFtmaW5kT3B0aW9ucy4kb2Zmc2V0XSAtIE9mZnNldFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJGxpbWl0XSAtIExpbWl0IFxuICAgICAqIEBwcm9wZXJ0eSB7bnVtYmVyfSBbZmluZE9wdGlvbnMuJHRvdGFsQ291bnRdIC0gUmV0dXJuIHRvdGFsQ291bnQgICAgICAgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2ZpbmRPcHRpb25zLiRpbmNsdWRlRGVsZXRlZD1mYWxzZV0gLSBJbmNsdWRlIHRob3NlIG1hcmtlZCBhcyBsb2dpY2FsIGRlbGV0ZWQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge2FycmF5fVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBmaW5kQWxsXyhmaW5kT3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBmaW5kT3B0aW9ucyA9IHRoaXMuX3ByZXBhcmVRdWVyaWVzKGZpbmRPcHRpb25zKTtcblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgICAgICAgICAgICAgXG4gICAgICAgICAgICBmaW5kT3B0aW9ucyxcbiAgICAgICAgICAgIGNvbm5PcHRpb25zXG4gICAgICAgIH07IFxuXG4gICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX0ZJTkQsIHRoaXMsIGNvbnRleHQpOyAgXG5cbiAgICAgICAgaWYgKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikge1xuICAgICAgICAgICAgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uID0gdGhpcy5fcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdG90YWxDb3VudDtcblxuICAgICAgICBsZXQgcm93cyA9IGF3YWl0IHRoaXMuX3NhZmVFeGVjdXRlXyhhc3luYyAoY29udGV4dCkgPT4geyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByZWNvcmRzID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZmluZF8oXG4gICAgICAgICAgICAgICAgdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZmluZE9wdGlvbnMsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkcykgdGhyb3cgbmV3IERzT3BlcmF0aW9uRXJyb3IoJ2Nvbm5lY3Rvci5maW5kXygpIHJldHVybnMgdW5kZWZpbmVkIGRhdGEgcmVjb3JkLicpO1xuXG4gICAgICAgICAgICBpZiAoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uICYmICFmaW5kT3B0aW9ucy4kc2tpcE9ybSkge1xuICAgICAgICAgICAgICAgIGlmIChmaW5kT3B0aW9ucy4kdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgICAgICB0b3RhbENvdW50ID0gcmVjb3Jkc1szXTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmVjb3JkcyA9IHRoaXMuX21hcFJlY29yZHNUb09iamVjdHMocmVjb3JkcywgZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgaWYgKGZpbmRPcHRpb25zLiR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRvdGFsQ291bnQgPSByZWNvcmRzWzFdO1xuICAgICAgICAgICAgICAgICAgICByZWNvcmRzID0gcmVjb3Jkc1swXTtcbiAgICAgICAgICAgICAgICB9ICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gdGhpcy5hZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpOyAgICAgICAgICAgIFxuICAgICAgICB9LCBjb250ZXh0KTtcblxuICAgICAgICBpZiAoZmluZE9wdGlvbnMuJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIHJldHVybiB7IHRvdGFsSXRlbXM6IHRvdGFsQ291bnQsIGl0ZW1zOiByb3dzIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcm93cztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY3JlYXRlT3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dXG4gICAgICogQHJldHVybnMge0VudGl0eU1vZGVsfVxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKGRhdGEsIGNyZWF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGNyZWF0ZU9wdGlvbnMgfHwgKGNyZWF0ZU9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgbGV0IFsgcmF3LCBhc3NvY2lhdGlvbnMgXSA9IHRoaXMuX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSk7XG5cbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgcmF3LCBcbiAgICAgICAgICAgIGNyZWF0ZU9wdGlvbnMsXG4gICAgICAgICAgICBjb25uT3B0aW9uc1xuICAgICAgICB9OyAgICAgICBcbiAgICAgICAgXG4gICAgICAgIGxldCBuZWVkQ3JlYXRlQXNzb2NzID0gZmFsc2U7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgbmVlZENyZWF0ZUFzc29jcyA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gLy8gZWxzZSBhbHJlYWR5IGluIGEgdHJhbnNhY3Rpb24gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgdGhpcy5fcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQpOyAgICAgICAgICBcblxuICAgICAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9CRUZPUkVfQ1JFQVRFLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY3JlYXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgY29udGV4dC5sYXRlc3QsIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnNcbiAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgIGF3YWl0IHRoaXMuYWZ0ZXJDcmVhdGVfKGNvbnRleHQpO1xuXG4gICAgICAgICAgICBpZiAobmVlZENyZWF0ZUFzc29jcykge1xuICAgICAgICAgICAgICAgIGF3YWl0IHRoaXMuX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSAtIEVudGl0eSBkYXRhIHdpdGggYXQgbGVhc3Qgb25lIHVuaXF1ZSBrZXkgKHBhaXIpIGdpdmVuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFt1cGRhdGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbY29ubk9wdGlvbnNdXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb25uT3B0aW9ucy5jb25uZWN0aW9uXVxuICAgICAqIEByZXR1cm5zIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgaWYgKHVwZGF0ZU9wdGlvbnMgJiYgdXBkYXRlT3B0aW9ucy4kYnlQYXNzUmVhZE9ubHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdVbmV4cGVjdGVkIHVzYWdlLicsIHsgXG4gICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgcmVhc29uOiAnJGJ5UGFzc1JlYWRPbmx5IG9wdGlvbiBpcyBub3QgYWxsb3cgdG8gYmUgc2V0IGZyb20gcHVibGljIHVwZGF0ZV8gbWV0aG9kLicsXG4gICAgICAgICAgICAgICAgdXBkYXRlT3B0aW9uc1xuICAgICAgICAgICAgfSk7ICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl91cGRhdGVfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSB1cGRhdGVPcHRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU1hbnlfKGRhdGEsIHVwZGF0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIGlmICh1cGRhdGVPcHRpb25zICYmIHVwZGF0ZU9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignVW5leHBlY3RlZCB1c2FnZS4nLCB7IFxuICAgICAgICAgICAgICAgIGVudGl0eTogdGhpcy5tZXRhLm5hbWUsIFxuICAgICAgICAgICAgICAgIHJlYXNvbjogJyRieVBhc3NSZWFkT25seSBvcHRpb24gaXMgbm90IGFsbG93IHRvIGJlIHNldCBmcm9tIHB1YmxpYyB1cGRhdGVfIG1ldGhvZC4nLFxuICAgICAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnNcbiAgICAgICAgICAgIH0pOyAgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdXBkYXRlXyhkYXRhLCB1cGRhdGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZV8oZGF0YSwgdXBkYXRlT3B0aW9ucywgY29ubk9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCkge1xuICAgICAgICBpZiAoIXVwZGF0ZU9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb25GaWVsZHMgPSB0aGlzLmdldFVuaXF1ZUtleUZpZWxkc0Zyb20oZGF0YSk7XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGNvbmRpdGlvbkZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignUHJpbWFyeSBrZXkgdmFsdWUocykgb3IgYXQgbGVhc3Qgb25lIGdyb3VwIG9mIHVuaXF1ZSBrZXkgdmFsdWUocykgaXMgcmVxdWlyZWQgZm9yIHVwZGF0aW5nIGFuIGVudGl0eS4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB7ICRxdWVyeTogXy5waWNrKGRhdGEsIGNvbmRpdGlvbkZpZWxkcykgfTtcbiAgICAgICAgICAgIGRhdGEgPSBfLm9taXQoZGF0YSwgY29uZGl0aW9uRmllbGRzKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHVwZGF0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyh1cGRhdGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIHJhdzogZGF0YSwgXG4gICAgICAgICAgICB1cGRhdGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLl9zYWZlRXhlY3V0ZV8oYXN5bmMgKGNvbnRleHQpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuX3ByZXBhcmVFbnRpdHlEYXRhXyhjb250ZXh0LCB0cnVlIC8qIGlzIHVwZGF0aW5nICovKTsgICAgICAgICAgXG5cbiAgICAgICAgICAgIGF3YWl0IEZlYXR1cmVzLmFwcGx5UnVsZXNfKFJ1bGVzLlJVTEVfQkVGT1JFX1VQREFURSwgdGhpcywgY29udGV4dCk7ICAgICBcblxuICAgICAgICAgICAgY29udGV4dC5yZXN1bHQgPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci51cGRhdGVfKFxuICAgICAgICAgICAgICAgIHRoaXMubWV0YS5uYW1lLCBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmxhdGVzdCwgXG4gICAgICAgICAgICAgICAgY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSxcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zXG4gICAgICAgICAgICApO1xuXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmFmdGVyVXBkYXRlXyhjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQubGF0ZXN0O1xuICAgICAgICB9LCBjb250ZXh0KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zKSB7XG4gICAgICAgIHJldHVybiB0aGlzLl9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCB0cnVlKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5IHdpdGggZ2l2ZW4gZGF0YS4gICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbZGVsZXRlT3B0aW9ucy4kcXVlcnldIC0gRXh0cmEgY29uZGl0aW9uXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkPWZhbHNlXSAtIFJldHJpZXZlIHRoZSB1cGRhdGVkIGVudGl0eSBmcm9tIGRhdGFiYXNlICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRwaHlzaWNhbERlbGV0aW9uPWZhbHNlXSAtIFdoZW4gZmV0Y2hBcnJheSA9IHRydWUsIHRoZSByZXN1bHQgd2lsbCBiZSByZXR1cm5lZCBkaXJlY3RseSB3aXRob3V0IGNyZWF0aW5nIG1vZGVsIG9iamVjdHMuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtjb25uT3B0aW9uc11cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2Nvbm5PcHRpb25zLmNvbm5lY3Rpb25dIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBkZWxldGVNYW55XyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucykge1xuICAgICAgICByZXR1cm4gdGhpcy5fZGVsZXRlXyhkZWxldGVPcHRpb25zLCBjb25uT3B0aW9ucywgZmFsc2UpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkgd2l0aCBnaXZlbiBkYXRhLiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtkZWxldGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtkZWxldGVPcHRpb25zLiRxdWVyeV0gLSBFeHRyYSBjb25kaXRpb25cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQ9ZmFsc2VdIC0gUmV0cmlldmUgdGhlIHVwZGF0ZWQgZW50aXR5IGZyb20gZGF0YWJhc2UgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2RlbGV0ZU9wdGlvbnMuJHBoeXNpY2FsRGVsZXRpb249ZmFsc2VdIC0gV2hlbiBmZXRjaEFycmF5ID0gdHJ1ZSwgdGhlIHJlc3VsdCB3aWxsIGJlIHJldHVybmVkIGRpcmVjdGx5IHdpdGhvdXQgY3JlYXRpbmcgbW9kZWwgb2JqZWN0cy5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW2Nvbm5PcHRpb25zXVxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29ubk9wdGlvbnMuY29ubmVjdGlvbl0gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9kZWxldGVfKGRlbGV0ZU9wdGlvbnMsIGNvbm5PcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgcHJlOiBkZWxldGVPcHRpb25zO1xuXG4gICAgICAgIGRlbGV0ZU9wdGlvbnMgPSB0aGlzLl9wcmVwYXJlUXVlcmllcyhkZWxldGVPcHRpb25zLCBmb3JTaW5nbGVSZWNvcmQgLyogZm9yIHNpbmdsZSByZWNvcmQgKi8pO1xuXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGVsZXRlT3B0aW9ucy4kcXVlcnkpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcignRW1wdHkgY29uZGl0aW9uIGlzIG5vdCBhbGxvd2VkIGZvciBkZWxldGluZyBhbiBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBkZWxldGVPcHRpb25zLFxuICAgICAgICAgICAgY29ubk9wdGlvbnNcbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgbm90RmluaXNoZWQgPSBhd2FpdCBGZWF0dXJlcy5hcHBseVJ1bGVzXyhSdWxlcy5SVUxFX0JFRk9SRV9ERUxFVEUsIHRoaXMsIGNvbnRleHQpOyAgICAgXG4gICAgICAgIGlmICghbm90RmluaXNoZWQpIHtcbiAgICAgICAgICAgIHJldHVybiBjb250ZXh0LmxhdGVzdDtcbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5fc2FmZUV4ZWN1dGVfKGFzeW5jIChjb250ZXh0KSA9PiB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmJlZm9yZURlbGV0ZV8oY29udGV4dCk7XG5cbiAgICAgICAgICAgIGNvbnRleHQucmVzdWx0ID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuZGVsZXRlXyhcbiAgICAgICAgICAgICAgICB0aGlzLm1ldGEubmFtZSwgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcXVlcnksXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9uc1xuICAgICAgICAgICAgKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGNvbnRleHQuZXhpc3Rpbmc7XG4gICAgICAgIH0sIGNvbnRleHQpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENoZWNrIHdoZXRoZXIgYSBkYXRhIHJlY29yZCBjb250YWlucyBwcmltYXJ5IGtleSBvciBhdCBsZWFzdCBvbmUgdW5pcXVlIGtleSBwYWlyLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqL1xuICAgIHN0YXRpYyBfY29udGFpbnNVbmlxdWVLZXkoZGF0YSkge1xuICAgICAgICByZXR1cm4gXy5maW5kKHRoaXMubWV0YS51bmlxdWVLZXlzLCBmaWVsZHMgPT4gXy5ldmVyeShmaWVsZHMsIGYgPT4gIV8uaXNOaWwoZGF0YVtmXSkpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFbnN1cmUgdGhlIGNvbmRpdGlvbiBjb250YWlucyBvbmUgb2YgdGhlIHVuaXF1ZSBrZXlzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqL1xuICAgIHN0YXRpYyBfZW5zdXJlQ29udGFpbnNVbmlxdWVLZXkoY29uZGl0aW9uKSB7XG4gICAgICAgIGxldCBjb250YWluc1VuaXF1ZUtleSA9IHRoaXMuX2NvbnRhaW5zVW5pcXVlS2V5KGNvbmRpdGlvbik7XG5cbiAgICAgICAgaWYgKCFjb250YWluc1VuaXF1ZUtleSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ1VuZXhwZWN0ZWQgdXNhZ2UuJywgeyBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5OiB0aGlzLm1ldGEubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgIHJlYXNvbjogJ1NpbmdsZSByZWNvcmQgb3BlcmF0aW9uIHJlcXVpcmVzIGNvbmRpdGlvbiB0byBiZSBjb250YWluaW5nIHVuaXF1ZSBrZXkuJyxcbiAgICAgICAgICAgICAgICAgICAgY29uZGl0aW9uXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgKTtcbiAgICAgICAgfVxuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBQcmVwYXJlIHZhbGlkIGFuZCBzYW5pdGl6ZWQgZW50aXR5IGRhdGEgZm9yIHNlbmRpbmcgdG8gZGF0YWJhc2UuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHQgLSBPcGVyYXRpb24gY29udGV4dC5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gY29udGV4dC5yYXcgLSBSYXcgaW5wdXQgZGF0YS5cbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuY29ubk9wdGlvbnNdXG4gICAgICogQHBhcmFtIHtib29sfSBpc1VwZGF0aW5nIC0gRmxhZyBmb3IgdXBkYXRpbmcgZXhpc3RpbmcgZW50aXR5LlxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfcHJlcGFyZUVudGl0eURhdGFfKGNvbnRleHQsIGlzVXBkYXRpbmcgPSBmYWxzZSkge1xuICAgICAgICBsZXQgbWV0YSA9IHRoaXMubWV0YTtcbiAgICAgICAgbGV0IGkxOG4gPSB0aGlzLmkxOG47XG4gICAgICAgIGxldCB7IG5hbWUsIGZpZWxkcyB9ID0gbWV0YTsgICAgICAgIFxuXG4gICAgICAgIGxldCB7IHJhdyB9ID0gY29udGV4dDtcbiAgICAgICAgbGV0IGxhdGVzdCA9IHt9LCBleGlzdGluZztcbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSBsYXRlc3Q7ICAgICAgIFxuXG4gICAgICAgIGlmICghY29udGV4dC5pMThuKSB7XG4gICAgICAgICAgICBjb250ZXh0LmkxOG4gPSBpMThuO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IG9wT3B0aW9ucyA9IGlzVXBkYXRpbmcgPyBjb250ZXh0LnVwZGF0ZU9wdGlvbnMgOiBjb250ZXh0LmNyZWF0ZU9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGlzVXBkYXRpbmcgJiYgdGhpcy5fZGVwZW5kc09uRXhpc3RpbmdEYXRhKHJhdykpIHtcbiAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAvLyBlbHNlIGFscmVhZHkgaW4gYSB0cmFuc2FjdGlvbiAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBleGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IG9wT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gZXhpc3Rpbmc7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGF3YWl0IGVhY2hBc3luY18oZmllbGRzLCBhc3luYyAoZmllbGRJbmZvLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gcmF3KSB7XG4gICAgICAgICAgICAgICAgLy9maWVsZCB2YWx1ZSBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8ucmVhZE9ubHkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1VwZGF0aW5nIHx8ICFvcE9wdGlvbnMuJGJ5UGFzc1JlYWRPbmx5LmhhcyhmaWVsZE5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3JlYWQgb25seSwgbm90IGFsbG93IHRvIHNldCBieSBpbnB1dCB2YWx1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFJlYWQtb25seSBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIHNldCBieSBtYW51YWwgaW5wdXQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgXG5cbiAgICAgICAgICAgICAgICBpZiAoaXNVcGRhdGluZyAmJiBmaWVsZEluZm8uZnJlZXplQWZ0ZXJOb25EZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogZXhpc3RpbmcsICdcImZyZWV6ZUFmdGVyTm9uRGVmYXVsdFwiIHF1YWxpZmllciByZXF1aXJlcyBleGlzdGluZyBkYXRhLic7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nW2ZpZWxkTmFtZV0gIT09IGZpZWxkSW5mby5kZWZhdWx0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ZyZWV6ZUFmdGVyTm9uRGVmYXVsdCwgbm90IGFsbG93IHRvIGNoYW5nZSBpZiB2YWx1ZSBpcyBub24tZGVmYXVsdFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYEZyZWV6ZUFmdGVyTm9uRGVmYXVsdCBmaWVsZCBcIiR7ZmllbGROYW1lfVwiIGlzIG5vdCBhbGxvd2VkIHRvIGJlIGNoYW5nZWQuYCwge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZEluZm86IGZpZWxkSW5mbyBcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLyoqICB0b2RvOiBmaXggZGVwZW5kZW5jeVxuICAgICAgICAgICAgICAgIGlmIChpc1VwZGF0aW5nICYmIGZpZWxkSW5mby53cml0ZU9uY2UpIHsgICAgIFxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGV4aXN0aW5nLCAnXCJ3cml0ZU9uY2VcIiBxdWFsaWZpZXIgcmVxdWlyZXMgZXhpc3RpbmcgZGF0YS4nO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNOaWwoZXhpc3RpbmdbZmllbGROYW1lXSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBXcml0ZS1vbmNlIGZpZWxkIFwiJHtmaWVsZE5hbWV9XCIgaXMgbm90IGFsbG93ZWQgdG8gYmUgdXBkYXRlIG9uY2UgaXQgd2FzIHNldC5gLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBuYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICovXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgLy9zYW5pdGl6ZSBmaXJzdFxuICAgICAgICAgICAgICAgIGlmIChpc05vdGhpbmcocmF3W2ZpZWxkTmFtZV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghZmllbGRJbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihgVGhlIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5IGNhbm5vdCBiZSBudWxsLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8gXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBUeXBlcy5zYW5pdGl6ZShyYXdbZmllbGROYW1lXSwgZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBEYXRhVmFsaWRhdGlvbkVycm9yKGBJbnZhbGlkIFwiJHtmaWVsZE5hbWV9XCIgdmFsdWUgb2YgXCIke25hbWV9XCIgZW50aXR5LmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IG5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGRJbmZvOiBmaWVsZEluZm8sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXJyb3I6IGVycm9yLm1lc3NhZ2UgfHwgZXJyb3Iuc3RhY2sgXG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvL25vdCBnaXZlbiBpbiByYXcgZGF0YVxuICAgICAgICAgICAgaWYgKGlzVXBkYXRpbmcpIHtcbiAgICAgICAgICAgICAgICBpZiAoZmllbGRJbmZvLmZvcmNlVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vaGFzIGZvcmNlIHVwZGF0ZSBwb2xpY3ksIGUuZy4gdXBkYXRlVGltZXN0YW1wXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8udXBkYXRlQnlEYikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy9yZXF1aXJlIGdlbmVyYXRvciB0byByZWZyZXNoIGF1dG8gZ2VuZXJhdGVkIHZhbHVlXG4gICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGF0ZXN0W2ZpZWxkTmFtZV0gPSBhd2FpdCBHZW5lcmF0b3JzLmRlZmF1bHQoZmllbGRJbmZvLCBpMThuKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRGF0YVZhbGlkYXRpb25FcnJvcihcbiAgICAgICAgICAgICAgICAgICAgICAgIGBcIiR7ZmllbGROYW1lfVwiIG9mIFwiJHtuYW1lfVwiIGVudHRpeSBpcyByZXF1aXJlZCBmb3IgZWFjaCB1cGRhdGUuYCwgeyAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7ICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIC8vbmV3IHJlY29yZFxuICAgICAgICAgICAgaWYgKCFmaWVsZEluZm8uY3JlYXRlQnlEYikge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZEluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgICAgICAvL2hhcyBkZWZhdWx0IHNldHRpbmcgaW4gbWV0YSBkYXRhXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gZmllbGRJbmZvLmRlZmF1bHQ7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGZpZWxkSW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChmaWVsZEluZm8uYXV0bykge1xuICAgICAgICAgICAgICAgICAgICAvL2F1dG9tYXRpY2FsbHkgZ2VuZXJhdGVkXG4gICAgICAgICAgICAgICAgICAgIGxhdGVzdFtmaWVsZE5hbWVdID0gYXdhaXQgR2VuZXJhdG9ycy5kZWZhdWx0KGZpZWxkSW5mbywgaTE4bik7XG5cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAvL21pc3NpbmcgcmVxdWlyZWRcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IERhdGFWYWxpZGF0aW9uRXJyb3IoYFwiJHtmaWVsZE5hbWV9XCIgb2YgXCIke25hbWV9XCIgZW50aXR5IGlzIHJlcXVpcmVkLmAsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogbmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkSW5mbzogZmllbGRJbmZvIFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IC8vIGVsc2UgZGVmYXVsdCB2YWx1ZSBzZXQgYnkgZGF0YWJhc2Ugb3IgYnkgcnVsZXNcbiAgICAgICAgfSk7XG5cbiAgICAgICAgYXdhaXQgRmVhdHVyZXMuYXBwbHlSdWxlc18oUnVsZXMuUlVMRV9BRlRFUl9WQUxJREFUSU9OLCB0aGlzLCBjb250ZXh0KTsgICAgXG5cbiAgICAgICAgYXdhaXQgdGhpcy5hcHBseU1vZGlmaWVyc18oY29udGV4dCwgaXNVcGRhdGluZyk7XG5cbiAgICAgICAgY29udGV4dC5sYXRlc3QgPSB0aGlzLnRyYW5zbGF0ZVZhbHVlKGxhdGVzdCwgb3BPcHRpb25zLiR2YXJpYWJsZXMpO1xuXG4gICAgICAgIHJldHVybiBjb250ZXh0O1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfc2FmZUV4ZWN1dGVfKGV4ZWN1dG9yLCBjb250ZXh0KSB7XG4gICAgICAgIGV4ZWN1dG9yID0gZXhlY3V0b3IuYmluZCh0aGlzKTtcblxuICAgICAgICBpZiAoY29udGV4dC5jb25uT3B0aW9ucyAmJiBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICByZXR1cm4gZXhlY3V0b3IoY29udGV4dCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCBleGVjdXRvcihjb250ZXh0KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgLy9pZiB0aGUgZXhlY3V0b3IgaGF2ZSBpbml0aWF0ZWQgYSB0cmFuc2FjdGlvblxuICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyAmJiBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gJiYgXG4gICAgICAgICAgICAgICAgYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuY29tbWl0Xyhjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIC8vd2UgaGF2ZSB0byByb2xsYmFjayBpZiBlcnJvciBvY2N1cnJlZCBpbiBhIHRyYW5zYWN0aW9uXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zICYmIFxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiAmJiBcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5yb2xsYmFja18oY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9IFxuICAgIH1cblxuICAgIHN0YXRpYyBfZGVwZW5kc09uRXhpc3RpbmdEYXRhKGlucHV0KSB7XG4gICAgICAgIC8vY2hlY2sgbW9kaWZpZXIgZGVwZW5kZW5jaWVzXG4gICAgICAgIGxldCBkZXBzID0gdGhpcy5tZXRhLmZpZWxkRGVwZW5kZW5jaWVzO1xuICAgICAgICBsZXQgaGFzRGVwZW5kcyA9IGZhbHNlO1xuXG4gICAgICAgIGlmIChkZXBzKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGRlcHMsIChkZXAsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChmaWVsZE5hbWUgaW4gaW5wdXQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uZmluZChkZXAsIGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IFsgc3RhZ2UsIGZpZWxkIF0gPSBkLnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gKHN0YWdlID09PSAnbGF0ZXN0JyB8fCBzdGFnZSA9PT0gJ2V4aXN0bmcnKSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzRGVwZW5kcykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLy9jaGVjayBieSBzcGVjaWFsIHJ1bGVzXG4gICAgICAgIGxldCBhdExlYXN0T25lTm90TnVsbCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdExlYXN0T25lTm90TnVsbDtcbiAgICAgICAgaWYgKGF0TGVhc3RPbmVOb3ROdWxsKSB7XG4gICAgICAgICAgICBoYXNEZXBlbmRzID0gXy5maW5kKGF0TGVhc3RPbmVOb3ROdWxsLCBmaWVsZHMgPT4gXy5maW5kKGZpZWxkcywgZmllbGQgPT4gKGZpZWxkIGluIGlucHV0KSAmJiBfLmlzTmlsKGlucHV0W2ZpZWxkXSkpKTtcbiAgICAgICAgICAgIGlmIChoYXNEZXBlbmRzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gZmFsc2U7XG4gICAgfVxuXG4gICAgc3RhdGljIF9oYXNSZXNlcnZlZEtleXMob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmZpbmQob2JqLCAodiwgaykgPT4ga1swXSA9PT0gJyQnKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3ByZXBhcmVRdWVyaWVzKG9wdGlvbnMsIGZvclNpbmdsZVJlY29yZCA9IGZhbHNlKSB7XG4gICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KG9wdGlvbnMpKSB7XG4gICAgICAgICAgICBpZiAoZm9yU2luZ2xlUmVjb3JkICYmIEFycmF5LmlzQXJyYXkodGhpcy5tZXRhLmtleUZpZWxkKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDYW5ub3QgdXNlIGEgc2luZ3VsYXIgdmFsdWUgYXMgY29uZGl0aW9uIHRvIHF1ZXJ5IGFnYWluc3QgYSBlbnRpdHkgd2l0aCBjb21iaW5lZCBwcmltYXJ5IGtleS4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIG9wdGlvbnMgPyB7ICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy50cmFuc2xhdGVWYWx1ZShvcHRpb25zKSB9IH0gOiB7fTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBub3JtYWxpemVkT3B0aW9ucyA9IHt9LCBxdWVyeSA9IHt9O1xuXG4gICAgICAgIF8uZm9yT3duKG9wdGlvbnMsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICBpZiAoa1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnNba10gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBxdWVyeVtrXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHsgLi4ucXVlcnksIC4uLm5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSB9O1xuXG4gICAgICAgIGlmIChmb3JTaW5nbGVSZWNvcmQpIHtcbiAgICAgICAgICAgIHRoaXMuX2Vuc3VyZUNvbnRhaW5zVW5pcXVlS2V5KG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRxdWVyeSA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJHF1ZXJ5LCBub3JtYWxpemVkT3B0aW9ucy4kdmFyaWFibGVzKTtcblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJGhhdmluZykge1xuICAgICAgICAgICAgbm9ybWFsaXplZE9wdGlvbnMuJGhhdmluZyA9IHRoaXMudHJhbnNsYXRlVmFsdWUobm9ybWFsaXplZE9wdGlvbnMuJGhhdmluZywgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAobm9ybWFsaXplZE9wdGlvbnMuJHByb2plY3Rpb24pIHtcbiAgICAgICAgICAgIG5vcm1hbGl6ZWRPcHRpb25zLiRwcm9qZWN0aW9uID0gdGhpcy50cmFuc2xhdGVWYWx1ZShub3JtYWxpemVkT3B0aW9ucy4kcHJvamVjdGlvbiwgbm9ybWFsaXplZE9wdGlvbnMuJHZhcmlhYmxlcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbm9ybWFsaXplZE9wdGlvbnM7XG4gICAgfVxuXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKCkge1xuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoTkVFRF9PVkVSUklERSk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9leHRyYWN0QXNzb2NpYXRpb25zKGRhdGEpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpOyAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKE5FRURfT1ZFUlJJREUpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIHRocm93IG5ldyBFcnJvcihORUVEX09WRVJSSURFKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdHJhbnNsYXRlVmFsdWUodmFsdWUsIHZhcmlhYmxlcykge1xuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ1Nlc3Npb25WYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCghdmFyaWFibGVzLnNlc3Npb24gfHwgISh2YWx1ZS5uYW1lIGluICB2YXJpYWJsZXMuc2Vzc2lvbikpICYmICF2YWx1ZS5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGVyckFyZ3MgPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5taXNzaW5nTWVzc2FnZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nTWVzc2FnZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodmFsdWUubWlzc2luZ1N0YXR1cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVyckFyZ3MucHVzaCh2YWx1ZS5taXNzaW5nU3RhdHVzIHx8IEh0dHBDb2RlLkJBRF9SRVFVRVNUKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoLi4uZXJyQXJncyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFyaWFibGVzLnNlc3Npb25bdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnUXVlcnlWYXJpYWJsZScpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdWYXJpYWJsZXMgY29udGV4dCBtaXNzaW5nLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCF2YXJpYWJsZXMucXVlcnkgfHwgISh2YWx1ZS5uYW1lIGluIHZhcmlhYmxlcy5xdWVyeSkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBRdWVyeSBwYXJhbWV0ZXIgXCIke3ZhbHVlLm5hbWV9XCIgaW4gY29uZmlndXJhdGlvbiBub3QgZm91bmQuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB2YXJpYWJsZXMucXVlcnlbdmFsdWUubmFtZV07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl90cmFuc2xhdGVTeW1ib2xUb2tlbih2YWx1ZS5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ05vdCBpbXBsZXRlbWVudGVkIHlldC4gJyArIHZhbHVlLm9vbFR5cGUpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gXy5tYXBWYWx1ZXModmFsdWUsICh2KSA9PiB0aGlzLnRyYW5zbGF0ZVZhbHVlKHYsIHZhcmlhYmxlcykpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUubWFwKHYgPT4gdGhpcy50cmFuc2xhdGVWYWx1ZSh2LCB2YXJpYWJsZXMpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl9zZXJpYWxpemUodmFsdWUpO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBFbnRpdHlNb2RlbDsiXX0=