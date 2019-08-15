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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJzZXRWYWx1ZUJ5UGF0aCIsImVhY2hBc3luY18iLCJEYXRlVGltZSIsIkVudGl0eU1vZGVsIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJUeXBlcyIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJzZXJpYWxpemUiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJyZXQiLCIkcmV0cmlldmVFeGlzdGluZyIsInJhd09wdGlvbnMiLCIkZXhpc3RpbmciLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCJvbWl0IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCIkcmVzdWx0IiwiX2ludGVybmFsQmVmb3JlQ3JlYXRlXyIsIl9pbnRlcm5hbEFmdGVyQ3JlYXRlXyIsIiRyZXRyaWV2ZURiUmVzdWx0IiwicmVzdWx0IiwiaW5zZXJ0SWQiLCJxdWVyeUtleSIsImdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tIiwibGF0ZXN0IiwicmV0cmlldmVPcHRpb25zIiwiaXNQbGFpbk9iamVjdCIsInJldHVybiIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8iLCJfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlXyIsImNvbmRpdGlvbiIsIiRieXBhc3NFbnN1cmVVbmlxdWUiLCIkcmVsYXRpb25zaGlwcyIsIl9pbnRlcm5hbEFmdGVyVXBkYXRlTWFueV8iLCJmaW5kQWxsXyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZV8iLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJfaW50ZXJuYWxCZWZvcmVEZWxldGVNYW55XyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlXyIsIl9pbnRlcm5hbEFmdGVyRGVsZXRlTWFueV8iLCJfcHJlcGFyZUFzc29jaWF0aW9ucyIsImZpbmRPcHRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwibW9kZWwiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJhcHAiLCJyZWZEYiIsImRhdGFiYXNlIiwiX21hcFJlY29yZHNUb09iamVjdHMiLCJyb3dzIiwiY29sdW1ucyIsImFsaWFzTWFwIiwiaGllcmFyY2h5IiwibWFpbkluZGV4IiwibWVyZ2VSZWNvcmQiLCJleGlzdGluZ1JvdyIsInJvd09iamVjdCIsImVhY2giLCJzcWwiLCJsaXN0IiwiYW5jaG9yIiwib2JqS2V5Iiwic3ViT2JqIiwic3ViSW5kZXhlcyIsInJvd0tleSIsImlzTmlsIiwiZXhpc3RpbmdTdWJSb3ciLCJwdXNoIiwic3ViSW5kZXgiLCJidWlsZFN1YkluZGV4ZXMiLCJpbmRleGVzIiwic3ViT2JqZWN0IiwiYXJyYXlPZk9ianMiLCJyb3ciLCJpIiwidGFibGVDYWNoZSIsInJlZHVjZSIsImNvbCIsInRhYmxlIiwiYnVja2V0Iiwibm9kZVBhdGgiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJ2IiwiayIsInN0YXJ0c1dpdGgiLCJfY3JlYXRlQXNzb2NzXyIsImtleVZhbHVlIiwiYXNzb2NNZXRhIiwiYXNzb2NNb2RlbCIsImNhc3RBcnJheSIsIml0ZW0iLCJfdXBkYXRlQXNzb2NzXyIsInJlcGxhY2VPbmVfIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxJQUFJLEdBQUdDLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUMsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxjQUFMO0FBQXFCQyxFQUFBQSxjQUFyQjtBQUFxQ0MsRUFBQUE7QUFBckMsSUFBb0RMLElBQTFEOztBQUVBLE1BQU07QUFBRU0sRUFBQUE7QUFBRixJQUFlTCxPQUFPLENBQUMsT0FBRCxDQUE1Qjs7QUFDQSxNQUFNTSxXQUFXLEdBQUdOLE9BQU8sQ0FBQyxtQkFBRCxDQUEzQjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFzQ1IsT0FBTyxDQUFDLGNBQUQsQ0FBbkQ7O0FBQ0EsTUFBTVMsS0FBSyxHQUFHVCxPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFLQSxNQUFNVSxnQkFBTixTQUErQkosV0FBL0IsQ0FBMkM7QUFJdkMsYUFBV0ssZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBaEM7QUFDQSxXQUFPQSxNQUFNLElBQUksS0FBS0MsSUFBTCxDQUFVRSxNQUFWLENBQWlCSCxNQUFNLENBQUNJLEtBQXhCLEVBQStCQyxlQUFoRDtBQUNIOztBQU9ELFNBQU9DLGVBQVAsQ0FBdUJDLFNBQXZCLEVBQWtDQyxPQUFsQyxFQUEyQztBQUN2QyxXQUFPbEIsY0FBYyxDQUFDaUIsU0FBRCxFQUFZQyxPQUFPLENBQUNDLEtBQVIsQ0FBYyxHQUFkLEVBQW1CQyxHQUFuQixDQUF1QkMsQ0FBQyxJQUFJLE1BQUlBLENBQWhDLEVBQW1DQyxJQUFuQyxDQUF3QyxHQUF4QyxDQUFaLENBQXJCO0FBQ0g7O0FBTUQsU0FBT0MscUJBQVAsQ0FBNkJDLElBQTdCLEVBQW1DO0FBQy9CLFFBQUlBLElBQUksS0FBSyxLQUFiLEVBQW9CO0FBQ2hCLGFBQU8sS0FBS0MsRUFBTCxDQUFRQyxTQUFSLENBQWtCQyxHQUFsQixDQUFzQixPQUF0QixDQUFQO0FBQ0g7O0FBRUQsVUFBTSxJQUFJQyxLQUFKLENBQVUsYUFBVixDQUFOO0FBQ0g7O0FBTUQsU0FBT0MsVUFBUCxDQUFrQkMsS0FBbEIsRUFBeUI7QUFDckIsUUFBSSxPQUFPQSxLQUFQLEtBQWlCLFNBQXJCLEVBQWdDLE9BQU9BLEtBQUssR0FBRyxDQUFILEdBQU8sQ0FBbkI7O0FBRWhDLFFBQUlBLEtBQUssWUFBWTNCLFFBQXJCLEVBQStCO0FBQzNCLGFBQU8yQixLQUFLLENBQUNDLEtBQU4sQ0FBWTtBQUFFQyxRQUFBQSxhQUFhLEVBQUU7QUFBakIsT0FBWixDQUFQO0FBQ0g7O0FBRUQsV0FBT0YsS0FBUDtBQUNIOztBQU9ELFNBQU9HLG9CQUFQLENBQTRCSCxLQUE1QixFQUFtQ0ksSUFBbkMsRUFBeUM7QUFDckMsUUFBSUEsSUFBSSxDQUFDQyxJQUFMLEtBQWMsU0FBbEIsRUFBNkI7QUFDekIsYUFBT0wsS0FBSyxHQUFHLENBQUgsR0FBTyxDQUFuQjtBQUNIOztBQUVELFFBQUlJLElBQUksQ0FBQ0MsSUFBTCxLQUFjLFVBQWQsSUFBNEJMLEtBQUssWUFBWTNCLFFBQWpELEVBQTJEO0FBQ3ZELGFBQU8yQixLQUFLLENBQUNDLEtBQU4sQ0FBWTtBQUFFQyxRQUFBQSxhQUFhLEVBQUU7QUFBakIsT0FBWixDQUFQO0FBQ0g7O0FBRUQsUUFBSUUsSUFBSSxDQUFDQyxJQUFMLEtBQWMsT0FBZCxJQUF5QkMsS0FBSyxDQUFDQyxPQUFOLENBQWNQLEtBQWQsQ0FBN0IsRUFBbUQ7QUFDL0MsVUFBSUksSUFBSSxDQUFDSSxHQUFULEVBQWM7QUFDVixlQUFPL0IsS0FBSyxDQUFDZ0MsS0FBTixDQUFZQyxLQUFaLENBQWtCVixLQUFsQixDQUFQO0FBQ0gsT0FGRCxNQUVPO0FBQ0gsZUFBT3ZCLEtBQUssQ0FBQ2dDLEtBQU4sQ0FBWUUsU0FBWixDQUFzQlgsS0FBdEIsQ0FBUDtBQUNIO0FBQ0o7O0FBRUQsUUFBSUksSUFBSSxDQUFDQyxJQUFMLEtBQWMsUUFBbEIsRUFBNEI7QUFDeEIsYUFBTzVCLEtBQUssQ0FBQ21DLE1BQU4sQ0FBYUQsU0FBYixDQUF1QlgsS0FBdkIsQ0FBUDtBQUNIOztBQUVELFdBQU9BLEtBQVA7QUFDSDs7QUFFRCxlQUFhYSxPQUFiLENBQXFCLEdBQUdDLElBQXhCLEVBQThCO0FBQzFCLFFBQUk7QUFDQSxhQUFPLE1BQU0sTUFBTUQsT0FBTixDQUFjLEdBQUdDLElBQWpCLENBQWI7QUFDSCxLQUZELENBRUUsT0FBT0MsS0FBUCxFQUFjO0FBQ1osVUFBSUMsU0FBUyxHQUFHRCxLQUFLLENBQUNFLElBQXRCOztBQUVBLFVBQUlELFNBQVMsS0FBSyx3QkFBbEIsRUFBNEM7QUFDeEMsY0FBTSxJQUFJeEMsYUFBSixDQUFrQixvRUFBb0V1QyxLQUFLLENBQUNHLE9BQTVGLENBQU47QUFDSCxPQUZELE1BRU8sSUFBSUYsU0FBUyxLQUFLLGNBQWxCLEVBQWtDO0FBQ3JDLGNBQU0sSUFBSXhDLGFBQUosQ0FBa0J1QyxLQUFLLENBQUNHLE9BQU4sR0FBaUIsMEJBQXlCLEtBQUtyQyxJQUFMLENBQVVhLElBQUssSUFBM0UsQ0FBTjtBQUNIOztBQUVELFlBQU1xQixLQUFOO0FBQ0g7QUFDSjs7QUFFRCxlQUFhSSxVQUFiLENBQXdCLEdBQUdMLElBQTNCLEVBQWlDO0FBQzdCLFFBQUk7QUFDQSxhQUFPLE1BQU0sTUFBTUssVUFBTixDQUFpQixHQUFHTCxJQUFwQixDQUFiO0FBQ0gsS0FGRCxDQUVFLE9BQU9DLEtBQVAsRUFBYztBQUNaLFVBQUlDLFNBQVMsR0FBR0QsS0FBSyxDQUFDRSxJQUF0Qjs7QUFFQSxVQUFJRCxTQUFTLEtBQUssd0JBQWxCLEVBQTRDO0FBQ3hDLGNBQU0sSUFBSXhDLGFBQUosQ0FBa0IsOEVBQThFdUMsS0FBSyxDQUFDRyxPQUF0RyxDQUFOO0FBQ0gsT0FGRCxNQUVPLElBQUlGLFNBQVMsS0FBSyxjQUFsQixFQUFrQztBQUNyQyxjQUFNLElBQUl4QyxhQUFKLENBQWtCdUMsS0FBSyxDQUFDRyxPQUFOLEdBQWlCLGdDQUErQixLQUFLckMsSUFBTCxDQUFVYSxJQUFLLElBQWpGLENBQU47QUFDSDs7QUFFRCxZQUFNcUIsS0FBTjtBQUNIO0FBQ0o7O0FBRUQsZUFBYUssY0FBYixDQUE0QkMsT0FBNUIsRUFBcUM7QUFDakMsVUFBTSxLQUFLQyxrQkFBTCxDQUF3QkQsT0FBeEIsQ0FBTjtBQUVBLFFBQUlFLE1BQU0sR0FBRyxNQUFNLEtBQUtDLFFBQUwsQ0FBYztBQUFFQyxNQUFBQSxNQUFNLEVBQUVKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBMUIsS0FBZCxFQUFrREosT0FBTyxDQUFDTSxXQUExRCxDQUFuQjtBQUVBLFFBQUlDLEdBQUosRUFBU0YsT0FBVDs7QUFFQSxRQUFJSCxNQUFKLEVBQVk7QUFDUixVQUFJRixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JHLGlCQUFwQixFQUF1QztBQUNuQ1IsUUFBQUEsT0FBTyxDQUFDUyxVQUFSLENBQW1CQyxTQUFuQixHQUErQlIsTUFBL0I7QUFDSDs7QUFFREcsTUFBQUEsT0FBTyxHQUFHLEVBQ04sR0FBR0wsT0FBTyxDQUFDSyxPQURMO0FBRU5ELFFBQUFBLE1BQU0sRUFBRTtBQUFFLFdBQUMsS0FBSzVDLElBQUwsQ0FBVW1ELFFBQVgsR0FBc0IsS0FBS0MsVUFBTCxDQUFnQlYsTUFBaEI7QUFBeEIsU0FGRjtBQUdOUSxRQUFBQSxTQUFTLEVBQUVSO0FBSEwsT0FBVjtBQU1BSyxNQUFBQSxHQUFHLEdBQUcsTUFBTSxLQUFLVCxVQUFMLENBQWdCRSxPQUFPLENBQUN4QixHQUF4QixFQUE2QjZCLE9BQTdCLEVBQXNDTCxPQUFPLENBQUNNLFdBQTlDLENBQVo7QUFDSCxLQVpELE1BWU87QUFDSEQsTUFBQUEsT0FBTyxHQUFHLEVBQ04sR0FBR3pELENBQUMsQ0FBQ2lFLElBQUYsQ0FBT2IsT0FBTyxDQUFDSyxPQUFmLEVBQXdCLENBQUMsa0JBQUQsRUFBcUIscUJBQXJCLENBQXhCLENBREc7QUFFTlMsUUFBQUEsZ0JBQWdCLEVBQUVkLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQlU7QUFGNUIsT0FBVjtBQUtBUixNQUFBQSxHQUFHLEdBQUcsTUFBTSxLQUFLZixPQUFMLENBQWFRLE9BQU8sQ0FBQ3hCLEdBQXJCLEVBQTBCNkIsT0FBMUIsRUFBbUNMLE9BQU8sQ0FBQ00sV0FBM0MsQ0FBWjtBQUNIOztBQUVELFFBQUlELE9BQU8sQ0FBQ0ssU0FBWixFQUF1QjtBQUNuQlYsTUFBQUEsT0FBTyxDQUFDUyxVQUFSLENBQW1CQyxTQUFuQixHQUErQkwsT0FBTyxDQUFDSyxTQUF2QztBQUNIOztBQUVELFFBQUlMLE9BQU8sQ0FBQ1csT0FBWixFQUFxQjtBQUNqQmhCLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJYLE9BQU8sQ0FBQ1csT0FBckM7QUFDSDs7QUFFRCxXQUFPVCxHQUFQO0FBQ0g7O0FBRUQsU0FBT1Usc0JBQVAsQ0FBOEJqQixPQUE5QixFQUF1QztBQUNuQyxXQUFPLElBQVA7QUFDSDs7QUFRRCxlQUFha0IscUJBQWIsQ0FBbUNsQixPQUFuQyxFQUE0QztBQUN4QyxRQUFJQSxPQUFPLENBQUNLLE9BQVIsQ0FBZ0JjLGlCQUFwQixFQUF1QztBQUNuQ25CLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNvQixNQUFyQztBQUNIOztBQUVELFFBQUlwQixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JTLGdCQUFwQixFQUFzQztBQUNsQyxVQUFJLEtBQUt4RCxnQkFBVCxFQUEyQjtBQUN2QixZQUFJO0FBQUUrRCxVQUFBQTtBQUFGLFlBQWVyQixPQUFPLENBQUNvQixNQUEzQjtBQUNBcEIsUUFBQUEsT0FBTyxDQUFDc0IsUUFBUixHQUFtQjtBQUFFLFdBQUMsS0FBSzlELElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBbkIsQ0FBMEJJLEtBQTNCLEdBQW1DMEQ7QUFBckMsU0FBbkI7QUFDSCxPQUhELE1BR087QUFDSHJCLFFBQUFBLE9BQU8sQ0FBQ3NCLFFBQVIsR0FBbUIsS0FBS0MsMEJBQUwsQ0FBZ0N2QixPQUFPLENBQUN3QixNQUF4QyxDQUFuQjtBQUNIOztBQUVELFVBQUlDLGVBQWUsR0FBRzdFLENBQUMsQ0FBQzhFLGFBQUYsQ0FBZ0IxQixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JTLGdCQUFoQyxJQUFvRGQsT0FBTyxDQUFDSyxPQUFSLENBQWdCUyxnQkFBcEUsR0FBdUYsRUFBN0c7QUFDQWQsTUFBQUEsT0FBTyxDQUFDMkIsTUFBUixHQUFpQixNQUFNLEtBQUt4QixRQUFMLENBQWMsRUFBRSxHQUFHc0IsZUFBTDtBQUFzQnJCLFFBQUFBLE1BQU0sRUFBRUosT0FBTyxDQUFDc0I7QUFBdEMsT0FBZCxFQUFnRXRCLE9BQU8sQ0FBQ00sV0FBeEUsQ0FBdkI7QUFDSCxLQVZELE1BVU87QUFDSCxVQUFJLEtBQUtoRCxnQkFBVCxFQUEyQjtBQUN2QixZQUFJO0FBQUUrRCxVQUFBQTtBQUFGLFlBQWVyQixPQUFPLENBQUNvQixNQUEzQjtBQUNBcEIsUUFBQUEsT0FBTyxDQUFDc0IsUUFBUixHQUFtQjtBQUFFLFdBQUMsS0FBSzlELElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBbkIsQ0FBMEJJLEtBQTNCLEdBQW1DMEQ7QUFBckMsU0FBbkI7QUFDQXJCLFFBQUFBLE9BQU8sQ0FBQzJCLE1BQVIsR0FBaUIsRUFBRSxHQUFHM0IsT0FBTyxDQUFDMkIsTUFBYjtBQUFxQixhQUFHM0IsT0FBTyxDQUFDc0I7QUFBaEMsU0FBakI7QUFDSDtBQUNKO0FBQ0o7O0FBRUQsU0FBT00sc0JBQVAsQ0FBOEI1QixPQUE5QixFQUF1QztBQUNuQyxXQUFPLElBQVA7QUFDSDs7QUFFRCxTQUFPNkIsMEJBQVAsQ0FBa0M3QixPQUFsQyxFQUEyQztBQUN2QyxXQUFPLElBQVA7QUFDSDs7QUFRRCxlQUFhOEIscUJBQWIsQ0FBbUM5QixPQUFuQyxFQUE0QztBQUN4QyxRQUFJQSxPQUFPLENBQUNLLE9BQVIsQ0FBZ0JjLGlCQUFwQixFQUF1QztBQUNuQ25CLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNvQixNQUFyQztBQUNIOztBQUVELFFBQUlwQixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JVLGdCQUFwQixFQUFzQztBQUNsQyxVQUFJZ0IsU0FBUyxHQUFHO0FBQUUzQixRQUFBQSxNQUFNLEVBQUUsS0FBS21CLDBCQUFMLENBQWdDdkIsT0FBTyxDQUFDSyxPQUFSLENBQWdCRCxNQUFoRDtBQUFWLE9BQWhCOztBQUNBLFVBQUlKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQjJCLG1CQUFwQixFQUF5QztBQUNyQ0QsUUFBQUEsU0FBUyxDQUFDQyxtQkFBVixHQUFnQ2hDLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQjJCLG1CQUFoRDtBQUNIOztBQUVELFVBQUlQLGVBQWUsR0FBRyxFQUF0Qjs7QUFFQSxVQUFJN0UsQ0FBQyxDQUFDOEUsYUFBRixDQUFnQjFCLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQlUsZ0JBQWhDLENBQUosRUFBdUQ7QUFDbkRVLFFBQUFBLGVBQWUsR0FBR3pCLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQlUsZ0JBQWxDO0FBQ0gsT0FGRCxNQUVPLElBQUlmLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQjRCLGNBQXBCLEVBQW9DO0FBQ3ZDUixRQUFBQSxlQUFlLENBQUNRLGNBQWhCLEdBQWlDakMsT0FBTyxDQUFDSyxPQUFSLENBQWdCNEIsY0FBakQ7QUFDSDs7QUFFRGpDLE1BQUFBLE9BQU8sQ0FBQzJCLE1BQVIsR0FBaUIsTUFBTSxLQUFLeEIsUUFBTCxDQUFjLEVBQUUsR0FBRzRCLFNBQUw7QUFBZ0IsV0FBR047QUFBbkIsT0FBZCxFQUFvRHpCLE9BQU8sQ0FBQ00sV0FBNUQsQ0FBdkI7O0FBQ0EsVUFBSU4sT0FBTyxDQUFDMkIsTUFBWixFQUFvQjtBQUNoQjNCLFFBQUFBLE9BQU8sQ0FBQ3NCLFFBQVIsR0FBbUIsS0FBS0MsMEJBQUwsQ0FBZ0N2QixPQUFPLENBQUMyQixNQUF4QyxDQUFuQjtBQUNILE9BRkQsTUFFTztBQUNIM0IsUUFBQUEsT0FBTyxDQUFDc0IsUUFBUixHQUFtQlMsU0FBUyxDQUFDM0IsTUFBN0I7QUFDSDtBQUNKO0FBQ0o7O0FBUUQsZUFBYThCLHlCQUFiLENBQXVDbEMsT0FBdkMsRUFBZ0Q7QUFDNUMsUUFBSUEsT0FBTyxDQUFDSyxPQUFSLENBQWdCYyxpQkFBcEIsRUFBdUM7QUFDbkNuQixNQUFBQSxPQUFPLENBQUNTLFVBQVIsQ0FBbUJPLE9BQW5CLEdBQTZCaEIsT0FBTyxDQUFDb0IsTUFBckM7QUFZSDs7QUFFRCxRQUFJcEIsT0FBTyxDQUFDSyxPQUFSLENBQWdCVSxnQkFBcEIsRUFBc0M7QUFDbEMsVUFBSVUsZUFBZSxHQUFHLEVBQXRCOztBQUVBLFVBQUk3RSxDQUFDLENBQUM4RSxhQUFGLENBQWdCMUIsT0FBTyxDQUFDSyxPQUFSLENBQWdCVSxnQkFBaEMsQ0FBSixFQUF1RDtBQUNuRFUsUUFBQUEsZUFBZSxHQUFHekIsT0FBTyxDQUFDSyxPQUFSLENBQWdCVSxnQkFBbEM7QUFDSCxPQUZELE1BRU8sSUFBSWYsT0FBTyxDQUFDSyxPQUFSLENBQWdCNEIsY0FBcEIsRUFBb0M7QUFDdkNSLFFBQUFBLGVBQWUsQ0FBQ1EsY0FBaEIsR0FBaUNqQyxPQUFPLENBQUNLLE9BQVIsQ0FBZ0I0QixjQUFqRDtBQUNIOztBQUVEakMsTUFBQUEsT0FBTyxDQUFDMkIsTUFBUixHQUFpQixNQUFNLEtBQUtRLFFBQUwsQ0FBYyxFQUFFLEdBQUdWLGVBQUw7QUFBc0JyQixRQUFBQSxNQUFNLEVBQUVKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBOUMsT0FBZCxFQUFzRUosT0FBTyxDQUFDTSxXQUE5RSxDQUF2QjtBQUNIOztBQUVETixJQUFBQSxPQUFPLENBQUNzQixRQUFSLEdBQW1CdEIsT0FBTyxDQUFDSyxPQUFSLENBQWdCRCxNQUFuQztBQUNIOztBQVFELGVBQWFnQyxzQkFBYixDQUFvQ3BDLE9BQXBDLEVBQTZDO0FBQ3pDLFFBQUlBLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQmdDLGdCQUFwQixFQUFzQztBQUNsQyxZQUFNLEtBQUtwQyxrQkFBTCxDQUF3QkQsT0FBeEIsQ0FBTjtBQUVBLFVBQUl5QixlQUFlLEdBQUc3RSxDQUFDLENBQUM4RSxhQUFGLENBQWdCMUIsT0FBTyxDQUFDSyxPQUFSLENBQWdCZ0MsZ0JBQWhDLElBQ2xCckMsT0FBTyxDQUFDSyxPQUFSLENBQWdCZ0MsZ0JBREUsR0FFbEIsRUFGSjtBQUlBckMsTUFBQUEsT0FBTyxDQUFDMkIsTUFBUixHQUFpQjNCLE9BQU8sQ0FBQ3NDLFFBQVIsR0FBbUIsTUFBTSxLQUFLbkMsUUFBTCxDQUFjLEVBQUUsR0FBR3NCLGVBQUw7QUFBc0JyQixRQUFBQSxNQUFNLEVBQUVKLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQkQ7QUFBOUMsT0FBZCxFQUFzRUosT0FBTyxDQUFDTSxXQUE5RSxDQUExQztBQUNIOztBQUVELFdBQU8sSUFBUDtBQUNIOztBQUVELGVBQWFpQywwQkFBYixDQUF3Q3ZDLE9BQXhDLEVBQWlEO0FBQzdDLFFBQUlBLE9BQU8sQ0FBQ0ssT0FBUixDQUFnQmdDLGdCQUFwQixFQUFzQztBQUNsQyxZQUFNLEtBQUtwQyxrQkFBTCxDQUF3QkQsT0FBeEIsQ0FBTjtBQUVBLFVBQUl5QixlQUFlLEdBQUc3RSxDQUFDLENBQUM4RSxhQUFGLENBQWdCMUIsT0FBTyxDQUFDSyxPQUFSLENBQWdCZ0MsZ0JBQWhDLElBQ2xCckMsT0FBTyxDQUFDSyxPQUFSLENBQWdCZ0MsZ0JBREUsR0FFbEIsRUFGSjtBQUlBckMsTUFBQUEsT0FBTyxDQUFDMkIsTUFBUixHQUFpQjNCLE9BQU8sQ0FBQ3NDLFFBQVIsR0FBbUIsTUFBTSxLQUFLSCxRQUFMLENBQWMsRUFBRSxHQUFHVixlQUFMO0FBQXNCckIsUUFBQUEsTUFBTSxFQUFFSixPQUFPLENBQUNLLE9BQVIsQ0FBZ0JEO0FBQTlDLE9BQWQsRUFBc0VKLE9BQU8sQ0FBQ00sV0FBOUUsQ0FBMUM7QUFDSDs7QUFFRCxXQUFPLElBQVA7QUFDSDs7QUFNRCxTQUFPa0MscUJBQVAsQ0FBNkJ4QyxPQUE3QixFQUFzQztBQUNsQyxRQUFJQSxPQUFPLENBQUNLLE9BQVIsQ0FBZ0JjLGlCQUFwQixFQUF1QztBQUNuQ25CLE1BQUFBLE9BQU8sQ0FBQ1MsVUFBUixDQUFtQk8sT0FBbkIsR0FBNkJoQixPQUFPLENBQUNvQixNQUFyQztBQUNIO0FBQ0o7O0FBTUQsU0FBT3FCLHlCQUFQLENBQWlDekMsT0FBakMsRUFBMEM7QUFDdEMsUUFBSUEsT0FBTyxDQUFDSyxPQUFSLENBQWdCYyxpQkFBcEIsRUFBdUM7QUFDbkNuQixNQUFBQSxPQUFPLENBQUNTLFVBQVIsQ0FBbUJPLE9BQW5CLEdBQTZCaEIsT0FBTyxDQUFDb0IsTUFBckM7QUFDSDtBQUNKOztBQU1ELFNBQU9zQixvQkFBUCxDQUE0QkMsV0FBNUIsRUFBeUM7QUFDckMsUUFBSUMsWUFBWSxHQUFHaEcsQ0FBQyxDQUFDaUcsSUFBRixDQUFPRixXQUFXLENBQUNHLFlBQW5CLEVBQWlDQyxJQUFqQyxFQUFuQjs7QUFDQSxRQUFJQyxVQUFVLEdBQUcsRUFBakI7QUFBQSxRQUFxQkMsT0FBTyxHQUFHLENBQS9CO0FBQUEsUUFBa0NDLEtBQUssR0FBRyxFQUExQztBQUVBTixJQUFBQSxZQUFZLENBQUNPLE9BQWIsQ0FBcUJDLEtBQUssSUFBSTtBQUMxQixVQUFJeEcsQ0FBQyxDQUFDOEUsYUFBRixDQUFnQjBCLEtBQWhCLENBQUosRUFBNEI7QUFDeEJBLFFBQUFBLEtBQUssR0FBRyxLQUFLQyx3QkFBTCxDQUE4QkQsS0FBOUIsRUFBcUMsS0FBSzlFLEVBQUwsQ0FBUWdGLFVBQTdDLENBQVI7QUFFQSxZQUFJQyxLQUFLLEdBQUdILEtBQUssQ0FBQ0csS0FBbEI7O0FBQ0EsWUFBSSxDQUFDSCxLQUFLLENBQUNHLEtBQVgsRUFBa0I7QUFDZEEsVUFBQUEsS0FBSyxHQUFHLFVBQVUsRUFBRU4sT0FBcEI7QUFDSDs7QUFFREQsUUFBQUEsVUFBVSxDQUFDTyxLQUFELENBQVYsR0FBb0I7QUFDaEJyRCxVQUFBQSxNQUFNLEVBQUVrRCxLQUFLLENBQUNsRCxNQURFO0FBRWhCc0QsVUFBQUEsUUFBUSxFQUFFSixLQUFLLENBQUNwRSxJQUZBO0FBR2hCeUUsVUFBQUEsTUFBTSxFQUFFTCxLQUFLLENBQUNLLE1BSEU7QUFJaEJDLFVBQUFBLEdBQUcsRUFBRU4sS0FBSyxDQUFDTSxHQUpLO0FBS2hCSCxVQUFBQSxLQUxnQjtBQU1oQkksVUFBQUEsRUFBRSxFQUFFUCxLQUFLLENBQUNPLEVBTk07QUFPaEIsY0FBSVAsS0FBSyxDQUFDUSxPQUFOLEdBQWdCLEtBQUt0RixFQUFMLENBQVFDLFNBQVIsQ0FBa0JzRixVQUFsQixDQUNaVCxLQUFLLENBQUNsRCxNQURNLEVBRVprRCxLQUFLLENBQUNVLEtBQU4sQ0FBWUMsZUFBWixDQUE0QixFQUFFLEdBQUdYLEtBQUssQ0FBQ1EsT0FBWDtBQUFvQkksWUFBQUEsVUFBVSxFQUFFckIsV0FBVyxDQUFDcUI7QUFBNUMsV0FBNUIsQ0FGWSxDQUFoQixHQUdJLEVBSFI7QUFQZ0IsU0FBcEI7QUFZSCxPQXBCRCxNQW9CTztBQUNILGFBQUtDLG1CQUFMLENBQXlCakIsVUFBekIsRUFBcUNFLEtBQXJDLEVBQTRDRSxLQUE1QztBQUNIO0FBQ0osS0F4QkQ7QUEwQkEsV0FBT0osVUFBUDtBQUNIOztBQVFELFNBQU9pQixtQkFBUCxDQUEyQmpCLFVBQTNCLEVBQXVDRSxLQUF2QyxFQUE4Q0UsS0FBOUMsRUFBcUQ7QUFDakQsUUFBSUYsS0FBSyxDQUFDRSxLQUFELENBQVQsRUFBa0IsT0FBT0YsS0FBSyxDQUFDRSxLQUFELENBQVo7QUFFbEIsUUFBSWMsT0FBTyxHQUFHZCxLQUFLLENBQUNlLFdBQU4sQ0FBa0IsR0FBbEIsQ0FBZDtBQUNBLFFBQUkvQyxNQUFKOztBQUVBLFFBQUk4QyxPQUFPLEtBQUssQ0FBQyxDQUFqQixFQUFvQjtBQUVoQixVQUFJRSxTQUFTLEdBQUcsRUFBRSxHQUFHLEtBQUs1RyxJQUFMLENBQVVvRixZQUFWLENBQXVCUSxLQUF2QjtBQUFMLE9BQWhCOztBQUNBLFVBQUl4RyxDQUFDLENBQUN5SCxPQUFGLENBQVVELFNBQVYsQ0FBSixFQUEwQjtBQUN0QixjQUFNLElBQUlqSCxhQUFKLENBQW1CLFdBQVUsS0FBS0ssSUFBTCxDQUFVYSxJQUFLLG9DQUFtQytFLEtBQU0sSUFBckYsQ0FBTjtBQUNIOztBQUVEaEMsTUFBQUEsTUFBTSxHQUFHOEIsS0FBSyxDQUFDRSxLQUFELENBQUwsR0FBZUosVUFBVSxDQUFDSSxLQUFELENBQVYsR0FBb0IsRUFBRSxHQUFHLEtBQUtDLHdCQUFMLENBQThCZSxTQUE5QjtBQUFMLE9BQTVDO0FBQ0gsS0FSRCxNQVFPO0FBQ0gsVUFBSUUsSUFBSSxHQUFHbEIsS0FBSyxDQUFDbUIsTUFBTixDQUFhLENBQWIsRUFBZ0JMLE9BQWhCLENBQVg7QUFDQSxVQUFJTSxJQUFJLEdBQUdwQixLQUFLLENBQUNtQixNQUFOLENBQWFMLE9BQU8sR0FBQyxDQUFyQixDQUFYO0FBRUEsVUFBSU8sUUFBUSxHQUFHdkIsS0FBSyxDQUFDb0IsSUFBRCxDQUFwQjs7QUFDQSxVQUFJLENBQUNHLFFBQUwsRUFBZTtBQUNYQSxRQUFBQSxRQUFRLEdBQUcsS0FBS1IsbUJBQUwsQ0FBeUJqQixVQUF6QixFQUFxQ0UsS0FBckMsRUFBNENvQixJQUE1QyxDQUFYO0FBQ0g7O0FBRUQsVUFBSXBFLE1BQU0sR0FBR3VFLFFBQVEsQ0FBQ1gsS0FBVCxJQUFrQixLQUFLeEYsRUFBTCxDQUFRd0YsS0FBUixDQUFjVyxRQUFRLENBQUN2RSxNQUF2QixDQUEvQjtBQUNBLFVBQUlrRSxTQUFTLEdBQUcsRUFBRSxHQUFHbEUsTUFBTSxDQUFDMUMsSUFBUCxDQUFZb0YsWUFBWixDQUF5QjRCLElBQXpCO0FBQUwsT0FBaEI7O0FBQ0EsVUFBSTVILENBQUMsQ0FBQ3lILE9BQUYsQ0FBVUQsU0FBVixDQUFKLEVBQTBCO0FBQ3RCLGNBQU0sSUFBSWpILGFBQUosQ0FBbUIsV0FBVStDLE1BQU0sQ0FBQzFDLElBQVAsQ0FBWWEsSUFBSyxvQ0FBbUMrRSxLQUFNLElBQXZGLENBQU47QUFDSDs7QUFFRGhDLE1BQUFBLE1BQU0sR0FBRyxFQUFFLEdBQUdsQixNQUFNLENBQUNtRCx3QkFBUCxDQUFnQ2UsU0FBaEMsRUFBMkMsS0FBSzlGLEVBQWhEO0FBQUwsT0FBVDs7QUFFQSxVQUFJLENBQUNtRyxRQUFRLENBQUNDLFNBQWQsRUFBeUI7QUFDckJELFFBQUFBLFFBQVEsQ0FBQ0MsU0FBVCxHQUFxQixFQUFyQjtBQUNIOztBQUVEeEIsTUFBQUEsS0FBSyxDQUFDRSxLQUFELENBQUwsR0FBZXFCLFFBQVEsQ0FBQ0MsU0FBVCxDQUFtQkYsSUFBbkIsSUFBMkJwRCxNQUExQztBQUNIOztBQUVELFFBQUlBLE1BQU0sQ0FBQ2dDLEtBQVgsRUFBa0I7QUFDZCxXQUFLYSxtQkFBTCxDQUF5QmpCLFVBQXpCLEVBQXFDRSxLQUFyQyxFQUE0Q0UsS0FBSyxHQUFHLEdBQVIsR0FBY2hDLE1BQU0sQ0FBQ2dDLEtBQWpFO0FBQ0g7O0FBRUQsV0FBT2hDLE1BQVA7QUFDSDs7QUFFRCxTQUFPaUMsd0JBQVAsQ0FBZ0NELEtBQWhDLEVBQXVDdUIsU0FBdkMsRUFBa0Q7QUFDOUMsUUFBSXZCLEtBQUssQ0FBQ2xELE1BQU4sQ0FBYTBFLE9BQWIsQ0FBcUIsR0FBckIsSUFBNEIsQ0FBaEMsRUFBbUM7QUFDL0IsVUFBSSxDQUFFdEIsVUFBRixFQUFjdUIsVUFBZCxJQUE2QnpCLEtBQUssQ0FBQ2xELE1BQU4sQ0FBYWxDLEtBQWIsQ0FBbUIsR0FBbkIsRUFBd0IsQ0FBeEIsQ0FBakM7QUFFQSxVQUFJOEcsR0FBRyxHQUFHLEtBQUt4RyxFQUFMLENBQVF3RyxHQUFsQjs7QUFDQSxVQUFJLENBQUNBLEdBQUwsRUFBVTtBQUNOLGNBQU0sSUFBSTVILGdCQUFKLENBQXFCLDZFQUFyQixDQUFOO0FBQ0g7O0FBRUQsVUFBSTZILEtBQUssR0FBR0QsR0FBRyxDQUFDeEcsRUFBSixDQUFPZ0YsVUFBUCxDQUFaOztBQUNBLFVBQUksQ0FBQ3lCLEtBQUwsRUFBWTtBQUNSLGNBQU0sSUFBSTdILGdCQUFKLENBQXNCLDBCQUF5Qm9HLFVBQVcsbURBQTFELENBQU47QUFDSDs7QUFFREYsTUFBQUEsS0FBSyxDQUFDbEQsTUFBTixHQUFlNkUsS0FBSyxDQUFDeEcsU0FBTixDQUFnQnlHLFFBQWhCLEdBQTJCLEdBQTNCLEdBQWlDSCxVQUFoRDtBQUNBekIsTUFBQUEsS0FBSyxDQUFDVSxLQUFOLEdBQWNpQixLQUFLLENBQUNqQixLQUFOLENBQVllLFVBQVosQ0FBZDs7QUFFQSxVQUFJLENBQUN6QixLQUFLLENBQUNVLEtBQVgsRUFBa0I7QUFDZCxjQUFNLElBQUk1RyxnQkFBSixDQUFzQixpQ0FBZ0NvRyxVQUFXLElBQUd1QixVQUFXLElBQS9FLENBQU47QUFDSDtBQUNKLEtBbkJELE1BbUJPO0FBQ0h6QixNQUFBQSxLQUFLLENBQUNVLEtBQU4sR0FBYyxLQUFLeEYsRUFBTCxDQUFRd0YsS0FBUixDQUFjVixLQUFLLENBQUNsRCxNQUFwQixDQUFkOztBQUVBLFVBQUl5RSxTQUFTLElBQUlBLFNBQVMsS0FBSyxLQUFLckcsRUFBcEMsRUFBd0M7QUFDcEM4RSxRQUFBQSxLQUFLLENBQUNsRCxNQUFOLEdBQWUsS0FBSzVCLEVBQUwsQ0FBUUMsU0FBUixDQUFrQnlHLFFBQWxCLEdBQTZCLEdBQTdCLEdBQW1DNUIsS0FBSyxDQUFDbEQsTUFBeEQ7QUFDSDtBQUNKOztBQUVELFFBQUksQ0FBQ2tELEtBQUssQ0FBQ00sR0FBWCxFQUFnQjtBQUNaTixNQUFBQSxLQUFLLENBQUNNLEdBQU4sR0FBWU4sS0FBSyxDQUFDVSxLQUFOLENBQVl0RyxJQUFaLENBQWlCbUQsUUFBN0I7QUFDSDs7QUFFRCxXQUFPeUMsS0FBUDtBQUNIOztBQUVELFNBQU82QixvQkFBUCxDQUE0QixDQUFDQyxJQUFELEVBQU9DLE9BQVAsRUFBZ0JDLFFBQWhCLENBQTVCLEVBQXVEQyxTQUF2RCxFQUFrRTtBQUM5RCxRQUFJQyxTQUFTLEdBQUcsRUFBaEI7O0FBRUEsYUFBU0MsV0FBVCxDQUFxQkMsV0FBckIsRUFBa0NDLFNBQWxDLEVBQTZDN0MsWUFBN0MsRUFBMkQ7QUFDdkRoRyxNQUFBQSxDQUFDLENBQUM4SSxJQUFGLENBQU85QyxZQUFQLEVBQXFCLENBQUM7QUFBRStDLFFBQUFBLEdBQUY7QUFBT2pDLFFBQUFBLEdBQVA7QUFBWWtDLFFBQUFBLElBQVo7QUFBa0JsQixRQUFBQTtBQUFsQixPQUFELEVBQWdDbUIsTUFBaEMsS0FBMkM7QUFDNUQsWUFBSUYsR0FBSixFQUFTO0FBRVQsWUFBSUcsTUFBTSxHQUFHLE1BQU1ELE1BQW5CO0FBQ0EsWUFBSUUsTUFBTSxHQUFHTixTQUFTLENBQUNLLE1BQUQsQ0FBdEI7QUFDQSxZQUFJRSxVQUFVLEdBQUdSLFdBQVcsQ0FBQ1EsVUFBWixDQUF1QkYsTUFBdkIsQ0FBakI7QUFHQSxZQUFJRyxNQUFNLEdBQUdGLE1BQU0sQ0FBQ3JDLEdBQUQsQ0FBbkI7QUFDQSxZQUFJOUcsQ0FBQyxDQUFDc0osS0FBRixDQUFRRCxNQUFSLENBQUosRUFBcUI7QUFFckIsWUFBSUUsY0FBYyxHQUFHSCxVQUFVLElBQUlBLFVBQVUsQ0FBQ0MsTUFBRCxDQUE3Qzs7QUFDQSxZQUFJRSxjQUFKLEVBQW9CO0FBQ2hCLGNBQUl6QixTQUFKLEVBQWU7QUFDWGEsWUFBQUEsV0FBVyxDQUFDWSxjQUFELEVBQWlCSixNQUFqQixFQUF5QnJCLFNBQXpCLENBQVg7QUFDSDtBQUNKLFNBSkQsTUFJTztBQUFBLGVBQ0trQixJQURMO0FBQUE7QUFBQTs7QUFHSCxjQUFJSixXQUFXLENBQUNDLFNBQVosQ0FBc0JLLE1BQXRCLENBQUosRUFBbUM7QUFDL0JOLFlBQUFBLFdBQVcsQ0FBQ0MsU0FBWixDQUFzQkssTUFBdEIsRUFBOEJNLElBQTlCLENBQW1DTCxNQUFuQztBQUNILFdBRkQsTUFFTztBQUNIUCxZQUFBQSxXQUFXLENBQUNDLFNBQVosQ0FBc0JLLE1BQXRCLElBQWdDLENBQUVDLE1BQUYsQ0FBaEM7QUFDSDs7QUFFRCxjQUFJTSxRQUFRLEdBQUc7QUFDWFosWUFBQUEsU0FBUyxFQUFFTTtBQURBLFdBQWY7O0FBSUEsY0FBSXJCLFNBQUosRUFBZTtBQUNYMkIsWUFBQUEsUUFBUSxDQUFDTCxVQUFULEdBQXNCTSxlQUFlLENBQUNQLE1BQUQsRUFBU3JCLFNBQVQsQ0FBckM7QUFDSDs7QUFFRHNCLFVBQUFBLFVBQVUsQ0FBQ0MsTUFBRCxDQUFWLEdBQXFCSSxRQUFyQjtBQUNIO0FBQ0osT0FuQ0Q7QUFvQ0g7O0FBRUQsYUFBU0MsZUFBVCxDQUF5QmIsU0FBekIsRUFBb0M3QyxZQUFwQyxFQUFrRDtBQUM5QyxVQUFJMkQsT0FBTyxHQUFHLEVBQWQ7O0FBRUEzSixNQUFBQSxDQUFDLENBQUM4SSxJQUFGLENBQU85QyxZQUFQLEVBQXFCLENBQUM7QUFBRStDLFFBQUFBLEdBQUY7QUFBT2pDLFFBQUFBLEdBQVA7QUFBWWtDLFFBQUFBLElBQVo7QUFBa0JsQixRQUFBQTtBQUFsQixPQUFELEVBQWdDbUIsTUFBaEMsS0FBMkM7QUFDNUQsWUFBSUYsR0FBSixFQUFTO0FBQ0w7QUFDSDs7QUFIMkQsYUFLcERqQyxHQUxvRDtBQUFBO0FBQUE7O0FBTzVELFlBQUlvQyxNQUFNLEdBQUcsTUFBTUQsTUFBbkI7QUFDQSxZQUFJVyxTQUFTLEdBQUdmLFNBQVMsQ0FBQ0ssTUFBRCxDQUF6QjtBQUNBLFlBQUlPLFFBQVEsR0FBRztBQUNYWixVQUFBQSxTQUFTLEVBQUVlO0FBREEsU0FBZjs7QUFJQSxZQUFJWixJQUFKLEVBQVU7QUFFTixjQUFJaEosQ0FBQyxDQUFDc0osS0FBRixDQUFRTSxTQUFTLENBQUM5QyxHQUFELENBQWpCLENBQUosRUFBNkI7QUFFekIrQixZQUFBQSxTQUFTLENBQUNLLE1BQUQsQ0FBVCxHQUFvQixFQUFwQjtBQUNBVSxZQUFBQSxTQUFTLEdBQUcsSUFBWjtBQUNILFdBSkQsTUFJTztBQUNIZixZQUFBQSxTQUFTLENBQUNLLE1BQUQsQ0FBVCxHQUFvQixDQUFFVSxTQUFGLENBQXBCO0FBQ0g7QUFDSixTQVRELE1BU08sSUFBSUEsU0FBUyxJQUFJNUosQ0FBQyxDQUFDc0osS0FBRixDQUFRTSxTQUFTLENBQUM5QyxHQUFELENBQWpCLENBQWpCLEVBQTBDO0FBQzdDOEMsVUFBQUEsU0FBUyxHQUFHZixTQUFTLENBQUNLLE1BQUQsQ0FBVCxHQUFvQixJQUFoQztBQUNIOztBQUVELFlBQUlVLFNBQUosRUFBZTtBQUNYLGNBQUk5QixTQUFKLEVBQWU7QUFDWDJCLFlBQUFBLFFBQVEsQ0FBQ0wsVUFBVCxHQUFzQk0sZUFBZSxDQUFDRSxTQUFELEVBQVk5QixTQUFaLENBQXJDO0FBQ0g7O0FBRUQ2QixVQUFBQSxPQUFPLENBQUNULE1BQUQsQ0FBUCxHQUFrQjtBQUNkLGFBQUNVLFNBQVMsQ0FBQzlDLEdBQUQsQ0FBVixHQUFrQjJDO0FBREosV0FBbEI7QUFHSDtBQUNKLE9BbkNEOztBQXFDQSxhQUFPRSxPQUFQO0FBQ0g7O0FBRUQsUUFBSUUsV0FBVyxHQUFHLEVBQWxCO0FBR0F2QixJQUFBQSxJQUFJLENBQUMvQixPQUFMLENBQWEsQ0FBQ3VELEdBQUQsRUFBTUMsQ0FBTixLQUFZO0FBQ3JCLFVBQUlsQixTQUFTLEdBQUcsRUFBaEI7QUFDQSxVQUFJbUIsVUFBVSxHQUFHLEVBQWpCO0FBRUFGLE1BQUFBLEdBQUcsQ0FBQ0csTUFBSixDQUFXLENBQUN6RixNQUFELEVBQVN6QyxLQUFULEVBQWdCZ0ksQ0FBaEIsS0FBc0I7QUFDN0IsWUFBSUcsR0FBRyxHQUFHM0IsT0FBTyxDQUFDd0IsQ0FBRCxDQUFqQjs7QUFFQSxZQUFJRyxHQUFHLENBQUNDLEtBQUosS0FBYyxHQUFsQixFQUF1QjtBQUNuQjNGLFVBQUFBLE1BQU0sQ0FBQzBGLEdBQUcsQ0FBQ3pJLElBQUwsQ0FBTixHQUFtQk0sS0FBbkI7QUFDSCxTQUZELE1BRU87QUFDSCxjQUFJcUksTUFBTSxHQUFHSixVQUFVLENBQUNFLEdBQUcsQ0FBQ0MsS0FBTCxDQUF2Qjs7QUFDQSxjQUFJQyxNQUFKLEVBQVk7QUFFUkEsWUFBQUEsTUFBTSxDQUFDRixHQUFHLENBQUN6SSxJQUFMLENBQU4sR0FBbUJNLEtBQW5CO0FBQ0gsV0FIRCxNQUdPO0FBQ0gsZ0JBQUlzSSxRQUFRLEdBQUc3QixRQUFRLENBQUMwQixHQUFHLENBQUNDLEtBQUwsQ0FBdkI7O0FBQ0EsZ0JBQUlFLFFBQUosRUFBYztBQUNWLGtCQUFJVCxTQUFTLEdBQUc7QUFBRSxpQkFBQ00sR0FBRyxDQUFDekksSUFBTCxHQUFZTTtBQUFkLGVBQWhCO0FBQ0FpSSxjQUFBQSxVQUFVLENBQUNFLEdBQUcsQ0FBQ0MsS0FBTCxDQUFWLEdBQXdCUCxTQUF4QjtBQUNBMUosY0FBQUEsY0FBYyxDQUFDc0UsTUFBRCxFQUFTNkYsUUFBVCxFQUFtQlQsU0FBbkIsQ0FBZDtBQUNIO0FBQ0o7QUFDSjs7QUFFRCxlQUFPcEYsTUFBUDtBQUNILE9BckJELEVBcUJHcUUsU0FyQkg7QUF1QkEsVUFBSVEsTUFBTSxHQUFHUixTQUFTLENBQUMsS0FBS2pJLElBQUwsQ0FBVW1ELFFBQVgsQ0FBdEI7QUFDQSxVQUFJNkUsV0FBVyxHQUFHRixTQUFTLENBQUNXLE1BQUQsQ0FBM0I7O0FBQ0EsVUFBSVQsV0FBSixFQUFpQjtBQUNiRCxRQUFBQSxXQUFXLENBQUNDLFdBQUQsRUFBY0MsU0FBZCxFQUF5QkosU0FBekIsQ0FBWDtBQUNILE9BRkQsTUFFTztBQUNIb0IsUUFBQUEsV0FBVyxDQUFDTCxJQUFaLENBQWlCWCxTQUFqQjtBQUNBSCxRQUFBQSxTQUFTLENBQUNXLE1BQUQsQ0FBVCxHQUFvQjtBQUNoQlIsVUFBQUEsU0FEZ0I7QUFFaEJPLFVBQUFBLFVBQVUsRUFBRU0sZUFBZSxDQUFDYixTQUFELEVBQVlKLFNBQVo7QUFGWCxTQUFwQjtBQUlIO0FBQ0osS0F0Q0Q7QUF3Q0EsV0FBT29CLFdBQVA7QUFDSDs7QUFFRCxTQUFPUyxvQkFBUCxDQUE0QkMsSUFBNUIsRUFBa0M7QUFDOUIsUUFBSTNJLEdBQUcsR0FBRyxFQUFWO0FBQUEsUUFBYzRJLE1BQU0sR0FBRyxFQUF2Qjs7QUFFQXhLLElBQUFBLENBQUMsQ0FBQ3lLLE1BQUYsQ0FBU0YsSUFBVCxFQUFlLENBQUNHLENBQUQsRUFBSUMsQ0FBSixLQUFVO0FBQ3JCLFVBQUlBLENBQUMsQ0FBQ0MsVUFBRixDQUFhLEdBQWIsQ0FBSixFQUF1QjtBQUNuQkosUUFBQUEsTUFBTSxDQUFDRyxDQUFDLENBQUNoRCxNQUFGLENBQVMsQ0FBVCxDQUFELENBQU4sR0FBc0IrQyxDQUF0QjtBQUNILE9BRkQsTUFFTztBQUNIOUksUUFBQUEsR0FBRyxDQUFDK0ksQ0FBRCxDQUFILEdBQVNELENBQVQ7QUFDSDtBQUNKLEtBTkQ7O0FBUUEsV0FBTyxDQUFFOUksR0FBRixFQUFPNEksTUFBUCxDQUFQO0FBQ0g7O0FBRUQsZUFBYUssY0FBYixDQUE0QnpILE9BQTVCLEVBQXFDb0gsTUFBckMsRUFBNkM7QUFDekMsUUFBSTVKLElBQUksR0FBRyxLQUFLQSxJQUFMLENBQVVvRixZQUFyQjtBQUNBLFFBQUk4RSxRQUFRLEdBQUcxSCxPQUFPLENBQUMyQixNQUFSLENBQWUsS0FBS25FLElBQUwsQ0FBVW1ELFFBQXpCLENBQWY7O0FBRUEsUUFBSS9ELENBQUMsQ0FBQ3NKLEtBQUYsQ0FBUXdCLFFBQVIsQ0FBSixFQUF1QjtBQUNuQixZQUFNLElBQUl4SyxnQkFBSixDQUFxQix1REFBdUQsS0FBS00sSUFBTCxDQUFVYSxJQUF0RixDQUFOO0FBQ0g7O0FBRUQsV0FBT3RCLFVBQVUsQ0FBQ3FLLE1BQUQsRUFBUyxPQUFPRCxJQUFQLEVBQWF0QixNQUFiLEtBQXdCO0FBQzlDLFVBQUk4QixTQUFTLEdBQUduSyxJQUFJLENBQUNxSSxNQUFELENBQXBCOztBQUNBLFVBQUksQ0FBQzhCLFNBQUwsRUFBZ0I7QUFDWixjQUFNLElBQUl6SyxnQkFBSixDQUFzQix3QkFBdUIySSxNQUFPLGdCQUFlLEtBQUtySSxJQUFMLENBQVVhLElBQUssSUFBbEYsQ0FBTjtBQUNIOztBQUVELFVBQUl1SixVQUFVLEdBQUcsS0FBS3RKLEVBQUwsQ0FBUXdGLEtBQVIsQ0FBYzZELFNBQVMsQ0FBQ3pILE1BQXhCLENBQWpCOztBQUVBLFVBQUl5SCxTQUFTLENBQUMvQixJQUFkLEVBQW9CO0FBQ2hCdUIsUUFBQUEsSUFBSSxHQUFHdkssQ0FBQyxDQUFDaUwsU0FBRixDQUFZVixJQUFaLENBQVA7QUFFQSxlQUFPcEssVUFBVSxDQUFDb0ssSUFBRCxFQUFPVyxJQUFJLElBQUlGLFVBQVUsQ0FBQ3BJLE9BQVgsQ0FBbUIsRUFBRSxHQUFHc0ksSUFBTDtBQUFXLGNBQUlILFNBQVMsQ0FBQ2hLLEtBQVYsR0FBa0I7QUFBRSxhQUFDZ0ssU0FBUyxDQUFDaEssS0FBWCxHQUFtQitKO0FBQXJCLFdBQWxCLEdBQW9ELEVBQXhEO0FBQVgsU0FBbkIsRUFBNkYxSCxPQUFPLENBQUNLLE9BQXJHLEVBQThHTCxPQUFPLENBQUNNLFdBQXRILENBQWYsQ0FBakI7QUFDSCxPQUpELE1BSU8sSUFBSSxDQUFDMUQsQ0FBQyxDQUFDOEUsYUFBRixDQUFnQnlGLElBQWhCLENBQUwsRUFBNEI7QUFDL0IsWUFBSWxJLEtBQUssQ0FBQ0MsT0FBTixDQUFjaUksSUFBZCxDQUFKLEVBQXlCO0FBQ3JCLGdCQUFNLElBQUloSyxhQUFKLENBQW1CLHNDQUFxQ3dLLFNBQVMsQ0FBQ3pILE1BQU8sMEJBQXlCLEtBQUsxQyxJQUFMLENBQVVhLElBQUssc0NBQXFDd0gsTUFBTyxtQ0FBN0osQ0FBTjtBQUNIOztBQUVELFlBQUksQ0FBQzhCLFNBQVMsQ0FBQ3ZFLEtBQWYsRUFBc0I7QUFDbEIsZ0JBQU0sSUFBSWxHLGdCQUFKLENBQXNCLHFDQUFvQzJJLE1BQU8sMkNBQWpFLENBQU47QUFDSDs7QUFFRHNCLFFBQUFBLElBQUksR0FBRztBQUFFLFdBQUNRLFNBQVMsQ0FBQ3ZFLEtBQVgsR0FBbUIrRDtBQUFyQixTQUFQO0FBQ0g7O0FBRUQsYUFBT1MsVUFBVSxDQUFDcEksT0FBWCxDQUFtQixFQUFFLEdBQUcySCxJQUFMO0FBQVcsWUFBSVEsU0FBUyxDQUFDaEssS0FBVixHQUFrQjtBQUFFLFdBQUNnSyxTQUFTLENBQUNoSyxLQUFYLEdBQW1CK0o7QUFBckIsU0FBbEIsR0FBb0QsRUFBeEQ7QUFBWCxPQUFuQixFQUE2RjFILE9BQU8sQ0FBQ0ssT0FBckcsRUFBOEdMLE9BQU8sQ0FBQ00sV0FBdEgsQ0FBUDtBQUNILEtBekJnQixDQUFqQjtBQTBCSDs7QUFFRCxlQUFheUgsY0FBYixDQUE0Qi9ILE9BQTVCLEVBQXFDb0gsTUFBckMsRUFBNkM7QUFDekMsUUFBSTVKLElBQUksR0FBRyxLQUFLQSxJQUFMLENBQVVvRixZQUFyQjtBQUNBLFFBQUk4RSxRQUFRLEdBQUcxSCxPQUFPLENBQUMyQixNQUFSLENBQWUsS0FBS25FLElBQUwsQ0FBVW1ELFFBQXpCLENBQWY7O0FBRUEsUUFBSS9ELENBQUMsQ0FBQ3NKLEtBQUYsQ0FBUXdCLFFBQVIsQ0FBSixFQUF1QjtBQUNuQixZQUFNLElBQUl4SyxnQkFBSixDQUFxQix1REFBdUQsS0FBS00sSUFBTCxDQUFVYSxJQUF0RixDQUFOO0FBQ0g7O0FBRUQsV0FBT3RCLFVBQVUsQ0FBQ3FLLE1BQUQsRUFBUyxPQUFPRCxJQUFQLEVBQWF0QixNQUFiLEtBQXdCO0FBQzlDLFVBQUk4QixTQUFTLEdBQUduSyxJQUFJLENBQUNxSSxNQUFELENBQXBCOztBQUNBLFVBQUksQ0FBQzhCLFNBQUwsRUFBZ0I7QUFDWixjQUFNLElBQUl6SyxnQkFBSixDQUFzQix3QkFBdUIySSxNQUFPLGdCQUFlLEtBQUtySSxJQUFMLENBQVVhLElBQUssSUFBbEYsQ0FBTjtBQUNIOztBQUVELFVBQUl1SixVQUFVLEdBQUcsS0FBS3RKLEVBQUwsQ0FBUXdGLEtBQVIsQ0FBYzZELFNBQVMsQ0FBQ3pILE1BQXhCLENBQWpCOztBQUVBLFVBQUl5SCxTQUFTLENBQUMvQixJQUFkLEVBQW9CO0FBQ2hCdUIsUUFBQUEsSUFBSSxHQUFHdkssQ0FBQyxDQUFDaUwsU0FBRixDQUFZVixJQUFaLENBQVA7QUFFQSxlQUFPcEssVUFBVSxDQUFDb0ssSUFBRCxFQUFPVyxJQUFJLElBQUlGLFVBQVUsQ0FBQ0ksV0FBWCxDQUF1QixFQUFFLEdBQUdGLElBQUw7QUFBVyxjQUFJSCxTQUFTLENBQUNoSyxLQUFWLEdBQWtCO0FBQUUsYUFBQ2dLLFNBQVMsQ0FBQ2hLLEtBQVgsR0FBbUIrSjtBQUFyQixXQUFsQixHQUFvRCxFQUF4RDtBQUFYLFNBQXZCLEVBQWlHLElBQWpHLEVBQXVHMUgsT0FBTyxDQUFDTSxXQUEvRyxDQUFmLENBQWpCO0FBQ0gsT0FKRCxNQUlPLElBQUksQ0FBQzFELENBQUMsQ0FBQzhFLGFBQUYsQ0FBZ0J5RixJQUFoQixDQUFMLEVBQTRCO0FBQy9CLFlBQUlsSSxLQUFLLENBQUNDLE9BQU4sQ0FBY2lJLElBQWQsQ0FBSixFQUF5QjtBQUNyQixnQkFBTSxJQUFJaEssYUFBSixDQUFtQixzQ0FBcUN3SyxTQUFTLENBQUN6SCxNQUFPLDBCQUF5QixLQUFLMUMsSUFBTCxDQUFVYSxJQUFLLHNDQUFxQ3dILE1BQU8sbUNBQTdKLENBQU47QUFDSDs7QUFFRCxZQUFJLENBQUM4QixTQUFTLENBQUN2RSxLQUFmLEVBQXNCO0FBQ2xCLGdCQUFNLElBQUlsRyxnQkFBSixDQUFzQixxQ0FBb0MySSxNQUFPLDJDQUFqRSxDQUFOO0FBQ0g7O0FBRURzQixRQUFBQSxJQUFJLEdBQUc7QUFBRSxXQUFDUSxTQUFTLENBQUN2RSxLQUFYLEdBQW1CK0Q7QUFBckIsU0FBUDtBQUNIOztBQUVELGFBQU9TLFVBQVUsQ0FBQ0ksV0FBWCxDQUF1QixFQUFFLEdBQUdiLElBQUw7QUFBVyxZQUFJUSxTQUFTLENBQUNoSyxLQUFWLEdBQWtCO0FBQUUsV0FBQ2dLLFNBQVMsQ0FBQ2hLLEtBQVgsR0FBbUIrSjtBQUFyQixTQUFsQixHQUFvRCxFQUF4RDtBQUFYLE9BQXZCLEVBQWlHLElBQWpHLEVBQXVHMUgsT0FBTyxDQUFDTSxXQUEvRyxDQUFQO0FBQ0gsS0F6QmdCLENBQWpCO0FBMEJIOztBQXpvQnNDOztBQTRvQjNDMkgsTUFBTSxDQUFDQyxPQUFQLEdBQWlCN0ssZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5cbmNvbnN0IHsgRGF0ZVRpbWUgfSA9IHJlcXVpcmUoJ2x1eG9uJyk7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoJy4uLy4uL0VudGl0eU1vZGVsJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgIFxuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0geyp9IGluZm8gXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnICYmIHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKCdUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcbiAgICAgICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBsZXQgcmV0LCBvcHRpb25zO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gZW50aXR5O1xuICAgICAgICAgICAgfSAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IFxuICAgICAgICAgICAgICAgIC4uLmNvbnRleHQub3B0aW9ucywgXG4gICAgICAgICAgICAgICAgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnZhbHVlT2ZLZXkoZW50aXR5KSB9LCBcbiAgICAgICAgICAgICAgICAkZXhpc3Rpbmc6IGVudGl0eSBcbiAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMudXBkYXRlT25lXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7ICAgICAgXG4gICAgICAgICAgICBvcHRpb25zID0geyBcbiAgICAgICAgICAgICAgICAuLi5fLm9taXQoY29udGV4dC5vcHRpb25zLCBbJyRyZXRyaWV2ZVVwZGF0ZWQnLCAnJGJ5cGFzc0Vuc3VyZVVuaXF1ZSddKSxcbiAgICAgICAgICAgICAgICAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH07ICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldCA9IGF3YWl0IHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgb3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgaWYgKG9wdGlvbnMuJGV4aXN0aW5nKSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJGV4aXN0aW5nID0gb3B0aW9ucy4kZXhpc3Rpbmc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAob3B0aW9ucy4kcmVzdWx0KSB7XG4gICAgICAgICAgICBjb250ZXh0LnJhd09wdGlvbnMuJHJlc3VsdCA9IG9wdGlvbnMuJHJlc3VsdDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0Lm9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpID8gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnF1ZXJ5S2V5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKHRoaXMuaGFzQXV0b0luY3JlbWVudCkge1xuICAgICAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0geyBbdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZC5maWVsZF06IGluc2VydElkIH07XG4gICAgICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSB7IC4uLmNvbnRleHQucmV0dXJuLCAuLi5jb250ZXh0LnF1ZXJ5S2V5IH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBfaW50ZXJuYWxCZWZvcmVVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7ICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IGNvbmRpdGlvbiA9IHsgJHF1ZXJ5OiB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQub3B0aW9ucy4kcXVlcnkpIH07XG4gICAgICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWUpIHtcbiAgICAgICAgICAgICAgICBjb25kaXRpb24uJGJ5cGFzc0Vuc3VyZVVuaXF1ZSA9IGNvbnRleHQub3B0aW9ucy4kYnlwYXNzRW5zdXJlVW5pcXVlO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0Lm9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLmNvbmRpdGlvbiwgLi4ucmV0cmlldmVPcHRpb25zIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICAgICAgaWYgKGNvbnRleHQucmV0dXJuKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5yZXR1cm4pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29uZGl0aW9uLiRxdWVyeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGJSZXN1bHQpIHtcbiAgICAgICAgICAgIGNvbnRleHQucmF3T3B0aW9ucy4kcmVzdWx0ID0gY29udGV4dC5yZXN1bHQ7XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogYWZ0ZXJVcGRhdGVNYW55IFJlc3VsdFNldEhlYWRlciB7XG4gICAgICAgICAgICAgKiBmaWVsZENvdW50OiAwLFxuICAgICAgICAgICAgICogYWZmZWN0ZWRSb3dzOiAxLFxuICAgICAgICAgICAgICogaW5zZXJ0SWQ6IDAsXG4gICAgICAgICAgICAgKiBpbmZvOiAnUm93cyBtYXRjaGVkOiAxICBDaGFuZ2VkOiAxICBXYXJuaW5nczogMCcsXG4gICAgICAgICAgICAgKiBzZXJ2ZXJTdGF0dXM6IDMsXG4gICAgICAgICAgICAgKiB3YXJuaW5nU3RhdHVzOiAwLFxuICAgICAgICAgICAgICogY2hhbmdlZFJvd3M6IDEgfVxuICAgICAgICAgICAgICovXG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0ge307XG5cbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zID0gY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQ7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcykge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucy4kcmVsYXRpb25zaGlwcyA9IGNvbnRleHQub3B0aW9ucy4kcmVsYXRpb25zaGlwcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBjb250ZXh0LnF1ZXJ5S2V5ID0gY29udGV4dC5vcHRpb25zLiRxdWVyeTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBEZWxldGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgYXdhaXQgdGhpcy5lbnN1cmVUcmFuc2FjdGlvbl8oY29udGV4dCk7IFxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5yZXR1cm4gPSBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IGRlbGV0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKi9cbiAgICBzdGF0aWMgX2ludGVybmFsQWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEYlJlc3VsdCkge1xuICAgICAgICAgICAgY29udGV4dC5yYXdPcHRpb25zLiRyZXN1bHQgPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gZmluZE9wdGlvbnMgXG4gICAgICovXG4gICAgc3RhdGljIF9wcmVwYXJlQXNzb2NpYXRpb25zKGZpbmRPcHRpb25zKSB7IFxuICAgICAgICBsZXQgYXNzb2NpYXRpb25zID0gXy51bmlxKGZpbmRPcHRpb25zLiRhc3NvY2lhdGlvbikuc29ydCgpOyAgICAgICAgXG4gICAgICAgIGxldCBhc3NvY1RhYmxlID0ge30sIGNvdW50ZXIgPSAwLCBjYWNoZSA9IHt9OyAgICAgICBcblxuICAgICAgICBhc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGFzc29jKSkge1xuICAgICAgICAgICAgICAgIGFzc29jID0gdGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIHRoaXMuZGIuc2NoZW1hTmFtZSk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gJzpqb2luJyArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsIFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0ID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLm1vZGVsLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiB7fSkgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKCcuJyk7ICAgICAgICBcbiAgICAgICAgbGV0IHJlc3VsdDsgIFxuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkgeyAgICAgICAgIFxuICAgICAgICAgICAgLy9kaXJlY3QgYXNzb2NpYXRpb25cbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07ICAgXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcysxKTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IGJhc2VOb2RlLm1vZGVsIHx8IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLmVudGl0eS5tZXRhLmFzc29jaWF0aW9uc1tsYXN0XSB9O1xuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdCA9IHsgLi4uZW50aXR5Ll90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8sIHRoaXMuZGIpIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgJy4nICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYywgY3VycmVudERiKSB7XG4gICAgICAgIGlmIChhc3NvYy5lbnRpdHkuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgZW50aXR5TmFtZSBdID0gYXNzb2MuZW50aXR5LnNwbGl0KCcuJywgMik7XG5cbiAgICAgICAgICAgIGxldCBhcHAgPSB0aGlzLmRiLmFwcDtcbiAgICAgICAgICAgIGlmICghYXBwKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ0Nyb3NzIGRiIGFzc29jaWF0aW9uIHJlcXVpcmVzIHRoZSBkYiBvYmplY3QgaGF2ZSBhY2Nlc3MgdG8gb3RoZXIgZGIgb2JqZWN0LicpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmVmRGIgPSBhcHAuZGIoc2NoZW1hTmFtZSk7XG4gICAgICAgICAgICBpZiAoIXJlZkRiKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUgcmVmZXJlbmNlZCBzY2hlbWEgXCIke3NjaGVtYU5hbWV9XCIgZG9lcyBub3QgaGF2ZSBkYiBtb2RlbCBpbiB0aGUgc2FtZSBhcHBsaWNhdGlvbi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gcmVmRGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgZW50aXR5TmFtZTtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2MubW9kZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgYXNzb2MubW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jLmVudGl0eSk7ICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjdXJyZW50RGIgJiYgY3VycmVudERiICE9PSB0aGlzLmRiKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5ID0gdGhpcy5kYi5jb25uZWN0b3IuZGF0YWJhc2UgKyAnLicgKyBhc3NvYy5lbnRpdHk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gYXNzb2MubW9kZWwubWV0YS5rZXlGaWVsZDsgICAgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYXNzb2M7XG4gICAgfVxuXG4gICAgc3RhdGljIF9tYXBSZWNvcmRzVG9PYmplY3RzKFtyb3dzLCBjb2x1bW5zLCBhbGlhc01hcF0sIGhpZXJhcmNoeSkge1xuICAgICAgICBsZXQgbWFpbkluZGV4ID0ge307ICAgICAgICBcblxuICAgICAgICBmdW5jdGlvbiBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBhc3NvY2lhdGlvbnMpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IHNxbCwga2V5LCBsaXN0LCBzdWJBc3NvY3MgfSwgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgICAgIGlmIChzcWwpIHJldHVybjsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJPYmogPSByb3dPYmplY3Rbb2JqS2V5XVxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleGVzID0gZXhpc3RpbmdSb3cuc3ViSW5kZXhlc1tvYmpLZXldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIC8vIGpvaW5lZCBhbiBlbXB0eSByZWNvcmRcbiAgICAgICAgICAgICAgICBsZXQgcm93S2V5ID0gc3ViT2JqW2tleV07XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwocm93S2V5KSkgcmV0dXJuO1xuXG4gICAgICAgICAgICAgICAgbGV0IGV4aXN0aW5nU3ViUm93ID0gc3ViSW5kZXhlcyAmJiBzdWJJbmRleGVzW3Jvd0tleV07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nU3ViUm93KSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1lcmdlUmVjb3JkKGV4aXN0aW5nU3ViUm93LCBzdWJPYmosIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBsaXN0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cucm93T2JqZWN0W29iaktleV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldLnB1c2goc3ViT2JqKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldID0gWyBzdWJPYmogXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHN1YkluZGV4ID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmosIHN1YkFzc29jcylcbiAgICAgICAgICAgICAgICAgICAgfSAgICBcblxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzW3Jvd0tleV0gPSBzdWJJbmRleDsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gYnVpbGRTdWJJbmRleGVzKHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaW5kZXhlcyA9IHt9O1xuXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChzcWwpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc2VydDoga2V5O1xuXG4gICAgICAgICAgICAgICAgbGV0IG9iaktleSA9ICc6JyArIGFuY2hvcjtcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdDogc3ViT2JqZWN0IFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAobGlzdCkgeyAgIFxuICAgICAgICAgICAgICAgICAgICAvL21hbnkgdG8gKiAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9zdWJPYmplY3Qgbm90IGV4aXN0LCBqdXN0IGZpbGxlZCB3aXRoIG51bGwgYnkgam9pbmluZ1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1Yk9iamVjdCA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqZWN0IF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHN1Yk9iamVjdCAmJiBfLmlzTmlsKHN1Yk9iamVjdFtrZXldKSkge1xuICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSByb3dPYmplY3Rbb2JqS2V5XSA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKHN1Yk9iamVjdCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJJbmRleC5zdWJJbmRleGVzID0gYnVpbGRTdWJJbmRleGVzKHN1Yk9iamVjdCwgc3ViQXNzb2NzKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGluZGV4ZXNbb2JqS2V5XSA9IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFtzdWJPYmplY3Rba2V5XV06IHN1YkluZGV4XG4gICAgICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7ICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGluZGV4ZXM7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgYXJyYXlPZk9ianMgPSBbXTtcblxuICAgICAgICAvL3Byb2Nlc3MgZWFjaCByb3dcbiAgICAgICAgcm93cy5mb3JFYWNoKChyb3csIGkpID0+IHtcbiAgICAgICAgICAgIGxldCByb3dPYmplY3QgPSB7fTsgLy8gaGFzaC1zdHlsZSBkYXRhIHJvd1xuICAgICAgICAgICAgbGV0IHRhYmxlQ2FjaGUgPSB7fTsgLy8gZnJvbSBhbGlhcyB0byBjaGlsZCBwcm9wIG9mIHJvd09iamVjdFxuXG4gICAgICAgICAgICByb3cucmVkdWNlKChyZXN1bHQsIHZhbHVlLCBpKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGNvbCA9IGNvbHVtbnNbaV07XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKGNvbC50YWJsZSA9PT0gJ0EnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFtjb2wubmFtZV0gPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJ1Y2tldCA9IHRhYmxlQ2FjaGVbY29sLnRhYmxlXTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoYnVja2V0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgbmVzdGVkIGluc2lkZSBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ1Y2tldFtjb2wubmFtZV0gPSB2YWx1ZTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG5vZGVQYXRoID0gYWxpYXNNYXBbY29sLnRhYmxlXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChub2RlUGF0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBzdWJPYmplY3QgPSB7IFtjb2wubmFtZV06IHZhbHVlIH07XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFibGVDYWNoZVtjb2wudGFibGVdID0gc3ViT2JqZWN0O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNldFZhbHVlQnlQYXRoKHJlc3VsdCwgbm9kZVBhdGgsIHN1Yk9iamVjdCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwgcm93T2JqZWN0KTsgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgcm93S2V5ID0gcm93T2JqZWN0W3RoaXMubWV0YS5rZXlGaWVsZF07XG4gICAgICAgICAgICBsZXQgZXhpc3RpbmdSb3cgPSBtYWluSW5kZXhbcm93S2V5XTtcbiAgICAgICAgICAgIGlmIChleGlzdGluZ1Jvdykge1xuICAgICAgICAgICAgICAgIG1lcmdlUmVjb3JkKGV4aXN0aW5nUm93LCByb3dPYmplY3QsIGhpZXJhcmNoeSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGFycmF5T2ZPYmpzLnB1c2gocm93T2JqZWN0KTtcbiAgICAgICAgICAgICAgICBtYWluSW5kZXhbcm93S2V5XSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHJvd09iamVjdCwgXG4gICAgICAgICAgICAgICAgICAgIHN1YkluZGV4ZXM6IGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGhpZXJhcmNoeSlcbiAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGFycmF5T2ZPYmpzO1xuICAgIH1cblxuICAgIHN0YXRpYyBfZXh0cmFjdEFzc29jaWF0aW9ucyhkYXRhKSB7XG4gICAgICAgIGxldCByYXcgPSB7fSwgYXNzb2NzID0ge307XG4gICAgICAgIFxuICAgICAgICBfLmZvck93bihkYXRhLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgaWYgKGsuc3RhcnRzV2l0aCgnOicpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2NzW2suc3Vic3RyKDEpXSA9IHY7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJhd1trXSA9IHY7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIFsgcmF3LCBhc3NvY3MgXTsgICAgICAgIFxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfY3JlYXRlQXNzb2NzXyhjb250ZXh0LCBhc3NvY3MpIHtcbiAgICAgICAgbGV0IG1ldGEgPSB0aGlzLm1ldGEuYXNzb2NpYXRpb25zO1xuICAgICAgICBsZXQga2V5VmFsdWUgPSBjb250ZXh0LnJldHVyblt0aGlzLm1ldGEua2V5RmllbGRdO1xuXG4gICAgICAgIGlmIChfLmlzTmlsKGtleVZhbHVlKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoJ01pc3NpbmcgcmVxdWlyZWQgcHJpbWFyeSBrZXkgZmllbGQgdmFsdWUuIEVudGl0eTogJyArIHRoaXMubWV0YS5uYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGFzc29jcywgYXN5bmMgKGRhdGEsIGFuY2hvcikgPT4ge1xuICAgICAgICAgICAgbGV0IGFzc29jTWV0YSA9IG1ldGFbYW5jaG9yXTtcbiAgICAgICAgICAgIGlmICghYXNzb2NNZXRhKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gYXNzb2NpYXRpb24gXCIke2FuY2hvcn1cIiBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgYXNzb2NNb2RlbCA9IHRoaXMuZGIubW9kZWwoYXNzb2NNZXRhLmVudGl0eSk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY01ldGEubGlzdCkge1xuICAgICAgICAgICAgICAgIGRhdGEgPSBfLmNhc3RBcnJheShkYXRhKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlYWNoQXN5bmNfKGRhdGEsIGl0ZW0gPT4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uaXRlbSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5jcmVhdGVfKHsgLi4uZGF0YSwgLi4uKGFzc29jTWV0YS5maWVsZCA/IHsgW2Fzc29jTWV0YS5maWVsZF06IGtleVZhbHVlIH0gOiB7fSkgfSwgY29udGV4dC5vcHRpb25zLCBjb250ZXh0LmNvbm5PcHRpb25zKTsgIFxuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX3VwZGF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwucmVwbGFjZU9uZV8oeyAuLi5pdGVtLCAuLi4oYXNzb2NNZXRhLmZpZWxkID8geyBbYXNzb2NNZXRhLmZpZWxkXToga2V5VmFsdWUgfSA6IHt9KSB9LCBudWxsLCBjb250ZXh0LmNvbm5PcHRpb25zKSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFfLmlzUGxhaW5PYmplY3QoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgSW52YWxpZCB0eXBlIG9mIGFzc29jaWF0ZWQgZW50aXR5ICgke2Fzc29jTWV0YS5lbnRpdHl9KSBkYXRhIHRyaWdnZXJlZCBmcm9tIFwiJHt0aGlzLm1ldGEubmFtZX1cIiBlbnRpdHkuIFNpbmd1bGFyIHZhbHVlIGV4cGVjdGVkICgke2FuY2hvcn0pLCBidXQgYW4gYXJyYXkgaXMgZ2l2ZW4gaW5zdGVhZC5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jTWV0YS5hc3NvYykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIGFzc29jaWF0ZWQgZmllbGQgb2YgcmVsYXRpb24gXCIke2FuY2hvcn1cIiBkb2VzIG5vdCBleGlzdCBpbiB0aGUgZW50aXR5IG1ldGEgZGF0YS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBkYXRhID0geyBbYXNzb2NNZXRhLmFzc29jXTogZGF0YSB9O1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2NNb2RlbC5yZXBsYWNlT25lXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIG51bGwsIGNvbnRleHQuY29ubk9wdGlvbnMpOyAgXG4gICAgICAgIH0pO1xuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTEVudGl0eU1vZGVsOyJdfQ==