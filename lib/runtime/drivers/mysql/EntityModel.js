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

    if (entity) {
      return this.updateOne_(context.raw, { ...context.options,
        $query: {
          [this.meta.keyField]: this.valueOfKey(entity)
        }
      }, context.connOptions);
    } else {
      return this.create_(context.raw, {
        $retrieveCreated: context.options.$retrieveUpdated
      }, context.connOptions);
    }
  }

  static _internalBeforeCreate_(context) {
    return true;
  }

  static async _internalAfterCreate_(context) {
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
      context.queryKey = this.getUniqueKeyValuePairsFrom(context.return);
    }
  }

  static async _internalAfterUpdateMany_(context) {
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

  static _internalAfterDelete_(context) {}

  static _internalAfterDeleteMany_(context) {}

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwiZ2V0VmFsdWVCeVBhdGgiLCJzZXRWYWx1ZUJ5UGF0aCIsImVhY2hBc3luY18iLCJEYXRlVGltZSIsIkVudGl0eU1vZGVsIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJUeXBlcyIsIk15U1FMRW50aXR5TW9kZWwiLCJoYXNBdXRvSW5jcmVtZW50IiwiYXV0b0lkIiwibWV0YSIsImZlYXR1cmVzIiwiZmllbGRzIiwiZmllbGQiLCJhdXRvSW5jcmVtZW50SWQiLCJnZXROZXN0ZWRPYmplY3QiLCJlbnRpdHlPYmoiLCJrZXlQYXRoIiwic3BsaXQiLCJtYXAiLCJwIiwiam9pbiIsIl90cmFuc2xhdGVTeW1ib2xUb2tlbiIsIm5hbWUiLCJkYiIsImNvbm5lY3RvciIsInJhdyIsIkVycm9yIiwiX3NlcmlhbGl6ZSIsInZhbHVlIiwidG9JU08iLCJpbmNsdWRlT2Zmc2V0IiwiX3NlcmlhbGl6ZUJ5VHlwZUluZm8iLCJpbmZvIiwidHlwZSIsIkFycmF5IiwiaXNBcnJheSIsImNzdiIsIkFSUkFZIiwidG9Dc3YiLCJzZXJpYWxpemUiLCJPQkpFQ1QiLCJjcmVhdGVfIiwiYXJncyIsImVycm9yIiwiZXJyb3JDb2RlIiwiY29kZSIsIm1lc3NhZ2UiLCJ1cGRhdGVPbmVfIiwiX2RvUmVwbGFjZU9uZV8iLCJjb250ZXh0IiwiZW5zdXJlVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJvcHRpb25zIiwiY29ubk9wdGlvbnMiLCJrZXlGaWVsZCIsInZhbHVlT2ZLZXkiLCIkcmV0cmlldmVDcmVhdGVkIiwiJHJldHJpZXZlVXBkYXRlZCIsIl9pbnRlcm5hbEJlZm9yZUNyZWF0ZV8iLCJfaW50ZXJuYWxBZnRlckNyZWF0ZV8iLCJpbnNlcnRJZCIsInJlc3VsdCIsInF1ZXJ5S2V5IiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJsYXRlc3QiLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwicmV0dXJuIiwiX2ludGVybmFsQmVmb3JlVXBkYXRlXyIsIl9pbnRlcm5hbEJlZm9yZVVwZGF0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVfIiwiY29uZGl0aW9uIiwiJGJ5cGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiX2ludGVybmFsQmVmb3JlRGVsZXRlXyIsIiRyZXRyaWV2ZURlbGV0ZWQiLCJleGlzdGluZyIsIl9pbnRlcm5hbEJlZm9yZURlbGV0ZU1hbnlfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVfIiwiX2ludGVybmFsQWZ0ZXJEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiZmluZE9wdGlvbnMiLCJhc3NvY2lhdGlvbnMiLCJ1bmlxIiwiJGFzc29jaWF0aW9uIiwic29ydCIsImFzc29jVGFibGUiLCJjb3VudGVyIiwiY2FjaGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIiLCJzY2hlbWFOYW1lIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJtb2RlbCIsIl9wcmVwYXJlUXVlcmllcyIsIiR2YXJpYWJsZXMiLCJfbG9hZEFzc29jSW50b1RhYmxlIiwibGFzdFBvcyIsImxhc3RJbmRleE9mIiwiYXNzb2NJbmZvIiwiaXNFbXB0eSIsImJhc2UiLCJzdWJzdHIiLCJsYXN0IiwiYmFzZU5vZGUiLCJzdWJBc3NvY3MiLCJjdXJyZW50RGIiLCJpbmRleE9mIiwiZW50aXR5TmFtZSIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJtYWluSW5kZXgiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0IiwiZWFjaCIsInNxbCIsImxpc3QiLCJhbmNob3IiLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5IiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInB1c2giLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwicmVkdWNlIiwiY29sIiwidGFibGUiLCJidWNrZXQiLCJub2RlUGF0aCIsIl9leHRyYWN0QXNzb2NpYXRpb25zIiwiZGF0YSIsImFzc29jcyIsImZvck93biIsInYiLCJrIiwic3RhcnRzV2l0aCIsIl9jcmVhdGVBc3NvY3NfIiwia2V5VmFsdWUiLCJhc3NvY01ldGEiLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsY0FBTDtBQUFxQkMsRUFBQUEsY0FBckI7QUFBcUNDLEVBQUFBO0FBQXJDLElBQW9ETCxJQUExRDs7QUFFQSxNQUFNO0FBQUVNLEVBQUFBO0FBQUYsSUFBZUwsT0FBTyxDQUFDLE9BQUQsQ0FBNUI7O0FBQ0EsTUFBTU0sV0FBVyxHQUFHTixPQUFPLENBQUMsbUJBQUQsQ0FBM0I7O0FBQ0EsTUFBTTtBQUFFTyxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBc0NSLE9BQU8sQ0FBQyxjQUFELENBQW5EOztBQUNBLE1BQU1TLEtBQUssR0FBR1QsT0FBTyxDQUFDLGFBQUQsQ0FBckI7O0FBS0EsTUFBTVUsZ0JBQU4sU0FBK0JKLFdBQS9CLENBQTJDO0FBSXZDLGFBQVdLLGdCQUFYLEdBQThCO0FBQzFCLFFBQUlDLE1BQU0s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QW1Cd0o7QUFBckIsV0FBbEIsR0FBb0QsRUFBeEQ7QUFBWCxTQUFuQixFQUE2Rm5ILE9BQU8sQ0FBQ0ssT0FBckcsRUFBOEdMLE9BQU8sQ0FBQ00sV0FBdEgsQ0FBZixDQUFqQjtBQUNILE9BSkQsTUFJTyxJQUFJLENBQUMxRCxDQUFDLENBQUN1RSxhQUFGLENBQWdCeUYsSUFBaEIsQ0FBTCxFQUE0QjtBQUMvQixZQUFJM0gsS0FBSyxDQUFDQyxPQUFOLENBQWMwSCxJQUFkLENBQUosRUFBeUI7QUFDckIsZ0JBQU0sSUFBSXpKLGFBQUosQ0FBbUIsc0NBQXFDaUssU0FBUyxDQUFDbEgsTUFBTywwQkFBeUIsS0FBSzFDLElBQUwsQ0FBVWEsSUFBSyxzQ0FBcUNpSCxNQUFPLG1DQUE3SixDQUFOO0FBQ0g7O0FBRUQsWUFBSSxDQUFDOEIsU0FBUyxDQUFDdkUsS0FBZixFQUFzQjtBQUNsQixnQkFBTSxJQUFJM0YsZ0JBQUosQ0FBc0IscUNBQW9Db0ksTUFBTywyQ0FBakUsQ0FBTjtBQUNIOztBQUVEc0IsUUFBQUEsSUFBSSxHQUFHO0FBQUUsV0FBQ1EsU0FBUyxDQUFDdkUsS0FBWCxHQUFtQitEO0FBQXJCLFNBQVA7QUFDSDs7QUFFRCxhQUFPUyxVQUFVLENBQUM3SCxPQUFYLENBQW1CLEVBQUUsR0FBR29ILElBQUw7QUFBVyxZQUFJUSxTQUFTLENBQUN6SixLQUFWLEdBQWtCO0FBQUUsV0FBQ3lKLFNBQVMsQ0FBQ3pKLEtBQVgsR0FBbUJ3SjtBQUFyQixTQUFsQixHQUFvRCxFQUF4RDtBQUFYLE9BQW5CLEVBQTZGbkgsT0FBTyxDQUFDSyxPQUFyRyxFQUE4R0wsT0FBTyxDQUFDTSxXQUF0SCxDQUFQO0FBQ0gsS0F6QmdCLENBQWpCO0FBMEJIOztBQXppQnNDOztBQTRpQjNDa0gsTUFBTSxDQUFDQyxPQUFQLEdBQWlCcEssZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBnZXRWYWx1ZUJ5UGF0aCwgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5cbmNvbnN0IHsgRGF0ZVRpbWUgfSA9IHJlcXVpcmUoJ2x1eG9uJyk7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoJy4uLy4uL0VudGl0eU1vZGVsJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgIFxuICAgIC8qKlxuICAgICAqIFtzcGVjaWZpY10gQ2hlY2sgaWYgdGhpcyBlbnRpdHkgaGFzIGF1dG8gaW5jcmVtZW50IGZlYXR1cmUuXG4gICAgICovXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5T2JqIFxuICAgICAqIEBwYXJhbSB7Kn0ga2V5UGF0aCBcbiAgICAgKi9cbiAgICBzdGF0aWMgZ2V0TmVzdGVkT2JqZWN0KGVudGl0eU9iaiwga2V5UGF0aCkge1xuICAgICAgICByZXR1cm4gZ2V0VmFsdWVCeVBhdGgoZW50aXR5T2JqLCBrZXlQYXRoLnNwbGl0KCcuJykubWFwKHAgPT4gJzonK3ApLmpvaW4oJy4nKSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogW292ZXJyaWRlXSBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFtvdmVycmlkZV1cbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqL1xuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBbb3ZlcnJpZGVdXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0geyp9IGluZm8gXG4gICAgICovXG4gICAgc3RhdGljIF9zZXJpYWxpemVCeVR5cGVJbmZvKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnICYmIHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKCdUaGUgZW50aXR5IHRvIGJlIHVwZGF0ZWQgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcbiAgICAgICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCB7IC4uLmNvbnRleHQub3B0aW9ucywgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnZhbHVlT2ZLZXkoZW50aXR5KSB9IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgeyAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfSAgICAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cbiAgICBcbiAgICAvKipcbiAgICAgKiBQb3N0IGNyZWF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBDcmVhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSBjcmVhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICAgICAgbGV0IHsgaW5zZXJ0SWQgfSA9IGNvbnRleHQucmVzdWx0O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB7IFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXTogaW5zZXJ0SWQgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHRoaXMuZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20oY29udGV4dC5sYXRlc3QpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSA/IGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkIDoge307XG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5xdWVyeUtleSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICAgICAgY29udGV4dC5xdWVyeUtleSA9IHsgW3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdOiBpbnNlcnRJZCB9O1xuICAgICAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0geyAuLi5jb250ZXh0LnJldHVybiwgLi4uY29udGV4dC5xdWVyeUtleSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9pbnRlcm5hbEJlZm9yZVVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgX2ludGVybmFsQmVmb3JlVXBkYXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQub3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxBZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJGJ5cGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlwYXNzRW5zdXJlVW5pcXVlID0gY29udGV4dC5vcHRpb25zLiRieXBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsIC4uLmNvbmRpdGlvbiB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQucmV0dXJuKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC5vcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGNvbnRleHQucXVlcnlLZXkgPSBjb250ZXh0Lm9wdGlvbnMuJHF1ZXJ5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5vcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBfaW50ZXJuYWxCZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQub3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmVuc3VyZVRyYW5zYWN0aW9uXyhjb250ZXh0KTsgXG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LnJldHVybiA9IGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQub3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2ludGVybmFsQmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5vcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZW5zdXJlVHJhbnNhY3Rpb25fKGNvbnRleHQpOyBcblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0Lm9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQucmV0dXJuID0gY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5vcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZV8oY29udGV4dCkge1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqL1xuICAgIHN0YXRpYyBfaW50ZXJuYWxBZnRlckRlbGV0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5tb2RlbC5fcHJlcGFyZVF1ZXJpZXMoeyAuLi5hc3NvYy5kYXRhc2V0LCAkdmFyaWFibGVzOiBmaW5kT3B0aW9ucy4kdmFyaWFibGVzIH0pXG4gICAgICAgICAgICAgICAgICAgICAgICApIDoge30pICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSk7ICAgICAgICBcblxuICAgICAgICByZXR1cm4gYXNzb2NUYWJsZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jVGFibGUgLSBIaWVyYXJjaHkgd2l0aCBzdWJBc3NvY3NcbiAgICAgKiBAcGFyYW0geyp9IGNhY2hlIC0gRG90dGVkIHBhdGggYXMga2V5XG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyAtIERvdHRlZCBwYXRoXG4gICAgICovXG4gICAgc3RhdGljIF9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jKSB7XG4gICAgICAgIGlmIChjYWNoZVthc3NvY10pIHJldHVybiBjYWNoZVthc3NvY107XG5cbiAgICAgICAgbGV0IGxhc3RQb3MgPSBhc3NvYy5sYXN0SW5kZXhPZignLicpOyAgICAgICAgXG4gICAgICAgIGxldCByZXN1bHQ7ICBcblxuICAgICAgICBpZiAobGFzdFBvcyA9PT0gLTEpIHsgICAgICAgICBcbiAgICAgICAgICAgIC8vZGlyZWN0IGFzc29jaWF0aW9uXG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi50aGlzLm1ldGEuYXNzb2NpYXRpb25zW2Fzc29jXSB9OyAgIFxuICAgICAgICAgICAgaWYgKF8uaXNFbXB0eShhc3NvY0luZm8pKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEVudGl0eSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJlc3VsdCA9IGNhY2hlW2Fzc29jXSA9IGFzc29jVGFibGVbYXNzb2NdID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgYmFzZSA9IGFzc29jLnN1YnN0cigwLCBsYXN0UG9zKTtcbiAgICAgICAgICAgIGxldCBsYXN0ID0gYXNzb2Muc3Vic3RyKGxhc3RQb3MrMSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpOyAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV1cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogbGlzdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqIF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpXG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pOyAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09ICdBJykge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGUgXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsIFxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpXG4gICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICBsZXQgcmF3ID0ge30sIGFzc29jcyA9IHt9O1xuICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoJzonKSkge1xuICAgICAgICAgICAgICAgIGFzc29jc1trLnN1YnN0cigxKV0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBbIHJhdywgYXNzb2NzIF07ICAgICAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5yZXR1cm5bdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQub3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19