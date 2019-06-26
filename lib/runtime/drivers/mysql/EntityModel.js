"use strict";

require("source-map-support/register");

const Util = require('rk-utils');

const {
  _,
  getValueByPath,
  setValueByPath,
  eachAsync_
} = Util;

const {
  DateTime
} = require('luxon');

const EntityModel = require('../../EntityModel');

const {
  OolongUsageError,
  BusinessError
} = require('../../Errors');

const Types = require('../../types');

class MySQLEntityModel extends EntityModel {
  static get hasAutoIncrement() {
    let autoId = this.meta.features.autoId;
    return autoId && this.meta.fields[autoId.field].autoIncrementId;
  }

  static getNestedObject(entityObj, keyPath) {
    return getValueByPath(entityObj, keyPath.split('.').map(p => ':' + p).join('.'));
  }

  static _translateSymbolToken(name) {
    if (name === 'now') {
      return this.db.connector.raw('NOW()');
    }

    throw new Error('not support');
  }

  static _serialize(value) {
    if (typeof value === 'boolean') return value ? 1 : 0;

    if (value instanceof DateTime) {
      return value.toISO({
        includeOffset: false
      });
    }

    return value;
  }

  static _serializeByTypeInfo(value, info) {
    if (info.type === 'boolean') {
      return value ? 1 : 0;
    }

    if (info.type === 'datetime' && value instanceof DateTime) {
      return value.toISO({
        includeOffset: false
      });
    }

    if (info.type === 'array' && Array.isArray(value)) {
      if (info.csv) {
        return Types.ARRAY.toCsv(value);
      } else {
        return Types.ARRAY.serialize(value);
      }
    }

    if (info.type === 'object') {
      return Types.OBJECT.serialize(value);
    }

    return value;
  }

