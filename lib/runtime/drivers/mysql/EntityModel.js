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
      options = { ..._.omit(context.options, ['$retrieveUpdated', '$bypassEnsureUnique']),
        $retrieveCreated: context.options.$retrieveUpdated
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
        $query: this.getUniqueKeyValuePairsFrom(context.options.$query)
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

      context.return = await this.findOne_({ ...condition,
        ...retrieveOptions
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

    function mergeRecord(existingRow, rowObject, associations, nodePath) {
      _.each(associations, ({
        sql,
        key,
        list,
        subAssocs
      }, anchor) => {
        if (sql) return;
        let currentPath = nodePath.concat();
        currentPath.push(anchor);
        let objKey = ':' + anchor;
        let subObj = rowObject[objKey];

        if (!subObj) {
          return;
        }

        let subIndexes = existingRow.subIndexes[objKey];
        let rowKey = subObj[key];
        if (_.isNil(rowKey)) return;
        let existingSubRow = subIndexes && subIndexes[rowKey];

        if (existingSubRow) {
          if (subAssocs) {
            mergeRecord(existingSubRow, subObj, subAssocs, currentPath);
          } else {
            throw new OolongUsageError(`The subIndexes of association "${currentPath.join('.')}" with [key=${key}] of entity "${this.meta.name}" exists but subAssocs is null.`, {
              existingRow,
              rowObject,
              hierarchy
            });
          }
        } else {
          if (!list) {
            throw new OolongUsageError(`The structure of association "${currentPath.join('.')}" with [key=${key}] of entity "${this.meta.name}" should be a list.`, {
              existingRow,
              rowObject
            });
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

          if (!subIndexes) {
            throw new OolongUsageError(`The subIndexes of association "${currentPath.join('.')}" with [key=${key}] of entity "${this.meta.name}" does not exist.`, {
              existingRow,
              rowObject
            });
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
          if (!subObject) {
            return;
          }

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
        mergeRecord(existingRow, rowObject, hierarchy, []);
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

  static async _updateAssocs_(context, assocs) {
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
        return eachAsync_(data, item => assocModel.replaceOne_({ ...item,
          ...(assocMeta.field ? {
            [assocMeta.field]: keyValue
          } : {})
        }, null, context.connOptions));
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

      return assocModel.replaceOne_({ ...data,
        ...(assocMeta.field ? {
          [assocMeta.field]: keyValue
        } : {})
      }, null, context.connOptions);
    });
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJzZXRWYWx1ZUJ5UGF0aCIsImVhY2hBc3luY18iLCJEYXRlVGltZSIsIkVudGl0eU1vZGVsIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJUeXBlcyIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJzZXJpYWxpemUiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4IiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsIm5vZGVQYXRoIiwiZWFjaCIsInNxbCIsImxpc3QiLCJhbmNob3IiLCJjdXJyZW50UGF0aCIsImNvbmNhdCIsInB1c2giLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5IiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInN1YkluZGV4IiwiYnVpbGRTdWJJbmRleGVzIiwiaW5kZXhlcyIsInN1Yk9iamVjdCIsImFycmF5T2ZPYmpzIiwicm93IiwiaSIsInRhYmxlQ2FjaGUiLCJyZWR1Y2UiLCJjb2wiLCJ0YWJsZSIsImJ1Y2tldCIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImFzc29jcyIsImZvck93biIsInYiLCJrIiwic3RhcnRzV2l0aCIsIl9jcmVhdGVBc3NvY3NfIiwia2V5VmFsdWUiLCJhc3NvY01ldGEiLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsIl91cGRhdGVBc3NvY3NfIiwicmVwbGFjZU9uZV8iLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLElBQUksR0FBR0MsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLGNBQUw7QUFBcUJDLEVBQUFBLGNBQXJCO0FBQXFDQyxFQUFBQTtBQUFyQyxJQUFvREwsSUFBMUQ7O0FBRUEsTUFBTTtBQUFFTSxFQUFBQTtBQUFGLElBQWVMLE9BQU8sQ0FBQyxPQUFELENBQTVCOztBQUNBLE1BQU1NLFdBQVcsR0FBR04sT0FBTyxDQUFDLG1CQUFELENBQTNCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXNDUixP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QUFTLENBQUNsSyxLQUFYLEdBQW1CaUs7QUFBckIsU0FBbEIsR0FBb0QsRUFBeEQ7QUFBWCxPQUF2QixFQUFpRyxJQUFqRyxFQUF1RzVILE9BQU8sQ0FBQ00sV0FBL0csQ0FBUDtBQUNILEtBekJnQixDQUFqQjtBQTBCSDs7QUE3cEJzQzs7QUFncUIzQzZILE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQi9LLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZ2V0VmFsdWVCeVBhdGgsIHNldFZhbHVlQnlQYXRoLCBlYWNoQXN5bmNfIH0gPSBVdGlsO1xuXG5jb25zdCB7IERhdGVUaW1lIH0gPSByZXF1aXJlKCdsdXhvbicpO1xuY29uc3QgRW50aXR5TW9kZWwgPSByZXF1aXJlKCcuLi8uLi9FbnRpdHlNb2RlbCcpO1xuY29uc3QgeyBPb2xvbmdVc2FnZUVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSByZXF1aXJlKCcuLi8uLi9FcnJvcnMnKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vdHlwZXMnKTtcblxuLyoqXG4gKiBNeVNRTCBlbnRpdHkgbW9kZWwgY2xhc3MuXG4gKi9cbmNsYXNzIE15U1FMRW50aXR5TW9kZWwgZXh0ZW5kcyBFbnRpdHlNb2RlbCB7ICBcbiAgICAvKipcbiAgICAgKiBbc3BlY2lmaWNdIENoZWNrIGlmIHRoaXMgZW50aXR5IGhhcyBhdXRvIGluY3JlbWVudCBmZWF0dXJlLlxuICAgICAqL1xuICAgIHN0YXRpYyBnZXQgaGFzQXV0b0luY3JlbWVudCgpIHtcbiAgICAgICAgbGV0IGF1dG9JZCA9IHRoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQ7XG4gICAgICAgIHJldHVybiBhdXRvSWQgJiYgdGhpcy5tZXRhLmZpZWxkc1thdXRvSWQuZmllbGRdLmF1dG9JbmNyZW1lbnRJZDsgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eU9iaiBcbiAgICAgKiBAcGFyYW0geyp9IGtleVBhdGggXG4gICAgICovXG4gICAgc3RhdGljIGdldE5lc3RlZE9iamVjdChlbnRpdHlPYmosIGtleVBhdGgpIHtcbiAgICAgICAgcmV0dXJuIGdldFZhbHVlQnlQYXRoKGVudGl0eU9iaiwga2V5UGF0aC5zcGxpdCgnLicpLm1hcChwID0+ICc6JytwKS5qb2luKCcuJykpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV0gU2VyaWFsaXplIHZhbHVlIGludG8gZGF0YWJhc2UgYWNjZXB0YWJsZSBmb3JtYXQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG5hbWUgLSBOYW1lIG9mIHRoZSBzeW1ib2wgdG9rZW4gXG4gICAgICovXG4gICAgc3RhdGljIF90cmFuc2xhdGVTeW1ib2xUb2tlbihuYW1lKSB7XG4gICAgICAgIGlmIChuYW1lID09PSAnbm93Jykge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGIuY29ubmVjdG9yLnJhdygnTk9XKCknKTtcbiAgICAgICAgfSBcbiAgICAgICAgXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignbm90IHN1cHBvcnQnKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZSh2YWx1ZSkge1xuICAgICAgICBpZiAodHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicpIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuXG4gICAgICAgIGlmICh2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXVxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHsqfSBpbmZvIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlSW5mbyh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJyAmJiB2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdhcnJheScgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX05PX1JFRkVSRU5DRURfUk9XXzInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoJ1RoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6ICcgKyBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSAnRVJfRFVQX0VOVFJZJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcignVGhlIGVudGl0eSB0byBiZSB1cGRhdGVkIGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6ICcgKyBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSAnRVJfRFVQX0VOVFJZJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIHVwZGF0aW5nIGFuIGV4aXN0aW5nIFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2RvUmVwbGFjZU9uZV8oY29udGV4dCkge1xuICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG4gICAgICAgICAgICBcbiAgICAgICAgbGV0IGVudGl0eSA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG5cbiAgICAgICAgbGV0IHJldCwgb3B0aW9ucztcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IGVudGl0eTtcbiAgICAgICAgICAgIH0gICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAuLi5jb250ZXh0Lm9wdGlvbnMsIFxuICAgICAgICAgICAgICAgICRxdWVyeTogeyBbdGhpcy5tZXRhLmtleUZpZWxkXTogdGhpcy52YWx1ZU9mS2V5KGVudGl0eSkgfSwgXG4gICAgICAgICAgICAgICAgJGV4aXN0aW5nOiBlbnRpdHkgXG4gICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2UgeyAgICAgIFxuICAgICAgICAgICAgb3B0aW9ucyA9IHsgXG4gICAgICAgICAgICAgICAgLi4uXy5vbWl0KGNvbnRleHQub3B0aW9ucywgWyckcmV0cmlldmVVcGRhdGVkJywgJyRieXBhc3NFbnN1cmVVbmlxdWUnXSksXG4gICAgICAgICAgICAgICAgJHJldHJpZXZlQ3JlYXRlZDogY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9OyAgICAgICAgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXQgPSBhd2FpdCB0aGlzLmNyZWF0ZV8oY29udGV4dC5yYXcsIG9wdGlvbnMsIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChvcHRpb25zLiRleGlzdGluZykge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRleGlzdGluZyA9IG9wdGlvbnMuJGV4aXN0aW5nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJHJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBvcHRpb25zLiRyZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmV0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0OyAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5KSB9O1xuICAgICAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieXBhc3NFbnN1cmVVbmlxdWUgPSBjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5jb25kaXRpb24sIC4uLnJldHJpZXZlT3B0aW9ucyB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0LnJldHVybikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbmRpdGlvbi4kcXVlcnk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURiUmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IGNvbnRleHQucmVzdWx0O1xuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGFmdGVyVXBkYXRlTWFueSBSZXN1bHRTZXRIZWFkZXIge1xuICAgICAgICAgICAgICogZmllbGRDb3VudDogMCxcbiAgICAgICAgICAgICAqIGFmZmVjdGVkUm93czogMSxcbiAgICAgICAgICAgICAqIGluc2VydElkOiAwLFxuICAgICAgICAgICAgICogaW5mbzogJ1Jvd3MgbWF0Y2hlZDogMSAgQ2hhbmdlZDogMSAgV2FybmluZ3M6IDAnLFxuICAgICAgICAgICAgICogc2VydmVyU3RhdHVzOiAzLFxuICAgICAgICAgICAgICogd2FybmluZ1N0YXR1czogMCxcbiAgICAgICAgICAgICAqIGNoYW5nZWRSb3dzOiAxIH1cbiAgICAgICAgICAgICAqL1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IGNvbnRleHQub3B0aW9ucy4kcXVlcnk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQmVmb3JlIGRlbGV0aW5nIGFuIGVudGl0eS5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gRGVsZXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlRGVsZXRlZF0gLSBSZXRyaWV2ZSB0aGUgcmVjZW50bHkgZGVsZXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICovXG4gICAgc3RhdGljIF9pbnRlcm5hbEFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICApIDoge30pICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZignLicpOyAgICAgICAgXG4gICAgICAgIGxldCByZXN1bHQ7ICBcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHsgICAgICAgICBcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9OyAgIFxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MrMSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpOyAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zLCBub2RlUGF0aCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHsgXG4gICAgICAgICAgICAgICAgaWYgKHNxbCkgcmV0dXJuOyAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjdXJyZW50UGF0aCA9IG5vZGVQYXRoLmNvbmNhdCgpO1xuICAgICAgICAgICAgICAgIGN1cnJlbnRQYXRoLnB1c2goYW5jaG9yKTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XTtcblxuICAgICAgICAgICAgICAgIGlmICghc3ViT2JqKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MsIGN1cnJlbnRQYXRoKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbignLicpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZXhpc3RzIGJ1dCBzdWJBc3NvY3MgaXMgbnVsbC5gLCB7IGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGhpZXJhcmNoeSB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoIWxpc3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUgc3RydWN0dXJlIG9mIGFzc29jaWF0aW9uIFwiJHtjdXJyZW50UGF0aC5qb2luKCcuJyl9XCIgd2l0aCBba2V5PSR7a2V5fV0gb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBzaG91bGQgYmUgYSBsaXN0LmAsIHsgZXhpc3RpbmdSb3csIHJvd09iamVjdCB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gWyBzdWJPYmogXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcylcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIXN1YkluZGV4ZXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUgc3ViSW5kZXhlcyBvZiBhc3NvY2lhdGlvbiBcIiR7Y3VycmVudFBhdGguam9pbignLicpfVwiIHdpdGggW2tleT0ke2tleX1dIG9mIGVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgZXhpc3QuYCwgeyBleGlzdGluZ1Jvdywgcm93T2JqZWN0IH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIC8vbWFueSB0byAqICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL3N1Yk9iamVjdCBub3QgZXhpc3QsIGp1c3QgZmlsbGVkIHdpdGggbnVsbCBieSBqb2luaW5nXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFtdO1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gWyBzdWJPYmplY3QgXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoc3ViT2JqZWN0ICYmIF8uaXNOaWwoc3ViT2JqZWN0W2tleV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoc3ViT2JqZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqZWN0LCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgaW5kZXhlc1tvYmpLZXldID0ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW3N1Yk9iamVjdFtrZXldXTogc3ViSW5kZXhcbiAgICAgICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTsgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaW5kZXhlcztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBhcnJheU9mT2JqcyA9IFtdO1xuXG4gICAgICAgIC8vcHJvY2VzcyBlYWNoIHJvd1xuICAgICAgICByb3dzLmZvckVhY2goKHJvdywgaSkgPT4ge1xuICAgICAgICAgICAgbGV0IHJvd09iamVjdCA9IHt9OyAvLyBoYXNoLXN0eWxlIGRhdGEgcm93XG4gICAgICAgICAgICBsZXQgdGFibGVDYWNoZSA9IHt9OyAvLyBmcm9tIGFsaWFzIHRvIGNoaWxkIHByb3Agb2Ygcm93T2JqZWN0XG5cbiAgICAgICAgICAgIHJvdy5yZWR1Y2UoKHJlc3VsdCwgdmFsdWUsIGkpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgY29sID0gY29sdW1uc1tpXTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAoY29sLnRhYmxlID09PSAnQScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W2NvbC5uYW1lXSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgYnVja2V0ID0gdGFibGVDYWNoZVtjb2wudGFibGVdOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChidWNrZXQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBuZXN0ZWQgaW5zaWRlIFxuICAgICAgICAgICAgICAgICAgICAgICAgYnVja2V0W2NvbC5uYW1lXSA9IHZhbHVlOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbm9kZVBhdGggPSBhbGlhc01hcFtjb2wudGFibGVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKG5vZGVQYXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHsgW2NvbC5uYW1lXTogdmFsdWUgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWJsZUNhY2hlW2NvbC50YWJsZV0gPSBzdWJPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc2V0VmFsdWVCeVBhdGgocmVzdWx0LCBub2RlUGF0aCwgc3ViT2JqZWN0KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCByb3dPYmplY3QpOyAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCByb3dLZXkgPSByb3dPYmplY3RbdGhpcy5tZXRhLmtleUZpZWxkXTtcbiAgICAgICAgICAgIGxldCBleGlzdGluZ1JvdyA9IG1haW5JbmRleFtyb3dLZXldO1xuICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93KSB7XG4gICAgICAgICAgICAgICAgbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgaGllcmFyY2h5LCBbXSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdCwgXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSlcbiAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIGxldCByYXcgPSB7fSwgYXNzb2NzID0ge307XG4gICAgICAgIFxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aCgnOicpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2NzW2suc3Vic3RyKDEpXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIFsgcmF3LCBhc3NvY3MgXTsgICAgICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIGl0ZW0gPT4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTsgIFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5pdGVtLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsOyJdfQ==