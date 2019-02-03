"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const pluralize = require('pluralize');

const path = require('path');

const ntol = require('number-to-letter');

const Util = require('rk-utils');

const {
  _,
  fs
} = Util;

const OolUtils = require('../../../lang/OolUtils');

const Entity = require('../../../lang/Entity');

const Types = require('../../../runtime/types');

const UNSUPPORTED_DEFAULT_VALUE = new Set(['BLOB', 'TEXT', 'JSON', 'GEOMETRY']);

class MySQLModeler {
  constructor(context, connector, dbOptions) {
    this.logger = context.logger;
    this.linker = context.linker;
    this.outputPath = context.scriptOutputPath;
    this.connector = connector;
    this._events = new EventEmitter();
    this._dbOptions = dbOptions ? {
      db: _.mapKeys(dbOptions.db, (value, key) => _.upperCase(key)),
      table: _.mapKeys(dbOptions.table, (value, key) => _.upperCase(key))
    } : {};
    this._references = {};
    this._relationEntities = {};
    this._processedRef = new Set();
  }

  modeling(schema) {
    this.logger.log('info', 'Generating mysql scripts for schema "' + schema.name + '"...');
    let modelingSchema = schema.clone();
    this.logger.log('debug', 'Building relations...');
    let existingEntities = Object.values(modelingSchema.entities);

    _.each(existingEntities, entity => {
      if (!_.isEmpty(entity.info.associations)) {
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc));
      }
    });

    this._events.emit('afterRelationshipBuilding');

    let sqlFilesDir = path.join('mysql', this.connector.database);
    let dbFilePath = path.join(sqlFilesDir, 'entities.sql');
    let fkFilePath = path.join(sqlFilesDir, 'relations.sql');
    let initIdxFilePath = path.join(sqlFilesDir, 'data', '_init', 'index.list');
    let initFilePath = path.join(sqlFilesDir, 'data', '_init', '0-init.json');
    let tableSQL = '',
        relationSQL = '',
        data = {};

    _.each(modelingSchema.entities, (entity, entityName) => {
      entity.addIndexes();
      let result = MySQLModeler.complianceCheck(entity);

      if (result.errors.length) {
        let message = '';

        if (result.warnings.length > 0) {
          message += 'Warnings: \n' + result.warnings.join('\n') + '\n';
        }

        message += result.errors.join('\n');
        throw new Error(message);
      }

      if (entity.features) {
        _.forOwn(entity.features, (f, featureName) => {
          if (Array.isArray(f)) {
            f.forEach(ff => this._featureReducer(entity, featureName, ff));
          } else {
            this._featureReducer(entity, featureName, f);
          }
        });
      }

      tableSQL += this._createTableStatement(entityName, entity) + '\n';

      if (entity.info.data) {
        let entityData = [];

        if (Array.isArray(entity.info.data)) {
          entity.info.data.forEach(record => {
            if (!_.isPlainObject(record)) {
              let fields = Object.keys(entity.fields);

              if (fields.length !== 2) {
                throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
              }

              record = {
                [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
              };
            } else {
              record = this.linker.translateOolValue(entity.oolModule, record);
            }

            entityData.push(record);
          });
        } else {
          _.forOwn(entity.info.data, (record, key) => {
            if (!_.isPlainObject(record)) {
              let fields = Object.keys(entity.fields);

              if (fields.length !== 2) {
                throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
              }

              record = {
                [entity.key]: key,
                [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)
              };
            } else {
              record = Object.assign({
                [entity.key]: key
              }, this.linker.translateOolValue(entity.oolModule, record));
            }

            entityData.push(record);
          });
        }

        if (!_.isEmpty(entityData)) {
          data[entityName] = entityData;
        }
      }
    });

    _.forOwn(this._references, (refs, srcEntityName) => {
      _.each(refs, ref => {
        relationSQL += this._addForeignKeyStatement(srcEntityName, ref) + '\n';
      });
    });

    this._writeFile(path.join(this.outputPath, dbFilePath), tableSQL);

    this._writeFile(path.join(this.outputPath, fkFilePath), relationSQL);

    if (!_.isEmpty(data)) {
      this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify(data, null, 4));

      if (!fs.existsSync(path.join(this.outputPath, initIdxFilePath))) {
        this._writeFile(path.join(this.outputPath, initIdxFilePath), '0-init.json\n');
      }
    }

    let funcSQL = '';
    let spFilePath = path.join(sqlFilesDir, 'procedures.sql');

    this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);

    return modelingSchema;
  }

  _processAssociation(schema, entity, assoc) {
    let destEntityName = assoc.destEntity;
    let destEntity = schema.entities[destEntityName];

    if (!destEntity) {
      throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
    }

    let destKeyField = destEntity.getKeyField();

    if (Array.isArray(destKeyField)) {
      throw new Error(`Destination entity "${destEntityName}" with combination primary key is not supported.`);
    }

    switch (assoc.type) {
      case 'hasOne':
      case 'hasMany':
        let includes;
        let excludes = {
          types: ['refersTo'],
          association: assoc
        };

        if (assoc.connectedBy) {
          excludes.types.push('belongsTo');
          includes = {
            connectedBy: cb => cb && cb.split('.')[0] === assoc.connectedBy.split('.')[0]
          };

          if (assoc.connectedWith) {
            includes.connectedWith = assoc.connectedWith;
          }
        }

        let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);

        if (backRef) {
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            let connectedByParts = assoc.connectedBy.split('.');

            if (!(connectedByParts.length <= 2)) {
              throw new Error("Assertion failed: connectedByParts.length <= 2");
            }

            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

            if (!connEntityName) {
              throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}::${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

            if (assoc.srcField) {
              tag1 += ' ' + assoc.srcField;
            }

            if (backRef.srcField) {
              tag2 += ' ' + backRef.srcField;
            }

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            let connectedByParts2 = backRef.connectedBy.split('.');
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntity.name;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "connectedBy" field in a relation entity.');
            }

            let connEntity = schema.entities[connEntityName];

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, connectedByField, connectedByField2);
            }

            this._updateRelationEntity(connEntity, entity, destEntity, connectedByField, connectedByField2);

            let localFieldName = assoc.srcField || pluralize(destEntityName);
            entity.addAssociation(localFieldName, destEntity, {
              optional: assoc.optional,
              connectedBy: connEntityName,
              remoteField: connectedByField,
              refersToField: connectedByField2,
              ...(assoc.type === 'hasMany' ? {
                isList: true
              } : {}),
              ...(assoc.connectedWith ? {
                connectedWith: this._oolConditionToQueryCondition(entity, connEntity, destEntity, connectedByField, connectedByField2, assoc.connectedWith, localFieldName)
              } : {})
            });
            let remoteFieldName = backRef.srcField || pluralize(entity.name);
            destEntity.addAssociation(remoteFieldName, entity, {
              optional: backRef.optional,
              connectedBy: connEntityName,
              remoteField: connectedByField2,
              refersToField: connectedByField,
              ...(backRef.type === 'hasMany' ? {
                isList: true
              } : {}),
              ...(backRef.connectedWith ? {
                connectedWith: this._oolConditionToQueryCondition(destEntity, connEntity, entity, connectedByField2, connectedByField, backRef.connectedWith, remoteFieldName)
              } : {})
            });

            this._processedRef.add(tag1);

            this._processedRef.add(tag2);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.connectedBy) {
              throw new Error('todo: belongsTo connectedBy. entity: ' + entity.name);
            } else {}
          } else {
            throw new Error('Unexpected path. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));
          }
        } else {
          throw new Error('Back reference not found. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityName;
        let fieldProps = { ..._.omit(destKeyField, ['optional']),
          ..._.pick(assoc, ['optional'])
        };
        entity.addAssocField(localField, destEntity, fieldProps);
        entity.addAssociation(localField, destEntity, {
          isList: false,
          optional: assoc.optional
        });

        if (assoc.type === 'belongsTo') {
          let backRef = destEntity.getReferenceTo(entity.name, null, {
            types: ['refersTo', 'belongsTo'],
            association: assoc
          });

          if (!backRef) {
            destEntity.addAssociation(pluralize(entity.name), entity, {
              isList: true,
              remoteField: localField
            });
          } else {
            destEntity.addAssociation(backRef.srcField || pluralize(entity.name), entity, {
              isList: backRef.type === 'hasMany',
              remoteField: localField,
              optional: backRef.optional
            });
          }
        }

        this._addReference(entity.name, localField, destEntityName, destKeyField.name);

        break;
    }
  }

  _oolConditionToQueryCondition(entity, connEntity, destEntity, localFieldName, remoteFieldName, oolCon, anchor) {
    let context = {
      [connEntity.name]: anchor
    };

    if (!oolCon.oolType) {
      throw new Error("Assertion failed: oolCon.oolType");
    }

    if (oolCon.oolType === 'BinaryExpression') {
      if (oolCon.operator === '==') {
        let left = oolCon.left;

        if (left.oolType && left.oolType === 'ObjectReference') {
          left = this._translateReference(context, left.name);
        }

        let right = oolCon.right;

        if (right.oolType && right.oolType === 'ObjectReference') {
          right = this._translateReference(context, right.name);
        }

        return {
          [left]: {
            '$eq': right
          }
        };
      }
    }
  }

  _translateReference(context, ref) {
    let [base, ...other] = ref.split('.');
    let translated = context[base];

    if (!translated) {
      throw new Error(`Referenced object "${ref}" not found in context.`);
    }

    return [translated, ...other].join('.');
  }

  _addReference(left, leftField, right, rightField) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      refs4LeftEntity = [];
      this._references[left] = refs4LeftEntity;
    } else {
      let found = _.find(refs4LeftEntity, item => item.leftField === leftField && item.right === right && item.rightField === rightField);

      if (found) {
        return this;
      }
    }

    refs4LeftEntity.push({
      leftField,
      right,
      rightField
    });
    return this;
  }

  _getReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.leftField === leftField);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceOfField(left, leftField) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.leftField === leftField);
  }

  _getReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      return undefined;
    }

    let reference = _.find(refs4LeftEntity, item => item.right === right);

    if (!reference) {
      return undefined;
    }

    return reference;
  }

  _hasReferenceBetween(left, right) {
    let refs4LeftEntity = this._references[left];
    if (!refs4LeftEntity) return false;
    return undefined !== _.find(refs4LeftEntity, item => item.right === right);
  }

  _featureReducer(entity, featureName, feature) {
    let field;

    switch (featureName) {
      case 'autoId':
        field = entity.fields[feature.field];

        if (field.type === 'integer' && !field.generator) {
          field.autoIncrementId = true;

          if ('startFrom' in field) {
            this._events.on('setTableOptions:' + entity.name, extraOpts => {
              extraOpts['AUTO_INCREMENT'] = field.startFrom;
            });
          }
        }

        break;

      case 'createTimestamp':
        field = entity.fields[feature.field];
        field.isCreateTimestamp = true;
        break;

      case 'updateTimestamp':
        field = entity.fields[feature.field];
        field.isUpdateTimestamp = true;
        break;

      case 'logicalDeletion':
        break;

      case 'atLeastOneNotNull':
        break;

      case 'validateAllFieldsOnCreation':
        break;

      case 'stateTracking':
        break;

      case 'i18n':
        break;

      default:
        throw new Error('Unsupported feature "' + featureName + '".');
    }
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.logger.log('info', 'Generated db script: ' + filePath);
  }

  _addRelationEntity(schema, relationEntityName, entity1RefField, entity2RefField) {
    let entityInfo = {
      features: ['createTimestamp'],
      key: [entity1RefField, entity2RefField]
    };
    let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
    entity.link();
    schema.addEntity(entity);
    return entity;
  }

  _updateRelationEntity(relationEntity, entity1, entity2, connectedByField, connectedByField2) {
    let relationEntityName = relationEntity.name;

    if (relationEntity.info.associations) {
      let hasRefToEntity1 = false,
          hasRefToEntity2 = false;

      _.each(relationEntity.info.associations, assoc => {
        if (assoc.type === 'refersTo' && assoc.destEntity === entity1.name && (assoc.srcField || entity1.name) === connectedByField) {
          hasRefToEntity1 = true;
        }

        if (assoc.type === 'refersTo' && assoc.destEntity === entity2.name && (assoc.srcField || entity2.name) === connectedByField2) {
          hasRefToEntity2 = true;
        }
      });

      if (hasRefToEntity1 && hasRefToEntity2) {
        this._relationEntities[relationEntityName] = true;
        return;
      }
    }

    let keyEntity1 = entity1.getKeyField();

    if (Array.isArray(keyEntity1)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity1.name}`);
    }

    let keyEntity2 = entity2.getKeyField();

    if (Array.isArray(keyEntity2)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity2.name}`);
    }

    relationEntity.addAssocField(connectedByField, entity1, _.omit(keyEntity1, ['optional']));
    relationEntity.addAssocField(connectedByField2, entity2, _.omit(keyEntity2, ['optional']));
    relationEntity.addAssociation(connectedByField, entity1);
    relationEntity.addAssociation(connectedByField2, entity2);

    this._addReference(relationEntityName, connectedByField, entity1.name, keyEntity1.name);

    this._addReference(relationEntityName, connectedByField2, entity2.name, keyEntity2.name);

    this._relationEntities[relationEntityName] = true;
  }

  static oolOpToSql(op) {
    switch (op) {
      case '=':
        return '=';

      default:
        throw new Error('oolOpToSql to be implemented.');
    }
  }

  static oolToSql(schema, doc, ool, params) {
    if (!ool.oolType) {
      return ool;
    }

    switch (ool.oolType) {
      case 'BinaryExpression':
        let left, right;

        if (ool.left.oolType) {
          left = MySQLModeler.oolToSql(schema, doc, ool.left, params);
        } else {
          left = ool.left;
        }

        if (ool.right.oolType) {
          right = MySQLModeler.oolToSql(schema, doc, ool.right, params);
        } else {
          right = ool.right;
        }

        return left + ' ' + MySQLModeler.oolOpToSql(ool.operator) + ' ' + right;

      case 'ObjectReference':
        if (!OolUtils.isMemberAccess(ool.name)) {
          if (params && _.find(params, p => p.name === ool.name) !== -1) {
            return 'p' + _.upperFirst(ool.name);
          }

          throw new Error(`Referencing to a non-existing param "${ool.name}".`);
        }

        let {
          entityNode,
          entity,
          field
        } = OolUtils.parseReferenceInDocument(schema, doc, ool.name);
        return entityNode.alias + '.' + MySQLModeler.quoteIdentifier(field.name);

      default:
        throw new Error('oolToSql to be implemented.');
    }
  }

  static _orderByToSql(schema, doc, ool) {
    return MySQLModeler.oolToSql(schema, doc, {
      oolType: 'ObjectReference',
      name: ool.field
    }) + (ool.ascend ? '' : ' DESC');
  }

  _viewDocumentToSQL(modelingSchema, view) {
    let sql = '  ';

    let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));

    let [colList, alias, joins] = this._buildViewSelect(modelingSchema, doc, 0);

    sql += 'SELECT ' + colList.join(', ') + ' FROM ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + alias;

    if (!_.isEmpty(joins)) {
      sql += ' ' + joins.join(' ');
    }

    if (!_.isEmpty(view.selectBy)) {
      sql += ' WHERE ' + view.selectBy.map(select => MySQLModeler.oolToSql(modelingSchema, doc, select, view.params)).join(' AND ');
    }

    if (!_.isEmpty(view.groupBy)) {
      sql += ' GROUP BY ' + view.groupBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    if (!_.isEmpty(view.orderBy)) {
      sql += ' ORDER BY ' + view.orderBy.map(col => MySQLModeler._orderByToSql(modelingSchema, doc, col)).join(', ');
    }

    let skip = view.skip || 0;

    if (view.limit) {
      sql += ' LIMIT ' + MySQLModeler.oolToSql(modelingSchema, doc, skip, view.params) + ', ' + MySQLModeler.oolToSql(modelingSchema, doc, view.limit, view.params);
    } else if (view.skip) {
      sql += ' OFFSET ' + MySQLModeler.oolToSql(modelingSchema, doc, view.skip, view.params);
    }

    return sql;
  }

  _buildViewSelect(schema, doc, startIndex) {
    let entity = schema.entities[doc.entity];
    let alias = ntol(startIndex++);
    doc.alias = alias;
    let colList = Object.keys(entity.fields).map(k => alias + '.' + MySQLModeler.quoteIdentifier(k));
    let joins = [];

    if (!_.isEmpty(doc.subDocuments)) {
      _.forOwn(doc.subDocuments, (doc, fieldName) => {
        let [subColList, subAlias, subJoins, startIndex2] = this._buildViewSelect(schema, doc, startIndex);

        startIndex = startIndex2;
        colList = colList.concat(subColList);
        joins.push('LEFT JOIN ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + subAlias + ' ON ' + alias + '.' + MySQLModeler.quoteIdentifier(fieldName) + ' = ' + subAlias + '.' + MySQLModeler.quoteIdentifier(doc.linkWithField));

        if (!_.isEmpty(subJoins)) {
          joins = joins.concat(subJoins);
        }
      });
    }

    return [colList, alias, joins, startIndex];
  }

  _createTableStatement(entityName, entity) {
    let sql = 'CREATE TABLE IF NOT EXISTS `' + entityName + '` (\n';

    _.each(entity.fields, (field, name) => {
      sql += '  ' + MySQLModeler.quoteIdentifier(name) + ' ' + MySQLModeler.columnDefinition(field) + ',\n';
    });

    sql += '  PRIMARY KEY (' + MySQLModeler.quoteListOrValue(entity.key) + '),\n';

    if (entity.indexes && entity.indexes.length > 0) {
      entity.indexes.forEach(index => {
        sql += '  ';

        if (index.unique) {
          sql += 'UNIQUE ';
        }

        sql += 'KEY (' + MySQLModeler.quoteListOrValue(index.fields) + '),\n';
      });
    }

    let lines = [];

    this._events.emit('beforeEndColumnDefinition:' + entityName, lines);

    if (lines.length > 0) {
      sql += '  ' + lines.join(',\n  ');
    } else {
      sql = sql.substr(0, sql.length - 2);
    }

    sql += '\n)';
    let extraProps = {};

    this._events.emit('setTableOptions:' + entityName, extraProps);

    let props = Object.assign({}, this._dbOptions.table, extraProps);
    sql = _.reduce(props, function (result, value, key) {
      return result + ' ' + key + '=' + value;
    }, sql);
    sql += ';\n';
    return sql;
  }

  _addForeignKeyStatement(entityName, relation) {
    let sql = 'ALTER TABLE `' + entityName + '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' + 'REFERENCES `' + relation.right + '` (`' + relation.rightField + '`) ';
    sql += '';

    if (this._relationEntities[entityName]) {
      sql += 'ON DELETE CASCADE ON UPDATE CASCADE';
    } else {
      sql += 'ON DELETE NO ACTION ON UPDATE NO ACTION';
    }

    sql += ';\n';
    return sql;
  }

  static foreignKeyFieldNaming(entityName, entity) {
    let leftPart = Util._.camelCase(entityName);

    let rightPart = Util.pascalCase(entity.key);

    if (_.endsWith(leftPart, rightPart)) {
      return leftPart;
    }

    return leftPart + rightPart;
  }

  static quoteString(str) {
    return "'" + str.replace(/'/g, "\\'") + "'";
  }

  static quoteIdentifier(str) {
    return "`" + str + "`";
  }

  static quoteListOrValue(obj) {
    return _.isArray(obj) ? obj.map(v => MySQLModeler.quoteIdentifier(v)).join(', ') : MySQLModeler.quoteIdentifier(obj);
  }

  static complianceCheck(entity) {
    let result = {
      errors: [],
      warnings: []
    };

    if (!entity.key) {
      result.errors.push('Primary key is not specified.');
    }

    return result;
  }

  static columnDefinition(field, isProc) {
    let col;

    switch (field.type) {
      case 'integer':
        col = MySQLModeler.intColumnDefinition(field);
        break;

      case 'number':
        col = MySQLModeler.floatColumnDefinition(field);
        break;

      case 'text':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'boolean':
        col = MySQLModeler.boolColumnDefinition(field);
        break;

      case 'binary':
        col = MySQLModeler.binaryColumnDefinition(field);
        break;

      case 'datetime':
        col = MySQLModeler.datetimeColumnDefinition(field);
        break;

      case 'object':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      case 'enum':
        col = MySQLModeler.enumColumnDefinition(field);
        break;

      case 'array':
        col = MySQLModeler.textColumnDefinition(field);
        break;

      default:
        throw new Error('Unsupported type "' + field.type + '".');
    }

    let {
      sql,
      type
    } = col;

    if (!isProc) {
      sql += this.columnNullable(field);
      sql += this.defaultValue(field, type);
    }

    return sql;
  }

  static intColumnDefinition(info) {
    let sql, type;

    if (info.digits) {
      if (info.digits > 10) {
        type = sql = 'BIGINT';
      } else if (info.digits > 7) {
        type = sql = 'INT';
      } else if (info.digits > 4) {
        type = sql = 'MEDIUMINT';
      } else if (info.digits > 2) {
        type = sql = 'SMALLINT';
      } else {
        type = sql = 'TINYINT';
      }

      sql += `(${info.digits})`;
    } else {
      type = sql = 'INT';
    }

    if (info.unsigned) {
      sql += ' UNSIGNED';
    }

    return {
      sql,
      type
    };
  }

  static floatColumnDefinition(info) {
    let sql = '',
        type;

    if (info.type == 'number' && info.exact) {
      type = sql = 'DECIMAL';

      if (info.totalDigits > 65) {
        throw new Error('Total digits exceed maximum limit.');
      }
    } else {
      if (info.totalDigits > 23) {
        type = sql = 'DOUBLE';

        if (info.totalDigits > 53) {
          throw new Error('Total digits exceed maximum limit.');
        }
      } else {
        type = sql = 'FLOAT';
      }
    }

    if ('totalDigits' in info) {
      sql += '(' + info.totalDigits;

      if ('decimalDigits' in info) {
        sql += ', ' + info.decimalDigits;
      }

      sql += ')';
    } else {
      if ('decimalDigits' in info) {
        if (info.decimalDigits > 23) {
          sql += '(53, ' + info.decimalDigits + ')';
        } else {
          sql += '(23, ' + info.decimalDigits + ')';
        }
      }
    }

    return {
      sql,
      type
    };
  }

  static textColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength && info.fixedLength <= 255) {
      sql = 'CHAR(' + info.fixedLength + ')';
      type = 'CHAR';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGTEXT';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMTEXT';
      } else if (info.maxLength > 2000) {
        type = sql = 'TEXT';
      } else {
        type = sql = 'VARCHAR';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'TEXT';
    }

    return {
      sql,
      type
    };
  }

  static binaryColumnDefinition(info) {
    let sql = '',
        type;

    if (info.fixedLength <= 255) {
      sql = 'BINARY(' + info.fixedLength + ')';
      type = 'BINARY';
    } else if (info.maxLength) {
      if (info.maxLength > 16777215) {
        type = sql = 'LONGBLOB';
      } else if (info.maxLength > 65535) {
        type = sql = 'MEDIUMBLOB';
      } else {
        type = sql = 'VARBINARY';

        if (info.fixedLength) {
          sql += '(' + info.fixedLength + ')';
        } else {
          sql += '(' + info.maxLength + ')';
        }
      }
    } else {
      type = sql = 'BLOB';
    }

    return {
      sql,
      type
    };
  }

  static boolColumnDefinition() {
    return {
      sql: 'TINYINT(1)',
      type: 'TINYINT'
    };
  }

  static datetimeColumnDefinition(info) {
    let sql;

    if (!info.range || info.range === 'datetime') {
      sql = 'DATETIME';
    } else if (info.range === 'date') {
      sql = 'DATE';
    } else if (info.range === 'time') {
      sql = 'TIME';
    } else if (info.range === 'year') {
      sql = 'YEAR';
    } else if (info.range === 'timestamp') {
      sql = 'TIMESTAMP';
    }

    return {
      sql,
      type: sql
    };
  }

  static enumColumnDefinition(info) {
    return {
      sql: 'ENUM(' + _.map(info.values, v => MySQLModeler.quoteString(v)).join(', ') + ')',
      type: 'ENUM'
    };
  }

  static columnNullable(info) {
    if (info.hasOwnProperty('optional') && info.optional) {
      return ' NULL';
    }

    return ' NOT NULL';
  }

  static defaultValue(info, type) {
    if (info.isCreateTimestamp) {
      info.createByDb = true;
      return ' DEFAULT CURRENT_TIMESTAMP';
    }

    if (info.autoIncrementId) {
      info.createByDb = true;
      return ' AUTO_INCREMENT';
    }

    if (info.isUpdateTimestamp) {
      info.updateByDb = true;
      return ' ON UPDATE CURRENT_TIMESTAMP';
    }

    let sql = '';

    if (!info.optional) {
      if (info.hasOwnProperty('default')) {
        let defaultValue = info['default'];

        if (info.type === 'boolean') {
          sql += ' DEFAULT ' + (Types.BOOLEAN.sanitize(defaultValue) ? '1' : '0');
        }
      } else if (!info.hasOwnProperty('auto')) {
        if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
          return '';
        }

        if (info.type === 'boolean' || info.type === 'integer' || info.type === 'number') {
          sql += ' DEFAULT 0';
        } else if (info.type === 'datetime') {
          sql += ' DEFAULT CURRENT_TIMESTAMP';
        } else {
          sql += ' DEFAULT ""';
        }

        info.createByDb = true;
      }
    }

    return sql;
  }

  static removeTableNamePrefix(entityName, removeTablePrefix) {
    if (removeTablePrefix) {
      entityName = _.trim(_.snakeCase(entityName));
      removeTablePrefix = _.trimEnd(_.snakeCase(removeTablePrefix), '_') + '_';

      if (_.startsWith(entityName, removeTablePrefix)) {
        entityName = entityName.substr(removeTablePrefix.length);
      }
    }

    return OolUtils.entityNaming(entityName);
  }

}

