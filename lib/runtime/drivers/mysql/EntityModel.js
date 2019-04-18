"use strict";

require("source-map-support/register");

const Util = require('rk-utils');

const {
  _,
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

  static _serializeByType(value, info) {
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
        throw new BusinessError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
      } else if (errorCode === 'ER_DUP_ENTRY') {
        throw new BusinessError(error.message + ` while updating an existing "${this.meta.name}".`);
      }

      throw error;
    }
  }

  static async _doReplaceOne_(context) {
    if (!context.connOptions || !context.connOptions.connection) {
      context.connOptions || (context.connOptions = {});
      context.connOptions.connection = await this.db.connector.beginTransaction_();
    }

    let entity = await this.findOne_({
      $query: context.updateOptions.$query
    }, context.connOptions);

    if (entity) {
      return this.updateOne_(context.raw, { ...context.updateOptions,
        $query: {
          [this.meta.keyField]: this.valueOfKey(entity)
        }
      }, context.connOptions);
    } else {
      return this.create_(context.raw, {
        $retrieveCreated: context.updateOptions.$retrieveUpdated
      }, context.connOptions);
    }
  }

  static async beforeCreate_(context) {
    return true;
  }

  static async afterCreate_(context) {
    if (this.hasAutoIncrement) {
      let {
        insertId
      } = context.result;
      context.latest[this.meta.features.autoId.field] = insertId;
    }

    if (context.createOptions.$retrieveCreated) {
      let condition = this.getUniqueKeyValuePairsFrom(context.latest);
      let retrieveOptions = _.isPlainObject(context.createOptions.$retrieveCreated) ? context.createOptions.$retrieveCreated : {};
      context.latest = await this.findOne_({ ...retrieveOptions,
        $query: condition
      }, context.connOptions);
    }

    return true;
  }

  static async afterUpdate_(context) {
    if (context.updateOptions.$retrieveUpdated) {
      let condition = {
        $query: context.updateOptions.$query
      };

      if (context.updateOptions.$byPassEnsureUnique) {
        condition.$byPassEnsureUnique = context.updateOptions.$byPassEnsureUnique;
      }

      let retrieveOptions = {};

      if (_.isPlainObject(context.updateOptions.$retrieveUpdated)) {
        retrieveOptions = context.updateOptions.$retrieveUpdated;
      } else if (context.updateOptions.$relationships) {
        retrieveOptions.$relationships = context.updateOptions.$relationships;
      }

      context.latest = await this.findOne_({ ...retrieveOptions,
        ...condition
      }, context.connOptions);
    }

    return true;
  }

  static async afterUpdateMany_(context) {
    if (context.updateOptions.$retrieveUpdated) {
      let retrieveOptions = {};

      if (_.isPlainObject(context.updateOptions.$retrieveUpdated)) {
        retrieveOptions = context.updateOptions.$retrieveUpdated;
      } else if (context.updateOptions.$relationships) {
        retrieveOptions.$relationships = context.updateOptions.$relationships;
      }

      context.latest = await this.findAll_({ ...retrieveOptions,
        $query: context.updateOptions.$query
      }, context.connOptions);
    }

    return true;
  }

  static async afterDelete_(context) {
    return true;
  }

  static async afterDeleteMany_(context) {
    return true;
  }

  static async afterFindAll_(context, records) {
    if (context.findOptions.$toDictionary) {
      let keyField = this.meta.keyField;

      if (typeof context.findOptions.$toDictionary === 'string') {
        keyField = context.findOptions.$toDictionary;

        if (!(keyField in this.meta.fields)) {
          throw new OolongUsageError(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`);
        }
      }

      return records.reduce((table, v) => {
        table[v[keyField]] = v;
        return table;
      }, {});
    }

    return records;
  }

  static async beforeDelete_(context) {
    if (context.deleteOptions.$retrieveDeleted) {
      if (!context.connOptions || !context.connOptions.connection) {
        context.connOptions || (context.connOptions = {});
        context.connOptions.connection = await this.db.connector.beginTransaction_();
      }

      let retrieveOptions = _.isPlainObject(context.deleteOptions.$retrieveDeleted) ? context.deleteOptions.$retrieveDeleted : {};
      context.existing = await this.findOne_({ ...retrieveOptions,
        $query: context.deleteOptions.$query
      }, context.connOptions);
    }
  }

  static async beforeDeleteMany_(context) {
    if (context.deleteOptions.$retrieveDeleted) {
      if (!context.connOptions || !context.connOptions.connection) {
        context.connOptions || (context.connOptions = {});
        context.connOptions.connection = await this.db.connector.beginTransaction_();
      }

      let retrieveOptions = _.isPlainObject(context.deleteOptions.$retrieveDeleted) ? context.deleteOptions.$retrieveDeleted : {};
      context.existing = await this.findAll_({ ...retrieveOptions,
        $query: context.deleteOptions.$query
      }, context.connOptions);
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
          ...(assoc.dataset ? this.db.connector.buildQuery(assoc.entity, this._prepareQueries({ ...assoc.dataset,
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
    let keyValue = context.latest[this.meta.keyField];

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
        }, context.createOptions, context.connOptions));
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
      }, context.createOptions, context.connOptions);
    });
  }

}

module.exports = MySQLEntityModel;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiVHlwZXMiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwibmFtZSIsImRiIiwiY29ubmVjdG9yIiwicmF3IiwiRXJyb3IiLCJfc2VyaWFsaXplIiwidmFsdWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJfc2VyaWFsaXplQnlUeXBlIiwiaW5mbyIsInR5cGUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2Iiwic2VyaWFsaXplIiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImNvbm5PcHRpb25zIiwiY29ubmVjdGlvbiIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJ1cGRhdGVPcHRpb25zIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJiZWZvcmVDcmVhdGVfIiwiYWZ0ZXJDcmVhdGVfIiwiaW5zZXJ0SWQiLCJyZXN1bHQiLCJsYXRlc3QiLCJjcmVhdGVPcHRpb25zIiwiY29uZGl0aW9uIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwiYWZ0ZXJVcGRhdGVfIiwiJGJ5UGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiYWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsImFmdGVyRmluZEFsbF8iLCJyZWNvcmRzIiwiZmluZE9wdGlvbnMiLCIkdG9EaWN0aW9uYXJ5IiwicmVkdWNlIiwidGFibGUiLCJ2IiwiYmVmb3JlRGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJiZWZvcmVEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwic2NoZW1hTmFtZSIsImFsaWFzIiwiam9pblR5cGUiLCJvdXRwdXQiLCJrZXkiLCJvbiIsImRhdGFzZXQiLCJidWlsZFF1ZXJ5IiwiX3ByZXBhcmVRdWVyaWVzIiwiJHZhcmlhYmxlcyIsIl9sb2FkQXNzb2NJbnRvVGFibGUiLCJsYXN0UG9zIiwibGFzdEluZGV4T2YiLCJhc3NvY0luZm8iLCJpc0VtcHR5IiwiYmFzZSIsInN1YnN0ciIsImxhc3QiLCJiYXNlTm9kZSIsIm1vZGVsIiwic3ViQXNzb2NzIiwiY3VycmVudERiIiwiaW5kZXhPZiIsImVudGl0eU5hbWUiLCJzcGxpdCIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJtYWluSW5kZXgiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0IiwiZWFjaCIsInNxbCIsImxpc3QiLCJhbmNob3IiLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5IiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInB1c2giLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwiY29sIiwiYnVja2V0Iiwibm9kZVBhdGgiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJrIiwic3RhcnRzV2l0aCIsIl9jcmVhdGVBc3NvY3NfIiwia2V5VmFsdWUiLCJhc3NvY01ldGEiLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsY0FBTDtBQUFxQkMsRUFBQUE7QUFBckIsSUFBb0NKLElBQTFDOztBQUVBLE1BQU07QUFBRUssRUFBQUE7QUFBRixJQUFlSixPQUFPLENBQUMsT0FBRCxDQUE1Qjs7QUFDQSxNQUFNSyxXQUFXLEdBQUdMLE9BQU8sQ0FBQyxtQkFBRCxDQUEzQjs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFzQ1AsT0FBTyxDQUFDLGNBQUQsQ0FBbkQ7O0FBQ0EsTUFBTVEsS0FBSyxHQUFHUixPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFLQSxNQUFNUyxnQkFBTixTQUErQkosV0FBL0IsQ0FBMkM7QUFDdkMsYUFBV0ssZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBaEM7QUFDQSxXQUFPQSxNQUFNLElBQUksS0FBS0MsSUFBTCxDQUFVRSxNQUFWLENBQWlCSCxNQUFNLENBQUNJLEtBQXhCLEVBQStCQyxlQUFoRDtBQUNIOztBQU1ELFNBQU9DLHFCQUFQLENBQTZCQyxJ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U0FBbEIsR0FBb0QsRUFBeEQ7QUFBWCxPQUFuQixFQUE2RnRILE9BQU8sQ0FBQ2lCLGFBQXJHLEVBQW9IakIsT0FBTyxDQUFDQyxXQUE1SCxDQUFQO0FBQ0gsS0F6QmdCLENBQWpCO0FBMEJIOztBQXRpQnNDOztBQXlpQjNDMEgsTUFBTSxDQUFDQyxPQUFQLEdBQWlCaEssZ0JBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBzZXRWYWx1ZUJ5UGF0aCwgZWFjaEFzeW5jXyB9ID0gVXRpbDtcblxuY29uc3QgeyBEYXRlVGltZSB9ID0gcmVxdWlyZSgnbHV4b24nKTtcbmNvbnN0IEVudGl0eU1vZGVsID0gcmVxdWlyZSgnLi4vLi4vRW50aXR5TW9kZWwnKTtcbmNvbnN0IHsgT29sb25nVXNhZ2VFcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gcmVxdWlyZSgnLi4vLi4vRXJyb3JzJyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uL3R5cGVzJyk7XG5cbi8qKlxuICogTXlTUUwgZW50aXR5IG1vZGVsIGNsYXNzLlxuICovXG5jbGFzcyBNeVNRTEVudGl0eU1vZGVsIGV4dGVuZHMgRW50aXR5TW9kZWwgeyAgICBcbiAgICBzdGF0aWMgZ2V0IGhhc0F1dG9JbmNyZW1lbnQoKSB7XG4gICAgICAgIGxldCBhdXRvSWQgPSB0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkO1xuICAgICAgICByZXR1cm4gYXV0b0lkICYmIHRoaXMubWV0YS5maWVsZHNbYXV0b0lkLmZpZWxkXS5hdXRvSW5jcmVtZW50SWQ7ICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNlcmlhbGl6ZSB2YWx1ZSBpbnRvIGRhdGFiYXNlIGFjY2VwdGFibGUgZm9ybWF0LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBuYW1lIC0gTmFtZSBvZiB0aGUgc3ltYm9sIHRva2VuIFxuICAgICAqL1xuICAgIHN0YXRpYyBfdHJhbnNsYXRlU3ltYm9sVG9rZW4obmFtZSkge1xuICAgICAgICBpZiAobmFtZSA9PT0gJ25vdycpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRiLmNvbm5lY3Rvci5yYXcoJ05PVygpJyk7XG4gICAgICAgIH0gXG4gICAgICAgIFxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ25vdCBzdXBwb3J0Jyk7XG4gICAgfVxuXG4gICAgc3RhdGljIF9zZXJpYWxpemUodmFsdWUpIHtcbiAgICAgICAgaWYgKHR5cGVvZiB2YWx1ZSA9PT0gJ2Jvb2xlYW4nKSByZXR1cm4gdmFsdWUgPyAxIDogMDtcblxuICAgICAgICBpZiAodmFsdWUgaW5zdGFuY2VvZiBEYXRlVGltZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlLnRvSVNPKHsgaW5jbHVkZU9mZnNldDogZmFsc2UgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdmFsdWU7XG4gICAgfSAgICBcblxuICAgIHN0YXRpYyBfc2VyaWFsaXplQnlUeXBlKHZhbHVlLCBpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnICYmIHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2FycmF5JyAmJiBBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKGluZm8uY3N2KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnRvQ3N2KHZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIFR5cGVzLkFSUkFZLnNlcmlhbGl6ZSh2YWx1ZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnb2JqZWN0Jykge1xuICAgICAgICAgICAgcmV0dXJuIFR5cGVzLk9CSkVDVC5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgYXN5bmMgY3JlYXRlXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIuY3JlYXRlXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgY3JlYXRpbmcgYSBuZXcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyB1cGRhdGVPbmVfKC4uLmFyZ3MpIHtcbiAgICAgICAgdHJ5IHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBhd2FpdCBzdXBlci51cGRhdGVPbmVfKC4uLmFyZ3MpO1xuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgICAgICAgbGV0IGVycm9yQ29kZSA9IGVycm9yLmNvZGU7XG5cbiAgICAgICAgICAgIGlmIChlcnJvckNvZGUgPT09ICdFUl9OT19SRUZFUkVOQ0VEX1JPV18yJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKCdUaGUgbmV3IGVudGl0eSBpcyByZWZlcmVuY2luZyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eS4gRGV0YWlsOiAnICsgZXJyb3IubWVzc2FnZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX0RVUF9FTlRSWScpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihlcnJvci5tZXNzYWdlICsgYCB3aGlsZSB1cGRhdGluZyBhbiBleGlzdGluZyBcIiR7dGhpcy5tZXRhLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHRocm93IGVycm9yO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIF9kb1JlcGxhY2VPbmVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCBlbnRpdHkgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgJHF1ZXJ5OiBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChlbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnVwZGF0ZU9uZV8oY29udGV4dC5yYXcsIHsgLi4uY29udGV4dC51cGRhdGVPcHRpb25zLCAkcXVlcnk6IHsgW3RoaXMubWV0YS5rZXlGaWVsZF06IHRoaXMudmFsdWVPZktleShlbnRpdHkpIH0gfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVfKGNvbnRleHQucmF3LCB7ICRyZXRyaWV2ZUNyZWF0ZWQ6IGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIGFzeW5jIGJlZm9yZUNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgLyoqXG4gICAgICogUG9zdCBjcmVhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IFtjb250ZXh0LmNyZWF0ZU9wdGlvbnNdIC0gQ3JlYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW2NyZWF0ZU9wdGlvbnMuJHJldHJpZXZlQ3JlYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgY3JlYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyQ3JlYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICh0aGlzLmhhc0F1dG9JbmNyZW1lbnQpIHtcbiAgICAgICAgICAgIGxldCB7IGluc2VydElkIH0gPSBjb250ZXh0LnJlc3VsdDtcbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0W3RoaXMubWV0YS5mZWF0dXJlcy5hdXRvSWQuZmllbGRdID0gaW5zZXJ0SWQ7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoY29udGV4dC5jcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpIHtcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB0aGlzLmdldFVuaXF1ZUtleVZhbHVlUGFpcnNGcm9tKGNvbnRleHQubGF0ZXN0KTtcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5jcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQpID8gY29udGV4dC5jcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWQgOiB7fTtcbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb25kaXRpb24gfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQb3N0IHVwZGF0ZSBwcm9jZXNzaW5nLlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW3VwZGF0ZU9wdGlvbnNdIC0gVXBkYXRlIG9wdGlvbnMgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW3VwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZF0gLSBSZXRyaWV2ZSB0aGUgbmV3bHkgdXBkYXRlZCByZWNvcmQgZnJvbSBkYi4gXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyVXBkYXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCBjb25kaXRpb24gPSB7ICRxdWVyeTogY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSB9O1xuICAgICAgICAgICAgaWYgKGNvbnRleHQudXBkYXRlT3B0aW9ucy4kYnlQYXNzRW5zdXJlVW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgY29uZGl0aW9uLiRieVBhc3NFbnN1cmVVbmlxdWUgPSBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJGJ5UGFzc0Vuc3VyZVVuaXF1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgLi4uY29uZGl0aW9uIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZU1hbnlfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSB7ICAgIFxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkKSkge1xuICAgICAgICAgICAgICAgIHJldHJpZXZlT3B0aW9ucyA9IGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMgPSBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJlbGF0aW9uc2hpcHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQubGF0ZXN0ID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCBkZWxldGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgICAgICBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBhZnRlckZpbmRBbGxfKGNvbnRleHQsIHJlY29yZHMpIHtcbiAgICAgICAgaWYgKGNvbnRleHQuZmluZE9wdGlvbnMuJHRvRGljdGlvbmFyeSkge1xuICAgICAgICAgICAgbGV0IGtleUZpZWxkID0gdGhpcy5tZXRhLmtleUZpZWxkO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAodHlwZW9mIGNvbnRleHQuZmluZE9wdGlvbnMuJHRvRGljdGlvbmFyeSA9PT0gJ3N0cmluZycpIHsgXG4gICAgICAgICAgICAgICAga2V5RmllbGQgPSBjb250ZXh0LmZpbmRPcHRpb25zLiR0b0RpY3Rpb25hcnk7IFxuXG4gICAgICAgICAgICAgICAgaWYgKCEoa2V5RmllbGQgaW4gdGhpcy5tZXRhLmZpZWxkcykpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFRoZSBrZXkgZmllbGQgXCIke2tleUZpZWxkfVwiIHByb3ZpZGVkIHRvIGluZGV4IHRoZSBjYWNoZWQgZGljdGlvbmFyeSBpcyBub3QgYSBmaWVsZCBvZiBlbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIHJlY29yZHMucmVkdWNlKCh0YWJsZSwgdikgPT4ge1xuICAgICAgICAgICAgICAgIHRhYmxlW3Zba2V5RmllbGRdXSA9IHY7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRhYmxlO1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJldHVybiByZWNvcmRzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEJlZm9yZSBkZWxldGluZyBhbiBlbnRpdHkuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5kZWxldGVPcHRpb25zXSAtIERlbGV0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtkZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWRdIC0gUmV0cmlldmUgdGhlIHJlY2VudGx5IGRlbGV0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVfKGNvbnRleHQpIHtcbiAgICAgICAgaWYgKGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIWNvbnRleHQuY29ubk9wdGlvbnMgfHwgIWNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMgfHwgKGNvbnRleHQuY29ubk9wdGlvbnMgPSB7fSk7XG5cbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkKSA/IFxuICAgICAgICAgICAgICAgIGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkIDpcbiAgICAgICAgICAgICAgICB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29udGV4dC5leGlzdGluZyA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC5kZWxldGVPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVEZWxldGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRBbGxfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGZpbmRPcHRpb25zIFxuICAgICAqL1xuICAgIHN0YXRpYyBfcHJlcGFyZUFzc29jaWF0aW9ucyhmaW5kT3B0aW9ucykgeyBcbiAgICAgICAgbGV0IGFzc29jaWF0aW9ucyA9IF8udW5pcShmaW5kT3B0aW9ucy4kYXNzb2NpYXRpb24pLnNvcnQoKTsgICAgICAgIFxuICAgICAgICBsZXQgYXNzb2NUYWJsZSA9IHt9LCBjb3VudGVyID0gMCwgY2FjaGUgPSB7fTsgICAgICAgXG5cbiAgICAgICAgYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChhc3NvYykpIHtcbiAgICAgICAgICAgICAgICBhc3NvYyA9IHRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jLCB0aGlzLmRiLnNjaGVtYU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2MuYWxpYXM7XG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5hbGlhcykge1xuICAgICAgICAgICAgICAgICAgICBhbGlhcyA9ICc6am9pbicgKyArK2NvdW50ZXI7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NUYWJsZVthbGlhc10gPSB7IFxuICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGFzc29jLmVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIGpvaW5UeXBlOiBhc3NvYy50eXBlLCBcbiAgICAgICAgICAgICAgICAgICAgb3V0cHV0OiBhc3NvYy5vdXRwdXQsXG4gICAgICAgICAgICAgICAgICAgIGtleTogYXNzb2Mua2V5LFxuICAgICAgICAgICAgICAgICAgICBhbGlhcyxcbiAgICAgICAgICAgICAgICAgICAgb246IGFzc29jLm9uLFxuICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuZGF0YXNldCA/IHRoaXMuZGIuY29ubmVjdG9yLmJ1aWxkUXVlcnkoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcmVwYXJlUXVlcmllcyh7IC4uLmFzc29jLmRhdGFzZXQsICR2YXJpYWJsZXM6IGZpbmRPcHRpb25zLiR2YXJpYWJsZXMgfSlcbiAgICAgICAgICAgICAgICAgICAgICAgICkgOiB7fSkgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH07XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9KTsgICAgICAgIFxuXG4gICAgICAgIHJldHVybiBhc3NvY1RhYmxlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NUYWJsZSAtIEhpZXJhcmNoeSB3aXRoIHN1YkFzc29jc1xuICAgICAqIEBwYXJhbSB7Kn0gY2FjaGUgLSBEb3R0ZWQgcGF0aCBhcyBrZXlcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIC0gRG90dGVkIHBhdGhcbiAgICAgKi9cbiAgICBzdGF0aWMgX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYXNzb2MpIHtcbiAgICAgICAgaWYgKGNhY2hlW2Fzc29jXSkgcmV0dXJuIGNhY2hlW2Fzc29jXTtcblxuICAgICAgICBsZXQgbGFzdFBvcyA9IGFzc29jLmxhc3RJbmRleE9mKCcuJyk7ICAgICAgICBcbiAgICAgICAgbGV0IHJlc3VsdDsgIFxuXG4gICAgICAgIGlmIChsYXN0UG9zID09PSAtMSkgeyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPSB7IC4uLnRoaXMubWV0YS5hc3NvY2lhdGlvbnNbYXNzb2NdIH07ICAgXG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgRW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIiBkb2VzIG5vdCBoYXZlIHRoZSBhc3NvY2lhdGlvbiBcIiR7YXNzb2N9XCIuYClcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmVzdWx0ID0gY2FjaGVbYXNzb2NdID0gYXNzb2NUYWJsZVthc3NvY10gPSB7IC4uLnRoaXMuX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiKGFzc29jSW5mbykgfTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBiYXNlID0gYXNzb2Muc3Vic3RyKDAsIGxhc3RQb3MpO1xuICAgICAgICAgICAgbGV0IGxhc3QgPSBhc3NvYy5zdWJzdHIobGFzdFBvcysxKTsgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBiYXNlTm9kZSA9IGNhY2hlW2Jhc2VdO1xuICAgICAgICAgICAgaWYgKCFiYXNlTm9kZSkgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBiYXNlTm9kZSA9IHRoaXMuX2xvYWRBc3NvY0ludG9UYWJsZShhc3NvY1RhYmxlLCBjYWNoZSwgYmFzZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBiYXNlTm9kZS5tb2RlbCB8fCB0aGlzLmRiLm1vZGVsKGJhc2VOb2RlLmVudGl0eSk7XG4gICAgICAgICAgICBsZXQgYXNzb2NJbmZvID0geyAuLi5lbnRpdHkubWV0YS5hc3NvY2lhdGlvbnNbbGFzdF0gfTtcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGBFbnRpdHkgXCIke2VudGl0eS5tZXRhLm5hbWV9XCIgZG9lcyBub3QgaGF2ZSB0aGUgYXNzb2NpYXRpb24gXCIke2Fzc29jfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQgPSB7IC4uLmVudGl0eS5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvLCB0aGlzLmRiKSB9O1xuXG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlLnN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgIGJhc2VOb2RlLnN1YkFzc29jcyA9IHt9O1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgY2FjaGVbYXNzb2NdID0gYmFzZU5vZGUuc3ViQXNzb2NzW2xhc3RdID0gcmVzdWx0O1xuICAgICAgICB9ICAgICAgXG5cbiAgICAgICAgaWYgKHJlc3VsdC5hc3NvYykge1xuICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyArICcuJyArIHJlc3VsdC5hc3NvYyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBfdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2MsIGN1cnJlbnREYikge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG4gICAgICAgICAgICBhc3NvYy5tb2RlbCA9IHJlZkRiLm1vZGVsKGVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBpZiAoIWFzc29jLm1vZGVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEZhaWxlZCBsb2FkIHRoZSBlbnRpdHkgbW9kZWwgXCIke3NjaGVtYU5hbWV9LiR7ZW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGFzc29jLm1vZGVsID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpOyAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY3VycmVudERiICYmIGN1cnJlbnREYiAhPT0gdGhpcy5kYikge1xuICAgICAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHRoaXMuZGIuY29ubmVjdG9yLmRhdGFiYXNlICsgJy4nICsgYXNzb2MuZW50aXR5O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFhc3NvYy5rZXkpIHtcbiAgICAgICAgICAgIGFzc29jLmtleSA9IGFzc29jLm1vZGVsLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV1cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogbGlzdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqIF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpXG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pOyAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09ICdBJykge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGUgXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsIFxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpXG4gICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICBsZXQgcmF3ID0ge30sIGFzc29jcyA9IHt9O1xuICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoJzonKSkge1xuICAgICAgICAgICAgICAgIGFzc29jc1trLnN1YnN0cigxKV0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBbIHJhdywgYXNzb2NzIF07ICAgICAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5sYXRlc3RbdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQuY3JlYXRlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQuY3JlYXRlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19