  static async create_(...args) {
    try {
      return await super.create_(...args);
    } catch (error) {
      let errorCode = error.code;

      if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
        throw new BusinessError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
        throw new BusinessError(error.message + ` while creating a new "${this.meta.name}".`);
      }

      throw error;
    }
  }

  static async updateOne_(...args) {
    try {
      return await super.updateOne_(...args);
    } catch (error) {
      let errorCode = error.code;

      if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
        throw new BusinessError('The entity to be updated is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
        throw new BusinessError(error.message + ` while updating an existing "${this.meta.name}".`);
      }

      throw error;
    }
  }

  static async _doReplaceOne_(context) {
    await this.ensureTransaction_(context);
    let entity = await this.findOne_({
      $query: context.options.$query
    }, context.connOptions);
    let ret, options;

    if (entity) {
      if (context.options.$retrieveExisting) {
        context.rawOptions.$existing = entity;
      }

      options = { ...context.options,
        $query: {
          [this.meta.keyField]: this.valueOfKey(entity)
        },
        $existing: entity
      };
      ret = await this.updateOne_(context.raw, options, context.connOptions);
    } else {
      options = {
        $retrieveCreated: context.options.$retrieveUpdated,
        $retrieveDbResult: context.options.$retrieveDbResult
      };
      ret = await this.create_(context.raw, options, context.connOptions);
    }

    if (options.$existing) {
      context.rawOptions.$existing = options.$existing;
    }

    if (options.$result) {
      context.rawOptions.$result = options.$result;
    }

    return ret;
  }

  static _internalBeforeCreate_(context) {
    return true;
  }

  static async _internalAfterCreate_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (context.options.$retrieveCreated) {
      if (this.hasAutoIncrement) {
        let {
          insertId
        } = context.result;
        context.queryKey = {
          [this.meta.features.autoId.field]: insertId
        };
      } else {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
      }

      let retrieveOptions = _.isPlainObject(context.options.$retrieveCreated) ? context.options.$retrieveCreated : {};
      context.return = await this.findOne_({ ...retrieveOptions,
        $query: context.queryKey
      }, context.connOptions);
    } else {
      if (this.hasAutoIncrement) {
        let {
          insertId
        } = context.result;
        context.queryKey = {
          [this.meta.features.autoId.field]: insertId
        };
        context.return = { ...context.return,
          ...context.queryKey
        };
      }
    }
  }

  static _internalBeforeUpdate_(context) {
    return true;
  }

  static _internalBeforeUpdateMany_(context) {
    return true;
  }

  static async _internalAfterUpdate_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }

    if (context.options.$retrieveUpdated) {
      let condition = {
        $query: context.options.$query
      };

      if (context.options.$bypassEnsureUnique) {
        condition.$bypassEnsureUnique = context.options.$bypassEnsureUnique;
      }

      let retrieveOptions = {};

      if (_.isPlainObject(context.options.$retrieveUpdated)) {
        retrieveOptions = context.options.$retrieveUpdated;
      } else if (context.options.$relationships) {
        retrieveOptions.$relationships = context.options.$relationships;
      }

      context.return = await this.findOne_({ ...retrieveOptions,
        ...condition
      }, context.connOptions);

      if (context.return) {
        context.queryKey = this.getUniqueKeyValuePairsFrom(context.return);
      } else {
        context.queryKey = condition.$query;
      }
    }
  }

  static async _internalAfterUpdateMany_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
      console.log('afterUpdateMany', context.result);
    }

    if (context.options.$retrieveUpdated) {
      let retrieveOptions = {};

      if (_.isPlainObject(context.options.$retrieveUpdated)) {
        retrieveOptions = context.options.$retrieveUpdated;
      } else if (context.options.$relationships) {
        retrieveOptions.$relationships = context.options.$relationships;
      }

      context.return = await this.findAll_({ ...retrieveOptions,
        $query: context.options.$query
      }, context.connOptions);
    }

    context.queryKey = context.options.$query;
  }

  static async _internalBeforeDelete_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? context.options.$retrieveDeleted : {};
      context.return = context.existing = await this.findOne_({ ...retrieveOptions,
        $query: context.options.$query
      }, context.connOptions);
    }

    return true;
  }

  static async _internalBeforeDeleteMany_(context) {
    if (context.options.$retrieveDeleted) {
      await this.ensureTransaction_(context);
      let retrieveOptions = _.isPlainObject(context.options.$retrieveDeleted) ? context.options.$retrieveDeleted : {};
      context.return = context.existing = await this.findAll_({ ...retrieveOptions,
        $query: context.options.$query
      }, context.connOptions);
    }

    return true;
  }

  static _internalAfterDelete_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }
  }

  static _internalAfterDeleteMany_(context) {
    if (context.options.$retrieveDbResult) {
      context.rawOptions.$result = context.result;
    }
  }

  static _prepareAssociations(findOptions) {
    let associations = _.uniq(findOptions.$association).sort();

    let assocTable = {},
        counter = 0,
        cache = {};
    associations.forEach(assoc => {
      if (_.isPlainObject(assoc)) {
        assoc = this._translateSchemaNameToDb(assoc, this.db.schemaName);
        let alias = assoc.alias;

        if (!assoc.alias) {
          alias = ':join' + ++counter;
        }

        assocTable[alias] = {
          entity: assoc.entity,
          joinType: assoc.type,
          output: assoc.output,
          key: assoc.key,
          alias,
          on: assoc.on,
          ...(assoc.dataset ? this.db.connector.buildQuery(assoc.entity, assoc.model._prepareQueries({ ...assoc.dataset,
            $variables: findOptions.$variables
          })) : {})
        };
      } else {
        this._loadAssocIntoTable(assocTable, cache, assoc);
      }
    });
    return assocTable;
  }

  static _loadAssocIntoTable(assocTable, cache, assoc) {
    if (cache[assoc]) return cache[assoc];
    let lastPos = assoc.lastIndexOf('.');
    let result;

    if (lastPos === -1) {
      let assocInfo = { ...this.meta.associations[assoc]
      };

      if (_.isEmpty(assocInfo)) {
        throw new BusinessError(`Entity "${this.meta.name}" does not have the association "${assoc}".`);
      }

      result = cache[assoc] = assocTable[assoc] = { ...this._translateSchemaNameToDb(assocInfo)
      };
    } else {
      let base = assoc.substr(0, lastPos);
      let last = assoc.substr(lastPos + 1);
      let baseNode = cache[base];

      if (!baseNode) {
        baseNode = this._loadAssocIntoTable(assocTable, cache, base);
      }

      let entity = baseNode.model || this.db.model(baseNode.entity);
      let assocInfo = { ...entity.meta.associations[last]
      };

      if (_.isEmpty(assocInfo)) {
        throw new BusinessError(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
      }

      result = { ...entity._translateSchemaNameToDb(assocInfo, this.db)
      };

      if (!baseNode.subAssocs) {
        baseNode.subAssocs = {};
      }

      cache[assoc] = baseNode.subAssocs[last] = result;
    }

    if (result.assoc) {
      this._loadAssocIntoTable(assocTable, cache, assoc + '.' + result.assoc);
    }

    return result;
  }

  static _translateSchemaNameToDb(assoc, currentDb) {
    if (assoc.entity.indexOf('.') > 0) {
      let [schemaName, entityName] = assoc.entity.split('.', 2);
      let app = this.db.app;

      if (!app) {
        throw new OolongUsageError('Cross db association requires the db object have access to other db object.');
      }

      let refDb = app.db(schemaName);

      if (!refDb) {
        throw new OolongUsageError(`The referenced schema "${schemaName}" does not have db model in the same application.`);
      }

      assoc.entity = refDb.connector.database + '.' + entityName;
      assoc.model = refDb.model(entityName);

      if (!assoc.model) {
        throw new OolongUsageError(`Failed load the entity model "${schemaName}.${entityName}".`);
      }
    } else {
      assoc.model = this.db.model(assoc.entity);

      if (currentDb && currentDb !== this.db) {
        assoc.entity = this.db.connector.database + '.' + assoc.entity;
      }
    }

    if (!assoc.key) {
      assoc.key = assoc.model.meta.keyField;
    }

    return assoc;
  }

  static _mapRecordsToObjects([rows, columns, aliasMap], hierarchy) {
    let mainIndex = {};

    function mergeRecord(existingRow, rowObject, associations) {
      _.each(associations, ({
        sql,
        key,
        list,
        subAssocs
      }, anchor) => {
        if (sql) return;
        let objKey = ':' + anchor;
        let subObj = rowObject[objKey];
        let subIndexes = existingRow.subIndexes[objKey];
        let rowKey = subObj[key];
        if (_.isNil(rowKey)) return;
        let existingSubRow = subIndexes && subIndexes[rowKey];

        if (existingSubRow) {
          if (subAssocs) {
            mergeRecord(existingSubRow, subObj, subAssocs);
          }
        } else {
          if (!list) {
            throw new Error("Assertion failed: list");
          }

          if (existingRow.rowObject[objKey]) {
            existingRow.rowObject[objKey].push(subObj);
          } else {
            existingRow.rowObject[objKey] = [subObj];
          }

          let subIndex = {
            rowObject: subObj
          };

          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObj, subAssocs);
          }

          subIndexes[rowKey] = subIndex;
        }
      });
    }

    function buildSubIndexes(rowObject, associations) {
      let indexes = {};

      _.each(associations, ({
        sql,
        key,
        list,
        subAssocs
      }, anchor) => {
        if (sql) {
          return;
        }

        if (!key) {
          throw new Error("Assertion failed: key");
        }

        let objKey = ':' + anchor;
        let subObject = rowObject[objKey];
        let subIndex = {
          rowObject: subObject
        };

        if (list) {
          if (_.isNil(subObject[key])) {
            rowObject[objKey] = [];
            subObject = null;
          } else {
            rowObject[objKey] = [subObject];
          }
        } else if (subObject && _.isNil(subObject[key])) {
          subObject = rowObject[objKey] = null;
        }

        if (subObject) {
          if (subAssocs) {
            subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
          }

          indexes[objKey] = {
            [subObject[key]]: subIndex
          };
        }
      });

      return indexes;
    }

    let arrayOfObjs = [];
    rows.forEach((row, i) => {
      let rowObject = {};
      let tableCache = {};
      row.reduce((result, value, i) => {
        let col = columns[i];

        if (col.table === 'A') {
          result[col.name] = value;
        } else {
          let bucket = tableCache[col.table];

          if (bucket) {
            bucket[col.name] = value;
          } else {
            let nodePath = aliasMap[col.table];

            if (nodePath) {
              let subObject = {
                [col.name]: value
              };
              tableCache[col.table] = subObject;
              setValueByPath(result, nodePath, subObject);
            }
          }
        }

        return result;
      }, rowObject);
      let rowKey = rowObject[this.meta.keyField];
      let existingRow = mainIndex[rowKey];

      if (existingRow) {
        mergeRecord(existingRow, rowObject, hierarchy);
      } else {
        arrayOfObjs.push(rowObject);
        mainIndex[rowKey] = {
          rowObject,
          subIndexes: buildSubIndexes(rowObject, hierarchy)
        };
      }
    });
    return arrayOfObjs;
  }

  static _extractAssociations(data) {
    let raw = {},
        assocs = {};

    _.forOwn(data, (v, k) => {
      if (k.startsWith(':')) {
        assocs[k.substr(1)] = v;
      } else {
        raw[k] = v;
      }
    });

    return [raw, assocs];
  }

  static async _createAssocs_(context, assocs) {
    let meta = this.meta.associations;
    let keyValue = context.return[this.meta.keyField];

    if (_.isNil(keyValue)) {
      throw new OolongUsageError('Missing required primary key field value. Entity: ' + this.meta.name);
    }

    return eachAsync_(assocs, async (data, anchor) => {
      let assocMeta = meta[anchor];

      if (!assocMeta) {
        throw new OolongUsageError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
      }

      let assocModel = this.db.model(assocMeta.entity);

      if (assocMeta.list) {
        data = _.castArray(data);
        return eachAsync_(data, item => assocModel.create_({ ...item,
          ...(assocMeta.field ? {
            [assocMeta.field]: keyValue
          } : {})
        }, context.options, context.connOptions));
      } else if (!_.isPlainObject(data)) {
        if (Array.isArray(data)) {
          throw new BusinessError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
        }

        if (!assocMeta.assoc) {
          throw new OolongUsageError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
        }

        data = {
          [assocMeta.assoc]: data
        };
      }

      return assocModel.create_({ ...data,
        ...(assocMeta.field ? {
          [assocMeta.field]: keyValue
        } : {})
      }, context.options, context.connOptions);
    });
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJzZXRWYWx1ZUJ5UGF0aCIsImVhY2hBc3luY18iLCJEYXRlVGltZSIsIkVudGl0eU1vZGVsIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJUeXBlcyIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJzZXJpYWxpemUiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCIkcmV0cmlldmVDcmVhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsIiRyZXRyaWV2ZURiUmVzdWx0IiwiJHJlc3VsdCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJyZXN1bHQiLCJpbnNlcnRJZCIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImNvbnNvbGUiLCJsb2ciLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4IiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJwdXNoIiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsInJlZHVjZSIsImNvbCIsInRhYmxlIiwiYnVja2V0Iiwibm9kZVBhdGgiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJfY3JlYXRlQXNzb2NzXyIsImtleVZhbHVlIiwiYXNzb2NNZXRhIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBRUEsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXNDUixPQUFPLENBQUMsY0FBRCxDQUFuRDs7QUFDQSxNQUFNUyxLQUFLLEdBQUdULE9B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QUM4QixTQUFTLENBQUN2RSxLQUFmLEVBQXNCO0FBQ2xCLGdCQUFNLElBQUluRyxnQkFBSixDQUFzQixxQ0FBb0M0SSxNQUFPLDJDQUFqRSxDQUFOO0FBQ0g7O0FBRURzQixRQUFBQSxJQUFJLEdBQUc7QUFBRSxXQUFDUSxTQUFTLENBQUN2RSxLQUFYLEdBQW1CK0Q7QUFBckIsU0FBUDtBQUNIOztBQUVELGFBQU9TLFVBQVUsQ0FBQ3JJLE9BQVgsQ0FBbUIsRUFBRSxHQUFHNEgsSUFBTDtBQUFXLFlBQUlRLFNBQVMsQ0FBQ2pLLEtBQVYsR0FBa0I7QUFBRSxXQUFDaUssU0FBUyxDQUFDakssS0FBWCxHQUFtQmdLO0FBQXJCLFNBQWxCLEdBQW9ELEVBQXhEO0FBQVgsT0FBbkIsRUFBNkYzSCxPQUFPLENBQUNLLE9BQXJHLEVBQThHTCxPQUFPLENBQUNNLFdBQXRILENBQVA7QUFDSCxLQXpCZ0IsQ0FBakI7QUEwQkg7O0FBdmxCc0M7O0FBMGxCM0MwSCxNQUFNLENBQUNDLE9BQVAsR0FBaUI1SyxnQkFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGdldFZhbHVlQnlQYXRoLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcblxuY29uc3QgeyBEYXRlVGltZSB9ID0gcmVxdWlyZSgnbHV4b24nKTtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZSgnLi4vLi4vRW50aXR5TW9kZWwnKTtcbmNvbnN0IHsgT29sb25nVXNhZ2VFcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gcmVxdWlyZSgnLi4vLi4vRXJyb3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL3R5cGVzJyk7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwgeyAgXG4gICAgLyoqXG4gICAgICogW3NwZWNpZmljXSBDaGVjayBpZiB0aGlzIGVudGl0eSBoYXMgYXV0byBpbmNyZW1lbnQgZmVhdHVyZS5cbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7ICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHlPYmogXG4gICAgICogQHBhcmFtIHsqfSBrZXlQYXRoIFxuICAgICAqL1xuICAgIHN0YXRpYyBnZXROZXN0ZWRPYmplY3QoZW50aXR5T2JqLCBrZXlQYXRoKSB7XG4gICAgICAgIHJldHVybiBnZXRWYWx1ZUJ5UGF0aChlbnRpdHlPYmosIGtleVBhdGguc3BsaXQoJy4nKS5tYXAocCA9PiAnOicrcCkuam9pbignLicpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuIFxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gJ25vdycpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoJ05PVygpJyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBzdXBwb3J0Jyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7Kn0gaW5mbyBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZUluZm8odmFsdWUsIGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUgPyAxIDogMDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScgJiYgdmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYXJyYXknICYmIEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5jc3YpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkudG9Dc3YodmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gVHlwZXMuQVJSQVkuc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICByZXR1cm4gVHlwZXMuT0JKRUNULnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSAgICBcblxuICAgIHN0YXRpYyBhc3luYyBjcmVhdGVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci5jcmVhdGVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKCdUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSBjcmVhdGluZyBhIG5ldyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIHVwZGF0ZU9uZV8oLi4uYXJncykge1xuICAgICAgICB0cnkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLnVwZGF0ZU9uZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX05PX1JFRkVSRU5DRURfUk9XXzInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoJ1RoZSBlbnRpdHkgdG8gYmUgdXBkYXRlZCBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuICAgICAgICAgICAgXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGxldCByZXQsIG9wdGlvbnM7XG5cbiAgICAgICAgaWYgKGVudGl0eSkge1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVFeGlzdGluZykge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kZXhpc3RpbmcgPSBlbnRpdHk7XG4gICAgICAgICAgICB9ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4uY29udGV4dC5vcHRpb25zLCAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudmFsdWVPZktleShlbnRpdHkpIH0sICRleGlzdGluZzogZW50aXR5IH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7ICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVEYlJlc3VsdDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0XG4gICAgICAgICAgICB9OyAgICAgICAgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0OyAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9O1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgLi4uY29uZGl0aW9uIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnYWZ0ZXJVcGRhdGVNYW55JywgY29udGV4dC5yZXN1bHQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICApIDoge30pICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZignLicpOyAgICAgICAgXG4gICAgICAgIGxldCByZXN1bHQ7ICBcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHsgICAgICAgICBcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9OyAgIFxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MrMSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpOyAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV1cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogbGlzdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqIF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpXG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pOyAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09ICdBJykge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGUgXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsIFxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpXG4gICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICBsZXQgcmF3ID0ge30sIGFzc29jcyA9IHt9O1xuICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoJzonKSkge1xuICAgICAgICAgICAgICAgIGFzc29jc1trLnN1YnN0cigxKV0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBbIHJhdywgYXNzb2NzIF07ICAgICAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19