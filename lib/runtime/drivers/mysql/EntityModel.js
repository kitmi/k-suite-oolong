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
        assoc = this._translateSchemaNameToDb(assoc);
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

      let entity = this.db.model(baseNode.entity);
      let assocInfo = { ...entity.meta.associations[last]
      };

      if (_.isEmpty(assocInfo)) {
        throw new BusinessError(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
      }

      result = { ...this._translateSchemaNameToDb(assocInfo)
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

  static _translateSchemaNameToDb(assoc) {
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

      if (!assoc.key) {
        let model = refDb.model(entityName);

        if (!model) {
          throw new OolongUsageError(`Failed load the entity model "${schemaName}.${entityName}".`);
        }

        assoc.key = model.meta.keyField;
      }
    } else if (!assoc.key) {
      assoc.key = this.db.model(assoc.entity).meta.keyField;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvRW50aXR5TW9kZWwuanMiXSwibmFtZXMiOlsiVXRpbCIsInJlcXVpcmUiLCJfIiwic2V0VmFsdWVCeVBhdGgiLCJlYWNoQXN5bmNfIiwiRGF0ZVRpbWUiLCJFbnRpdHlNb2RlbCIsIk9vbG9uZ1VzYWdlRXJyb3IiLCJCdXNpbmVzc0Vycm9yIiwiVHlwZXMiLCJNeVNRTEVudGl0eU1vZGVsIiwiaGFzQXV0b0luY3JlbWVudCIsImF1dG9JZCIsIm1ldGEiLCJmZWF0dXJlcyIsImZpZWxkcyIsImZpZWxkIiwiYXV0b0luY3JlbWVudElkIiwiX3RyYW5zbGF0ZVN5bWJvbFRva2VuIiwibmFtZSIsImRiIiwiY29ubmVjdG9yIiwicmF3IiwiRXJyb3IiLCJfc2VyaWFsaXplIiwidmFsdWUiLCJ0b0lTTyIsImluY2x1ZGVPZmZzZXQiLCJfc2VyaWFsaXplQnlUeXBlIiwiaW5mbyIsInR5cGUiLCJBcnJheSIsImlzQXJyYXkiLCJjc3YiLCJBUlJBWSIsInRvQ3N2Iiwic2VyaWFsaXplIiwiT0JKRUNUIiwiY3JlYXRlXyIsImFyZ3MiLCJlcnJvciIsImVycm9yQ29kZSIsImNvZGUiLCJtZXNzYWdlIiwidXBkYXRlT25lXyIsIl9kb1JlcGxhY2VPbmVfIiwiY29udGV4dCIsImNvbm5PcHRpb25zIiwiY29ubmVjdGlvbiIsImJlZ2luVHJhbnNhY3Rpb25fIiwiZW50aXR5IiwiZmluZE9uZV8iLCIkcXVlcnkiLCJ1cGRhdGVPcHRpb25zIiwia2V5RmllbGQiLCJ2YWx1ZU9mS2V5IiwiJHJldHJpZXZlQ3JlYXRlZCIsIiRyZXRyaWV2ZVVwZGF0ZWQiLCJiZWZvcmVDcmVhdGVfIiwiYWZ0ZXJDcmVhdGVfIiwiaW5zZXJ0SWQiLCJyZXN1bHQiLCJsYXRlc3QiLCJjcmVhdGVPcHRpb25zIiwiY29uZGl0aW9uIiwiZ2V0VW5pcXVlS2V5VmFsdWVQYWlyc0Zyb20iLCJyZXRyaWV2ZU9wdGlvbnMiLCJpc1BsYWluT2JqZWN0IiwiYWZ0ZXJVcGRhdGVfIiwiJGJ5UGFzc0Vuc3VyZVVuaXF1ZSIsIiRyZWxhdGlvbnNoaXBzIiwiYWZ0ZXJVcGRhdGVNYW55XyIsImZpbmRBbGxfIiwiYWZ0ZXJEZWxldGVfIiwiYWZ0ZXJEZWxldGVNYW55XyIsImFmdGVyRmluZEFsbF8iLCJyZWNvcmRzIiwiZmluZE9wdGlvbnMiLCIkdG9EaWN0aW9uYXJ5IiwicmVkdWNlIiwidGFibGUiLCJ2IiwiYmVmb3JlRGVsZXRlXyIsImRlbGV0ZU9wdGlvbnMiLCIkcmV0cmlldmVEZWxldGVkIiwiZXhpc3RpbmciLCJiZWZvcmVEZWxldGVNYW55XyIsIl9wcmVwYXJlQXNzb2NpYXRpb25zIiwiYXNzb2NpYXRpb25zIiwidW5pcSIsIiRhc3NvY2lhdGlvbiIsInNvcnQiLCJhc3NvY1RhYmxlIiwiY291bnRlciIsImNhY2hlIiwiZm9yRWFjaCIsImFzc29jIiwiX3RyYW5zbGF0ZVNjaGVtYU5hbWVUb0RiIiwiYWxpYXMiLCJqb2luVHlwZSIsIm91dHB1dCIsImtleSIsIm9uIiwiZGF0YXNldCIsImJ1aWxkUXVlcnkiLCJfcHJlcGFyZVF1ZXJpZXMiLCIkdmFyaWFibGVzIiwiX2xvYWRBc3NvY0ludG9UYWJsZSIsImxhc3RQb3MiLCJsYXN0SW5kZXhPZiIsImFzc29jSW5mbyIsImlzRW1wdHkiLCJiYXNlIiwic3Vic3RyIiwibGFzdCIsImJhc2VOb2RlIiwibW9kZWwiLCJzdWJBc3NvY3MiLCJpbmRleE9mIiwic2NoZW1hTmFtZSIsImVudGl0eU5hbWUiLCJzcGxpdCIsImFwcCIsInJlZkRiIiwiZGF0YWJhc2UiLCJfbWFwUmVjb3Jkc1RvT2JqZWN0cyIsInJvd3MiLCJjb2x1bW5zIiwiYWxpYXNNYXAiLCJoaWVyYXJjaHkiLCJtYWluSW5kZXgiLCJtZXJnZVJlY29yZCIsImV4aXN0aW5nUm93Iiwicm93T2JqZWN0IiwiZWFjaCIsInNxbCIsImxpc3QiLCJhbmNob3IiLCJvYmpLZXkiLCJzdWJPYmoiLCJzdWJJbmRleGVzIiwicm93S2V5IiwiaXNOaWwiLCJleGlzdGluZ1N1YlJvdyIsInB1c2giLCJzdWJJbmRleCIsImJ1aWxkU3ViSW5kZXhlcyIsImluZGV4ZXMiLCJzdWJPYmplY3QiLCJhcnJheU9mT2JqcyIsInJvdyIsImkiLCJ0YWJsZUNhY2hlIiwiY29sIiwiYnVja2V0Iiwibm9kZVBhdGgiLCJfZXh0cmFjdEFzc29jaWF0aW9ucyIsImRhdGEiLCJhc3NvY3MiLCJmb3JPd24iLCJrIiwic3RhcnRzV2l0aCIsIl9jcmVhdGVBc3NvY3NfIiwia2V5VmFsdWUiLCJhc3NvY01ldGEiLCJhc3NvY01vZGVsIiwiY2FzdEFycmF5IiwiaXRlbSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsSUFBSSxHQUFHQyxPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsY0FBTDtBQUFxQkMsRUFBQUE7QUFBckIsSUFBb0NKLElBQTFDOztBQUVBLE1BQU07QUFBRUssRUFBQUE7QUFBRixJQUFlSixPQUFPLENBQUMsT0FBRCxDQUE1Qjs7QUFDQSxNQUFNSyxXQUFXLEdBQUdMLE9BQU8sQ0FBQyxtQkFBRCxDQUEzQjs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFzQ1AsT0FBTyxDQUFDLGNBQUQsQ0FBbkQ7O0FBQ0EsTUFBTVEsS0FBSyxHQUFHUixPQUFPLENBQUMsYUFBRCxDQUFyQjs7QUFLQSxNQUFNUyxnQkFBTixTQUErQkosV0FBL0IsQ0FBMkM7QUFDdkMsYUFBV0ssZ0JBQVgsR0FBOEI7QUFDMUIsUUFBSUMsTUFBTSxHQUFHLEtBQUtDLElBQUwsQ0FBVUMsUUFBVixDQUFtQkYsTUFBaEM7QUFDQSxXQUFPQSxNQUFNLElBQUksS0FBS0MsSUFBTCxDQUFVRSxNQUFWLENBQWlCSCxNQUFNLENBQUNJLEtBQXhCLEVBQStCQyxlQUFoRDtBQUNIOztBQU1ELFNBQU9DLHFCQUFQLENBQTZCQyxJQUE3QixFQUFtQztB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R0FBb0QsRUFBeEQ7QUFBWCxTQUFuQixFQUE2RnJILE9BQU8sQ0FBQ2lCLGFBQXJHLEVBQW9IakIsT0FBTyxDQUFDQyxXQUE1SCxDQUFmLENBQWpCO0FBQ0gsT0FKRCxNQUlPLElBQUksQ0FBQzdDLENBQUMsQ0FBQ2lFLGFBQUYsQ0FBZ0IwRixJQUFoQixDQUFMLEVBQTRCO0FBQy9CLFlBQUk5SCxLQUFLLENBQUNDLE9BQU4sQ0FBYzZILElBQWQsQ0FBSixFQUF5QjtBQUNyQixnQkFBTSxJQUFJckosYUFBSixDQUFtQixzQ0FBcUM0SixTQUFTLENBQUNsSCxNQUFPLDBCQUF5QixLQUFLckMsSUFBTCxDQUFVTSxJQUFLLHNDQUFxQ3NILE1BQU8sbUNBQTdKLENBQU47QUFDSDs7QUFFRCxZQUFJLENBQUMyQixTQUFTLENBQUNwRSxLQUFmLEVBQXNCO0FBQ2xCLGdCQUFNLElBQUl6RixnQkFBSixDQUFzQixxQ0FBb0NrSSxNQUFPLDJDQUFqRSxDQUFOO0FBQ0g7O0FBRURvQixRQUFBQSxJQUFJLEdBQUc7QUFBRSxXQUFDTyxTQUFTLENBQUNwRSxLQUFYLEdBQW1CNkQ7QUFBckIsU0FBUDtBQUNIOztBQUVELGFBQU9RLFVBQVUsQ0FBQy9ILE9BQVgsQ0FBbUIsRUFBRSxHQUFHdUgsSUFBTDtBQUFXLFlBQUlPLFNBQVMsQ0FBQ3BKLEtBQVYsR0FBa0I7QUFBRSxXQUFDb0osU0FBUyxDQUFDcEosS0FBWCxHQUFtQm1KO0FBQXJCLFNBQWxCLEdBQW9ELEVBQXhEO0FBQVgsT0FBbkIsRUFBNkZySCxPQUFPLENBQUNpQixhQUFyRyxFQUFvSGpCLE9BQU8sQ0FBQ0MsV0FBNUgsQ0FBUDtBQUNILEtBekJnQixDQUFqQjtBQTBCSDs7QUFsaUJzQzs7QUFxaUIzQ3lILE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQi9KLGdCQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgc2V0VmFsdWVCeVBhdGgsIGVhY2hBc3luY18gfSA9IFV0aWw7XG5cbmNvbnN0IHsgRGF0ZVRpbWUgfSA9IHJlcXVpcmUoJ2x1eG9uJyk7XG5jb25zdCBFbnRpdHlNb2RlbCA9IHJlcXVpcmUoJy4uLy4uL0VudGl0eU1vZGVsJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi90eXBlcycpO1xuXG4vKipcbiAqIE15U1FMIGVudGl0eSBtb2RlbCBjbGFzcy5cbiAqL1xuY2xhc3MgTXlTUUxFbnRpdHlNb2RlbCBleHRlbmRzIEVudGl0eU1vZGVsIHsgICAgXG4gICAgc3RhdGljIGdldCBoYXNBdXRvSW5jcmVtZW50KCkge1xuICAgICAgICBsZXQgYXV0b0lkID0gdGhpcy5tZXRhLmZlYXR1cmVzLmF1dG9JZDtcbiAgICAgICAgcmV0dXJuIGF1dG9JZCAmJiB0aGlzLm1ldGEuZmllbGRzW2F1dG9JZC5maWVsZF0uYXV0b0luY3JlbWVudElkOyAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTZXJpYWxpemUgdmFsdWUgaW50byBkYXRhYmFzZSBhY2NlcHRhYmxlIGZvcm1hdC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gbmFtZSAtIE5hbWUgb2YgdGhlIHN5bWJvbCB0b2tlbiBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3RyYW5zbGF0ZVN5bWJvbFRva2VuKG5hbWUpIHtcbiAgICAgICAgaWYgKG5hbWUgPT09ICdub3cnKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kYi5jb25uZWN0b3IucmF3KCdOT1coKScpO1xuICAgICAgICB9IFxuICAgICAgICBcbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdub3Qgc3VwcG9ydCcpO1xuICAgIH1cblxuICAgIHN0YXRpYyBfc2VyaWFsaXplKHZhbHVlKSB7XG4gICAgICAgIGlmICh0eXBlb2YgdmFsdWUgPT09ICdib29sZWFuJykgcmV0dXJuIHZhbHVlID8gMSA6IDA7XG5cbiAgICAgICAgaWYgKHZhbHVlIGluc3RhbmNlb2YgRGF0ZVRpbWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZS50b0lTTyh7IGluY2x1ZGVPZmZzZXQ6IGZhbHNlIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgIH0gICAgXG5cbiAgICBzdGF0aWMgX3NlcmlhbGl6ZUJ5VHlwZSh2YWx1ZSwgaW5mbykge1xuICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZSA/IDEgOiAwO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJyAmJiB2YWx1ZSBpbnN0YW5jZW9mIERhdGVUaW1lKSB7XG4gICAgICAgICAgICByZXR1cm4gdmFsdWUudG9JU08oeyBpbmNsdWRlT2Zmc2V0OiBmYWxzZSB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdhcnJheScgJiYgQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmNzdikge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS50b0Nzdih2YWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHJldHVybiBUeXBlcy5BUlJBWS5zZXJpYWxpemUodmFsdWUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ29iamVjdCcpIHtcbiAgICAgICAgICAgIHJldHVybiBUeXBlcy5PQkpFQ1Quc2VyaWFsaXplKHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICB9ICAgIFxuXG4gICAgc3RhdGljIGFzeW5jIGNyZWF0ZV8oLi4uYXJncykge1xuICAgICAgICB0cnkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGF3YWl0IHN1cGVyLmNyZWF0ZV8oLi4uYXJncyk7XG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgICAgICBsZXQgZXJyb3JDb2RlID0gZXJyb3IuY29kZTtcblxuICAgICAgICAgICAgaWYgKGVycm9yQ29kZSA9PT0gJ0VSX05PX1JFRkVSRU5DRURfUk9XXzInKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoJ1RoZSBuZXcgZW50aXR5IGlzIHJlZmVyZW5jaW5nIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5LiBEZXRhaWw6ICcgKyBlcnJvci5tZXNzYWdlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoZXJyb3JDb2RlID09PSAnRVJfRFVQX0VOVFJZJykge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGVycm9yLm1lc3NhZ2UgKyBgIHdoaWxlIGNyZWF0aW5nIGEgbmV3IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgdGhyb3cgZXJyb3I7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgdXBkYXRlT25lXyguLi5hcmdzKSB7XG4gICAgICAgIHRyeSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gYXdhaXQgc3VwZXIudXBkYXRlT25lXyguLi5hcmdzKTtcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcbiAgICAgICAgICAgIGxldCBlcnJvckNvZGUgPSBlcnJvci5jb2RlO1xuXG4gICAgICAgICAgICBpZiAoZXJyb3JDb2RlID09PSAnRVJfTk9fUkVGRVJFTkNFRF9ST1dfMicpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcignVGhlIG5ldyBlbnRpdHkgaXMgcmVmZXJlbmNpbmcgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkuIERldGFpbDogJyArIGVycm9yLm1lc3NhZ2UpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChlcnJvckNvZGUgPT09ICdFUl9EVVBfRU5UUlknKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoZXJyb3IubWVzc2FnZSArIGAgd2hpbGUgdXBkYXRpbmcgYW4gZXhpc3RpbmcgXCIke3RoaXMubWV0YS5uYW1lfVwiLmApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB0aHJvdyBlcnJvcjtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBfZG9SZXBsYWNlT25lXyhjb250ZXh0KSB7XG4gICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24gPSBhd2FpdCB0aGlzLmRiLmNvbm5lY3Rvci5iZWdpblRyYW5zYWN0aW9uXygpOyAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5ID0gYXdhaXQgdGhpcy5maW5kT25lXyh7ICRxdWVyeTogY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcblxuICAgICAgICBpZiAoZW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy51cGRhdGVPbmVfKGNvbnRleHQucmF3LCB7IC4uLmNvbnRleHQudXBkYXRlT3B0aW9ucywgJHF1ZXJ5OiB7IFt0aGlzLm1ldGEua2V5RmllbGRdOiB0aGlzLnZhbHVlT2ZLZXkoZW50aXR5KSB9IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlXyhjb250ZXh0LnJhdywgeyAkcmV0cmlldmVDcmVhdGVkOiBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBhc3luYyBiZWZvcmVDcmVhdGVfKGNvbnRleHQpIHtcbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIFxuICAgIC8qKlxuICAgICAqIFBvc3QgY3JlYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBbY29udGV4dC5jcmVhdGVPcHRpb25zXSAtIENyZWF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtjcmVhdGVPcHRpb25zLiRyZXRyaWV2ZUNyZWF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IGNyZWF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlckNyZWF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAodGhpcy5oYXNBdXRvSW5jcmVtZW50KSB7XG4gICAgICAgICAgICBsZXQgeyBpbnNlcnRJZCB9ID0gY29udGV4dC5yZXN1bHQ7XG4gICAgICAgICAgICBjb250ZXh0LmxhdGVzdFt0aGlzLm1ldGEuZmVhdHVyZXMuYXV0b0lkLmZpZWxkXSA9IGluc2VydElkO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbnRleHQuY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSB7XG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0gdGhpcy5nZXRVbmlxdWVLZXlWYWx1ZVBhaXJzRnJvbShjb250ZXh0LmxhdGVzdCk7XG4gICAgICAgICAgICBsZXQgcmV0cmlldmVPcHRpb25zID0gXy5pc1BsYWluT2JqZWN0KGNvbnRleHQuY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkKSA/IGNvbnRleHQuY3JlYXRlT3B0aW9ucy4kcmV0cmlldmVDcmVhdGVkIDoge307XG4gICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29uZGl0aW9uIH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUG9zdCB1cGRhdGUgcHJvY2Vzc2luZy5cbiAgICAgKiBAcGFyYW0geyp9IGNvbnRleHQgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFt1cGRhdGVPcHRpb25zXSAtIFVwZGF0ZSBvcHRpb25zICAgICBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFt1cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWRdIC0gUmV0cmlldmUgdGhlIG5ld2x5IHVwZGF0ZWQgcmVjb3JkIGZyb20gZGIuIFxuICAgICAqL1xuICAgIHN0YXRpYyBhc3luYyBhZnRlclVwZGF0ZV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC51cGRhdGVPcHRpb25zLiRyZXRyaWV2ZVVwZGF0ZWQpIHsgICAgXG4gICAgICAgICAgICBsZXQgY29uZGl0aW9uID0geyAkcXVlcnk6IGNvbnRleHQudXBkYXRlT3B0aW9ucy4kcXVlcnkgfTtcbiAgICAgICAgICAgIGlmIChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJGJ5UGFzc0Vuc3VyZVVuaXF1ZSkge1xuICAgICAgICAgICAgICAgIGNvbmRpdGlvbi4kYnlQYXNzRW5zdXJlVW5pcXVlID0gY29udGV4dC51cGRhdGVPcHRpb25zLiRieVBhc3NFbnN1cmVVbmlxdWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC51cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC51cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGF3YWl0IHRoaXMuZmluZE9uZV8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsIC4uLmNvbmRpdGlvbiB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgdXBkYXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0IFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbdXBkYXRlT3B0aW9uc10gLSBVcGRhdGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbdXBkYXRlT3B0aW9ucy4kcmV0cmlldmVVcGRhdGVkXSAtIFJldHJpZXZlIHRoZSBuZXdseSB1cGRhdGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJVcGRhdGVNYW55Xyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkgeyAgICBcbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZCkpIHtcbiAgICAgICAgICAgICAgICByZXRyaWV2ZU9wdGlvbnMgPSBjb250ZXh0LnVwZGF0ZU9wdGlvbnMuJHJldHJpZXZlVXBkYXRlZDtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoY29udGV4dC51cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7XG4gICAgICAgICAgICAgICAgcmV0cmlldmVPcHRpb25zLiRyZWxhdGlvbnNoaXBzID0gY29udGV4dC51cGRhdGVPcHRpb25zLiRyZWxhdGlvbnNoaXBzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmxhdGVzdCA9IGF3YWl0IHRoaXMuZmluZEFsbF8oeyAuLi5yZXRyaWV2ZU9wdGlvbnMsICRxdWVyeTogY29udGV4dC51cGRhdGVPcHRpb25zLiRxdWVyeSB9LCBjb250ZXh0LmNvbm5PcHRpb25zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIHJldHVybiB0cnVlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBvc3QgZGVsZXRlIHByb2Nlc3NpbmcuXG4gICAgICogQHBhcmFtIHsqfSBjb250ZXh0ICAgICAgXG4gICAgICovXG4gICAgc3RhdGljIGFzeW5jIGFmdGVyRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICByZXR1cm4gdHJ1ZTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgYWZ0ZXJGaW5kQWxsXyhjb250ZXh0LCByZWNvcmRzKSB7XG4gICAgICAgIGlmIChjb250ZXh0LmZpbmRPcHRpb25zLiR0b0RpY3Rpb25hcnkpIHtcbiAgICAgICAgICAgIGxldCBrZXlGaWVsZCA9IHRoaXMubWV0YS5rZXlGaWVsZDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHR5cGVvZiBjb250ZXh0LmZpbmRPcHRpb25zLiR0b0RpY3Rpb25hcnkgPT09ICdzdHJpbmcnKSB7IFxuICAgICAgICAgICAgICAgIGtleUZpZWxkID0gY29udGV4dC5maW5kT3B0aW9ucy4kdG9EaWN0aW9uYXJ5OyBcblxuICAgICAgICAgICAgICAgIGlmICghKGtleUZpZWxkIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBUaGUga2V5IGZpZWxkIFwiJHtrZXlGaWVsZH1cIiBwcm92aWRlZCB0byBpbmRleCB0aGUgY2FjaGVkIGRpY3Rpb25hcnkgaXMgbm90IGEgZmllbGQgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiByZWNvcmRzLnJlZHVjZSgodGFibGUsIHYpID0+IHtcbiAgICAgICAgICAgICAgICB0YWJsZVt2W2tleUZpZWxkXV0gPSB2O1xuICAgICAgICAgICAgICAgIHJldHVybiB0YWJsZTtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXR1cm4gcmVjb3JkcztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCZWZvcmUgZGVsZXRpbmcgYW4gZW50aXR5LlxuICAgICAqIEBwYXJhbSB7Kn0gY29udGV4dCBcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gW2NvbnRleHQuZGVsZXRlT3B0aW9uc10gLSBEZWxldGUgb3B0aW9ucyAgICAgXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbZGVsZXRlT3B0aW9ucy4kcmV0cmlldmVEZWxldGVkXSAtIFJldHJpZXZlIHRoZSByZWNlbnRseSBkZWxldGVkIHJlY29yZCBmcm9tIGRiLiBcbiAgICAgKi9cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlXyhjb250ZXh0KSB7XG4gICAgICAgIGlmIChjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFjb250ZXh0LmNvbm5PcHRpb25zIHx8ICFjb250ZXh0LmNvbm5PcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgICAgICBjb250ZXh0LmNvbm5PcHRpb25zIHx8IChjb250ZXh0LmNvbm5PcHRpb25zID0ge30pO1xuXG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uID0gYXdhaXQgdGhpcy5kYi5jb25uZWN0b3IuYmVnaW5UcmFuc2FjdGlvbl8oKTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJldHJpZXZlT3B0aW9ucyA9IF8uaXNQbGFpbk9iamVjdChjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCkgPyBcbiAgICAgICAgICAgICAgICBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHJldHJpZXZlRGVsZXRlZCA6XG4gICAgICAgICAgICAgICAge307XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbnRleHQuZXhpc3RpbmcgPSBhd2FpdCB0aGlzLmZpbmRPbmVfKHsgLi4ucmV0cmlldmVPcHRpb25zLCAkcXVlcnk6IGNvbnRleHQuZGVsZXRlT3B0aW9ucy4kcXVlcnkgfSwgY29udGV4dC5jb25uT3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgYmVmb3JlRGVsZXRlTWFueV8oY29udGV4dCkge1xuICAgICAgICBpZiAoY29udGV4dC5kZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghY29udGV4dC5jb25uT3B0aW9ucyB8fCAhY29udGV4dC5jb25uT3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICAgICAgY29udGV4dC5jb25uT3B0aW9ucyB8fCAoY29udGV4dC5jb25uT3B0aW9ucyA9IHt9KTtcblxuICAgICAgICAgICAgICAgIGNvbnRleHQuY29ubk9wdGlvbnMuY29ubmVjdGlvbiA9IGF3YWl0IHRoaXMuZGIuY29ubmVjdG9yLmJlZ2luVHJhbnNhY3Rpb25fKCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCByZXRyaWV2ZU9wdGlvbnMgPSBfLmlzUGxhaW5PYmplY3QoY29udGV4dC5kZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQpID8gXG4gICAgICAgICAgICAgICAgY29udGV4dC5kZWxldGVPcHRpb25zLiRyZXRyaWV2ZURlbGV0ZWQgOlxuICAgICAgICAgICAgICAgIHt9O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb250ZXh0LmV4aXN0aW5nID0gYXdhaXQgdGhpcy5maW5kQWxsXyh7IC4uLnJldHJpZXZlT3B0aW9ucywgJHF1ZXJ5OiBjb250ZXh0LmRlbGV0ZU9wdGlvbnMuJHF1ZXJ5IH0sIGNvbnRleHQuY29ubk9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBmaW5kT3B0aW9ucyBcbiAgICAgKi9cbiAgICBzdGF0aWMgX3ByZXBhcmVBc3NvY2lhdGlvbnMoZmluZE9wdGlvbnMpIHsgXG4gICAgICAgIGxldCBhc3NvY2lhdGlvbnMgPSBfLnVuaXEoZmluZE9wdGlvbnMuJGFzc29jaWF0aW9uKS5zb3J0KCk7ICAgICAgICBcbiAgICAgICAgbGV0IGFzc29jVGFibGUgPSB7fSwgY291bnRlciA9IDAsIGNhY2hlID0ge307ICAgICAgIFxuXG4gICAgICAgIGFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoYXNzb2MpKSB7XG4gICAgICAgICAgICAgICAgYXNzb2MgPSB0aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYyk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYWxpYXMgPSBhc3NvYy5hbGlhcztcbiAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgICAgIGFsaWFzID0gJzpqb2luJyArICsrY291bnRlcjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY1RhYmxlW2FsaWFzXSA9IHsgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eTogYXNzb2MuZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgam9pblR5cGU6IGFzc29jLnR5cGUsIFxuICAgICAgICAgICAgICAgICAgICBvdXRwdXQ6IGFzc29jLm91dHB1dCxcbiAgICAgICAgICAgICAgICAgICAga2V5OiBhc3NvYy5rZXksXG4gICAgICAgICAgICAgICAgICAgIGFsaWFzLFxuICAgICAgICAgICAgICAgICAgICBvbjogYXNzb2Mub24sXG4gICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5kYXRhc2V0ID8gdGhpcy5kYi5jb25uZWN0b3IuYnVpbGRRdWVyeShcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5lbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3ByZXBhcmVRdWVyaWVzKHsgLi4uYXNzb2MuZGF0YXNldCwgJHZhcmlhYmxlczogZmluZE9wdGlvbnMuJHZhcmlhYmxlcyB9KVxuICAgICAgICAgICAgICAgICAgICAgICAgKSA6IHt9KSAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0pOyAgICAgICAgXG5cbiAgICAgICAgcmV0dXJuIGFzc29jVGFibGU7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY1RhYmxlIC0gSGllcmFyY2h5IHdpdGggc3ViQXNzb2NzXG4gICAgICogQHBhcmFtIHsqfSBjYWNoZSAtIERvdHRlZCBwYXRoIGFzIGtleVxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgLSBEb3R0ZWQgcGF0aFxuICAgICAqL1xuICAgIHN0YXRpYyBfbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBhc3NvYykge1xuICAgICAgICBpZiAoY2FjaGVbYXNzb2NdKSByZXR1cm4gY2FjaGVbYXNzb2NdO1xuXG4gICAgICAgIGxldCBsYXN0UG9zID0gYXNzb2MubGFzdEluZGV4T2YoJy4nKTsgICAgICAgIFxuICAgICAgICBsZXQgcmVzdWx0OyAgXG5cbiAgICAgICAgaWYgKGxhc3RQb3MgPT09IC0xKSB7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFzc29jSW5mbyA9IHsgLi4udGhpcy5tZXRhLmFzc29jaWF0aW9uc1thc3NvY10gfTsgICBcbiAgICAgICAgICAgIGlmIChfLmlzRW1wdHkoYXNzb2NJbmZvKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKGBFbnRpdHkgXCIke3RoaXMubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXN1bHQgPSBjYWNoZVthc3NvY10gPSBhc3NvY1RhYmxlW2Fzc29jXSA9IHsgLi4udGhpcy5fdHJhbnNsYXRlU2NoZW1hTmFtZVRvRGIoYXNzb2NJbmZvKSB9O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGJhc2UgPSBhc3NvYy5zdWJzdHIoMCwgbGFzdFBvcyk7XG4gICAgICAgICAgICBsZXQgbGFzdCA9IGFzc29jLnN1YnN0cihsYXN0UG9zKzEpOyAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGJhc2VOb2RlID0gY2FjaGVbYmFzZV07XG4gICAgICAgICAgICBpZiAoIWJhc2VOb2RlKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGJhc2VOb2RlID0gdGhpcy5fbG9hZEFzc29jSW50b1RhYmxlKGFzc29jVGFibGUsIGNhY2hlLCBiYXNlKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGVudGl0eSA9IHRoaXMuZGIubW9kZWwoYmFzZU5vZGUuZW50aXR5KTtcbiAgICAgICAgICAgIGxldCBhc3NvY0luZm8gPXsgLi4uZW50aXR5Lm1ldGEuYXNzb2NpYXRpb25zW2xhc3RdIH07XG4gICAgICAgICAgICBpZiAoXy5pc0VtcHR5KGFzc29jSW5mbykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubWV0YS5uYW1lfVwiIGRvZXMgbm90IGhhdmUgdGhlIGFzc29jaWF0aW9uIFwiJHthc3NvY31cIi5gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0ID0geyAuLi50aGlzLl90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvY0luZm8pIH07XG5cbiAgICAgICAgICAgIGlmICghYmFzZU5vZGUuc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgYmFzZU5vZGUuc3ViQXNzb2NzID0ge307XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBjYWNoZVthc3NvY10gPSBiYXNlTm9kZS5zdWJBc3NvY3NbbGFzdF0gPSByZXN1bHQ7XG4gICAgICAgIH0gICAgICBcblxuICAgICAgICBpZiAocmVzdWx0LmFzc29jKSB7XG4gICAgICAgICAgICB0aGlzLl9sb2FkQXNzb2NJbnRvVGFibGUoYXNzb2NUYWJsZSwgY2FjaGUsIGFzc29jICsgJy4nICsgcmVzdWx0LmFzc29jKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIF90cmFuc2xhdGVTY2hlbWFOYW1lVG9EYihhc3NvYykge1xuICAgICAgICBpZiAoYXNzb2MuZW50aXR5LmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IGFzc29jLmVudGl0eS5zcGxpdCgnLicsIDIpO1xuXG4gICAgICAgICAgICBsZXQgYXBwID0gdGhpcy5kYi5hcHA7XG4gICAgICAgICAgICBpZiAoIWFwcCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdDcm9zcyBkYiBhc3NvY2lhdGlvbiByZXF1aXJlcyB0aGUgZGIgb2JqZWN0IGhhdmUgYWNjZXNzIHRvIG90aGVyIGRiIG9iamVjdC4nKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHJlZkRiID0gYXBwLmRiKHNjaGVtYU5hbWUpO1xuICAgICAgICAgICAgaWYgKCFyZWZEYikgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVGhlIHJlZmVyZW5jZWQgc2NoZW1hIFwiJHtzY2hlbWFOYW1lfVwiIGRvZXMgbm90IGhhdmUgZGIgbW9kZWwgaW4gdGhlIHNhbWUgYXBwbGljYXRpb24uYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGFzc29jLmVudGl0eSA9IHJlZkRiLmNvbm5lY3Rvci5kYXRhYmFzZSArICcuJyArIGVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgIGlmICghYXNzb2Mua2V5KSB7XG4gICAgICAgICAgICAgICAgbGV0IG1vZGVsID0gcmVmRGIubW9kZWwoZW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgaWYgKCFtb2RlbCkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgRmFpbGVkIGxvYWQgdGhlIGVudGl0eSBtb2RlbCBcIiR7c2NoZW1hTmFtZX0uJHtlbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGFzc29jLmtleSA9IG1vZGVsLm1ldGEua2V5RmllbGQ7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAoIWFzc29jLmtleSkge1xuICAgICAgICAgICAgYXNzb2Mua2V5ID0gdGhpcy5kYi5tb2RlbChhc3NvYy5lbnRpdHkpLm1ldGEua2V5RmllbGQ7ICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFzc29jO1xuICAgIH1cblxuICAgIHN0YXRpYyBfbWFwUmVjb3Jkc1RvT2JqZWN0cyhbcm93cywgY29sdW1ucywgYWxpYXNNYXBdLCBoaWVyYXJjaHkpIHtcbiAgICAgICAgbGV0IG1haW5JbmRleCA9IHt9OyAgICAgICAgXG5cbiAgICAgICAgZnVuY3Rpb24gbWVyZ2VSZWNvcmQoZXhpc3RpbmdSb3csIHJvd09iamVjdCwgYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCAoeyBzcWwsIGtleSwgbGlzdCwgc3ViQXNzb2NzIH0sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSByZXR1cm47ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgb2JqS2V5ID0gJzonICsgYW5jaG9yOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViT2JqID0gcm93T2JqZWN0W29iaktleV1cbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXhlcyA9IGV4aXN0aW5nUm93LnN1YkluZGV4ZXNbb2JqS2V5XTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAvLyBqb2luZWQgYW4gZW1wdHkgcmVjb3JkXG4gICAgICAgICAgICAgICAgbGV0IHJvd0tleSA9IHN1Yk9ialtrZXldO1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHJvd0tleSkpIHJldHVybjtcblxuICAgICAgICAgICAgICAgIGxldCBleGlzdGluZ1N1YlJvdyA9IHN1YkluZGV4ZXMgJiYgc3ViSW5kZXhlc1tyb3dLZXldO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1N1YlJvdykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1N1YlJvdywgc3ViT2JqLCBzdWJBc3NvY3MpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogbGlzdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUm93LnJvd09iamVjdFtvYmpLZXldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XS5wdXNoKHN1Yk9iaik7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBleGlzdGluZ1Jvdy5yb3dPYmplY3Rbb2JqS2V5XSA9IFsgc3ViT2JqIF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBzdWJJbmRleCA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iaiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJBc3NvY3MpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN1YkluZGV4LnN1YkluZGV4ZXMgPSBidWlsZFN1YkluZGV4ZXMoc3ViT2JqLCBzdWJBc3NvY3MpXG4gICAgICAgICAgICAgICAgICAgIH0gICAgXG5cbiAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXhlc1tyb3dLZXldID0gc3ViSW5kZXg7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGJ1aWxkU3ViSW5kZXhlcyhyb3dPYmplY3QsIGFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGluZGV4ZXMgPSB7fTtcblxuICAgICAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgc3FsLCBrZXksIGxpc3QsIHN1YkFzc29jcyB9LCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoc3FsKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NlcnQ6IGtleTtcblxuICAgICAgICAgICAgICAgIGxldCBvYmpLZXkgPSAnOicgKyBhbmNob3I7XG4gICAgICAgICAgICAgICAgbGV0IHN1Yk9iamVjdCA9IHJvd09iamVjdFtvYmpLZXldOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSW5kZXggPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3Q6IHN1Yk9iamVjdCBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxpc3QpIHsgICBcbiAgICAgICAgICAgICAgICAgICAgLy9tYW55IHRvICogICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vc3ViT2JqZWN0IG5vdCBleGlzdCwganVzdCBmaWxsZWQgd2l0aCBudWxsIGJ5IGpvaW5pbmdcbiAgICAgICAgICAgICAgICAgICAgICAgIHJvd09iamVjdFtvYmpLZXldID0gW107XG4gICAgICAgICAgICAgICAgICAgICAgICBzdWJPYmplY3QgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgcm93T2JqZWN0W29iaktleV0gPSBbIHN1Yk9iamVjdCBdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChzdWJPYmplY3QgJiYgXy5pc05pbChzdWJPYmplY3Rba2V5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3ViT2JqZWN0ID0gcm93T2JqZWN0W29iaktleV0gPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChzdWJPYmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YkFzc29jcykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3ViSW5kZXguc3ViSW5kZXhlcyA9IGJ1aWxkU3ViSW5kZXhlcyhzdWJPYmplY3QsIHN1YkFzc29jcyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBpbmRleGVzW29iaktleV0gPSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbc3ViT2JqZWN0W2tleV1dOiBzdWJJbmRleFxuICAgICAgICAgICAgICAgICAgICB9O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pOyAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpbmRleGVzO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGFycmF5T2ZPYmpzID0gW107XG5cbiAgICAgICAgLy9wcm9jZXNzIGVhY2ggcm93XG4gICAgICAgIHJvd3MuZm9yRWFjaCgocm93LCBpKSA9PiB7XG4gICAgICAgICAgICBsZXQgcm93T2JqZWN0ID0ge307IC8vIGhhc2gtc3R5bGUgZGF0YSByb3dcbiAgICAgICAgICAgIGxldCB0YWJsZUNhY2hlID0ge307IC8vIGZyb20gYWxpYXMgdG8gY2hpbGQgcHJvcCBvZiByb3dPYmplY3RcblxuICAgICAgICAgICAgcm93LnJlZHVjZSgocmVzdWx0LCB2YWx1ZSwgaSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBjb2wgPSBjb2x1bW5zW2ldO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChjb2wudGFibGUgPT09ICdBJykge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbY29sLm5hbWVdID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBidWNrZXQgPSB0YWJsZUNhY2hlW2NvbC50YWJsZV07ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJ1Y2tldCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IG5lc3RlZCBpbnNpZGUgXG4gICAgICAgICAgICAgICAgICAgICAgICBidWNrZXRbY29sLm5hbWVdID0gdmFsdWU7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBub2RlUGF0aCA9IGFsaWFzTWFwW2NvbC50YWJsZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAobm9kZVBhdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgc3ViT2JqZWN0ID0geyBbY29sLm5hbWVdOiB2YWx1ZSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhYmxlQ2FjaGVbY29sLnRhYmxlXSA9IHN1Yk9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzZXRWYWx1ZUJ5UGF0aChyZXN1bHQsIG5vZGVQYXRoLCBzdWJPYmplY3QpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHJvd09iamVjdCk7ICAgICBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IHJvd0tleSA9IHJvd09iamVjdFt0aGlzLm1ldGEua2V5RmllbGRdO1xuICAgICAgICAgICAgbGV0IGV4aXN0aW5nUm93ID0gbWFpbkluZGV4W3Jvd0tleV07XG4gICAgICAgICAgICBpZiAoZXhpc3RpbmdSb3cpIHtcbiAgICAgICAgICAgICAgICBtZXJnZVJlY29yZChleGlzdGluZ1Jvdywgcm93T2JqZWN0LCBoaWVyYXJjaHkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheU9mT2Jqcy5wdXNoKHJvd09iamVjdCk7XG4gICAgICAgICAgICAgICAgbWFpbkluZGV4W3Jvd0tleV0gPSB7IFxuICAgICAgICAgICAgICAgICAgICByb3dPYmplY3QsIFxuICAgICAgICAgICAgICAgICAgICBzdWJJbmRleGVzOiBidWlsZFN1YkluZGV4ZXMocm93T2JqZWN0LCBoaWVyYXJjaHkpXG4gICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBhcnJheU9mT2JqcztcbiAgICB9XG5cbiAgICBzdGF0aWMgX2V4dHJhY3RBc3NvY2lhdGlvbnMoZGF0YSkge1xuICAgICAgICBsZXQgcmF3ID0ge30sIGFzc29jcyA9IHt9O1xuICAgICAgICBcbiAgICAgICAgXy5mb3JPd24oZGF0YSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgIGlmIChrLnN0YXJ0c1dpdGgoJzonKSkge1xuICAgICAgICAgICAgICAgIGFzc29jc1trLnN1YnN0cigxKV0gPSB2O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICByYXdba10gPSB2O1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBbIHJhdywgYXNzb2NzIF07ICAgICAgICBcbiAgICB9XG5cbiAgICBzdGF0aWMgYXN5bmMgX2NyZWF0ZUFzc29jc18oY29udGV4dCwgYXNzb2NzKSB7XG4gICAgICAgIGxldCBtZXRhID0gdGhpcy5tZXRhLmFzc29jaWF0aW9ucztcbiAgICAgICAgbGV0IGtleVZhbHVlID0gY29udGV4dC5sYXRlc3RbdGhpcy5tZXRhLmtleUZpZWxkXTtcblxuICAgICAgICBpZiAoXy5pc05pbChrZXlWYWx1ZSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKCdNaXNzaW5nIHJlcXVpcmVkIHByaW1hcnkga2V5IGZpZWxkIHZhbHVlLiBFbnRpdHk6ICcgKyB0aGlzLm1ldGEubmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhhc3NvY3MsIGFzeW5jIChkYXRhLCBhbmNob3IpID0+IHtcbiAgICAgICAgICAgIGxldCBhc3NvY01ldGEgPSBtZXRhW2FuY2hvcl07XG4gICAgICAgICAgICBpZiAoIWFzc29jTWV0YSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGFzc29jaWF0aW9uIFwiJHthbmNob3J9XCIgb2YgZW50aXR5IFwiJHt0aGlzLm1ldGEubmFtZX1cIi5gKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGFzc29jTW9kZWwgPSB0aGlzLmRiLm1vZGVsKGFzc29jTWV0YS5lbnRpdHkpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NNZXRhLmxpc3QpIHtcbiAgICAgICAgICAgICAgICBkYXRhID0gXy5jYXN0QXJyYXkoZGF0YSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyhkYXRhLCBpdGVtID0+IGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLml0ZW0sIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQuY3JlYXRlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucykpO1xuICAgICAgICAgICAgfSBlbHNlIGlmICghXy5pc1BsYWluT2JqZWN0KGRhdGEpKSB7XG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IoYEludmFsaWQgdHlwZSBvZiBhc3NvY2lhdGVkIGVudGl0eSAoJHthc3NvY01ldGEuZW50aXR5fSkgZGF0YSB0cmlnZ2VyZWQgZnJvbSBcIiR7dGhpcy5tZXRhLm5hbWV9XCIgZW50aXR5LiBTaW5ndWxhciB2YWx1ZSBleHBlY3RlZCAoJHthbmNob3J9KSwgYnV0IGFuIGFycmF5IGlzIGdpdmVuIGluc3RlYWQuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFhc3NvY01ldGEuYXNzb2MpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFRoZSBhc3NvY2lhdGVkIGZpZWxkIG9mIHJlbGF0aW9uIFwiJHthbmNob3J9XCIgZG9lcyBub3QgZXhpc3QgaW4gdGhlIGVudGl0eSBtZXRhIGRhdGEuYCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZGF0YSA9IHsgW2Fzc29jTWV0YS5hc3NvY106IGRhdGEgfTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jTW9kZWwuY3JlYXRlXyh7IC4uLmRhdGEsIC4uLihhc3NvY01ldGEuZmllbGQgPyB7IFthc3NvY01ldGEuZmllbGRdOiBrZXlWYWx1ZSB9IDoge30pIH0sIGNvbnRleHQuY3JlYXRlT3B0aW9ucywgY29udGV4dC5jb25uT3B0aW9ucyk7ICBcbiAgICAgICAgfSk7XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMRW50aXR5TW9kZWw7Il19