module.exports = MySQLModeler;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjb25uZWN0ZWRCeSIsImNiIiwic3BsaXQiLCJjb25uZWN0ZWRXaXRoIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwic3JjRmllbGQiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvcHRpb25hbCIsInJlbW90ZUZpZWxkIiwicmVmZXJzVG9GaWVsZCIsImlzTGlzdCIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiYW5jaG9yIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwidW5kZWZpbmVkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImZpZWxkIiwiZ2VuZXJhdG9yIiwiYXV0b0luY3JlbWVudElkIiwib24iLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5IiwibWFwIiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJzdGFydEluZGV4IiwiayIsInN1YkRvY3VtZW50cyIsImZpZWxkTmFtZSIsInN1YkNvbExpc3QiLCJzdWJBbGlhcyIsInN1YkpvaW5zIiwic3RhcnRJbmRleDIiLCJjb25jYXQiLCJsaW5rV2l0aEZpZWxkIiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleGVzIiwiaW5kZXgiLCJ1bmlxdWUiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlZHVjZSIsInJlbGF0aW9uIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJ2IiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRoIiwi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QUF5QnVOLGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDdk4sUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUMrSyxNQUFYLENBQWtCd0MsaUJBQWlCLENBQUNsTixNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPM0QsUUFBUSxDQUFDNkcsWUFBVCxDQUFzQnZELFVBQXRCLENBQVA7QUFDSDs7QUE3a0NjOztBQWdsQ25CNE4sTUFBTSxDQUFDQyxPQUFQLEdBQWlCOVEsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwbHVyYWxpemUgPSByZXF1aXJlKCdwbHVyYWxpemUnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgZXhpc3RpbmdFbnRpdGllcyA9IE9iamVjdC52YWx1ZXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIF8uZWFjaChleGlzdGluZ0VudGl0aWVzLCAoZW50aXR5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyB0eXBlczogWyAncmVmZXJzVG8nIF0sIGFzc29jaWF0aW9uOiBhc3NvYyB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IGNvbm5lY3RlZEJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpWzBdIH07XG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRXaXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy5jb25uZWN0ZWRXaXRoID0gYXNzb2MuY29ubmVjdGVkV2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OjokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIsIGFzc29jLmNvbm5lY3RlZFdpdGgsIGxvY2FsRmllbGROYW1lKSB9IDoge30pIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZGVzdEVudGl0eSwgY29ubkVudGl0eSwgZW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkMiwgY29ubmVjdGVkQnlGaWVsZCwgYmFja1JlZi5jb25uZWN0ZWRXaXRoLCByZW1vdGVGaWVsZE5hbWUpIH0gOiB7fSkgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQmFjayByZWZlcmVuY2Ugbm90IGZvdW5kLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUHJvcHMgPSB7IC4uLl8ub21pdChkZXN0S2V5RmllbGQsIFsnb3B0aW9uYWwnXSksIC4uLl8ucGljayhhc3NvYywgWydvcHRpb25hbCddKSB9O1xuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCBcbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiBmYWxzZSwgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgbnVsbCwgeyB0eXBlczogWyAncmVmZXJzVG8nLCAnYmVsb25nc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiB0cnVlLCByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNMaXN0OiBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JywgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBsb2NhbEZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGxvY2FsRmllbGROYW1lLCByZW1vdGVGaWVsZE5hbWUsIG9vbENvbiwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIFtjb25uRW50aXR5Lm5hbWVdIDogYW5jaG9yXG4gICAgICAgIH07ICAgICAgICBcblxuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmKSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmllbGQuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5lYWNoKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCBhc3NvYyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MS5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkxLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTIubmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5Mi5uYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkyID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgaWYgKGhhc1JlZlRvRW50aXR5MSAmJiBoYXNSZWZUb0VudGl0eTIpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MS5uYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTIubmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwgXy5vbWl0KGtleUVudGl0eTEsIFsnb3B0aW9uYWwnXSkpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBfLm9taXQoa2V5RW50aXR5MiwgWydvcHRpb25hbCddKSk7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIGVudGl0eTFcbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICBlbnRpdHkyXG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MS5uYW1lLCBrZXlFbnRpdHkxLm5hbWUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Mi5uYW1lLCBrZXlFbnRpdHkyLm5hbWUpO1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH1cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWxhdGlvbi5yaWdodCArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==