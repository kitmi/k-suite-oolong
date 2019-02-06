"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const pluralize = require('pluralize');

const path = require('path');

const ntol = require('number-to-letter');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote
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
        } else if (info.type === 'enum') {
          sql += ' DEFAULT ' + quote(info.values[0]);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImZvckVhY2giLCJhc3NvYyIsIl9wcm9jZXNzQXNzb2NpYXRpb24iLCJlbWl0Iiwic3FsRmlsZXNEaXIiLCJqb2luIiwiZGF0YWJhc2UiLCJkYkZpbGVQYXRoIiwiZmtGaWxlUGF0aCIsImluaXRJZHhGaWxlUGF0aCIsImluaXRGaWxlUGF0aCIsInRhYmxlU1FMIiwicmVsYXRpb25TUUwiLCJkYXRhIiwiZW50aXR5TmFtZSIsImFkZEluZGV4ZXMiLCJyZXN1bHQiLCJjb21wbGlhbmNlQ2hlY2siLCJlcnJvcnMiLCJsZW5ndGgiLCJtZXNzYWdlIiwid2FybmluZ3MiLCJFcnJvciIsImZlYXR1cmVzIiwiZm9yT3duIiwiZiIsImZlYXR1cmVOYW1lIiwiQXJyYXkiLCJpc0FycmF5IiwiZmYiLCJfZmVhdHVyZVJlZHVjZXIiLCJfY3JlYXRlVGFibGVTdGF0ZW1lbnQiLCJlbnRpdHlEYXRhIiwicmVjb3JkIiwiaXNQbGFpbk9iamVjdCIsImZpZWxkcyIsImtleXMiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJleGlzdHNTeW5jIiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsInR5cGUiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJzcmNGaWVsZCIsImhhcyIsImNvbm5lY3RlZEJ5UGFydHMyIiwiY29ubmVjdGVkQnlGaWVsZDIiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwibG9jYWxGaWVsZE5hbWUiLCJhZGRBc3NvY2lhdGlvbiIsIm9wdGlvbmFsIiwicmVtb3RlRmllbGQiLCJyZWZlcnNUb0ZpZWxkIiwiaXNMaXN0IiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJsb2NhbEZpZWxkIiwiZmllbGRQcm9wcyIsIm9taXQiLCJwaWNrIiwiYWRkQXNzb2NGaWVsZCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJhbmNob3IiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJtYXAiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0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LENBQVAsQ0FBYjtBQUVBdU4sTUFBQUEsaUJBQWlCLEdBQUdoUixDQUFDLENBQUNtUixPQUFGLENBQVVuUixDQUFDLENBQUNrUixTQUFGLENBQVlGLGlCQUFaLENBQVYsRUFBMEMsR0FBMUMsSUFBaUQsR0FBckU7O0FBRUEsVUFBSWhSLENBQUMsQ0FBQ29SLFVBQUYsQ0FBYTNOLFVBQWIsRUFBeUJ1TixpQkFBekIsQ0FBSixFQUFpRDtBQUM3Q3ZOLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDK0ssTUFBWCxDQUFrQndDLGlCQUFpQixDQUFDbE4sTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBTzNELFFBQVEsQ0FBQzZHLFlBQVQsQ0FBc0J2RCxVQUF0QixDQUFQO0FBQ0g7O0FBL2tDYzs7QUFrbENuQjROLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQjlRLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGx1cmFsaXplID0gcmVxdWlyZSgncGx1cmFsaXplJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYykge1xuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IHR5cGVzOiBbICdyZWZlcnNUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgY29ubmVjdGVkQnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJylbMF0gfTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLmNvbm5lY3RlZFdpdGggPSBhc3NvYy5jb25uZWN0ZWRXaXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHlOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNvbm5lY3RlZEJ5XCIgcmVxdWlyZWQgZm9yIG06biByZWxhdGlvbi4gU291cmNlOiAke2VudGl0eS5uYW1lfSwgZGVzdGluYXRpb246ICR7ZGVzdEVudGl0eU5hbWV9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuY29ubmVjdGVkQnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5Lm5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImNvbm5lY3RlZEJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5FbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyc1RvRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMiwgYXNzb2MuY29ubmVjdGVkV2l0aCwgbG9jYWxGaWVsZE5hbWUpIH0gOiB7fSkgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5FbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihkZXN0RW50aXR5LCBjb25uRW50aXR5LCBlbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQyLCBjb25uZWN0ZWRCeUZpZWxkLCBiYWNrUmVmLmNvbm5lY3RlZFdpdGgsIHJlbW90ZUZpZWxkTmFtZSkgfSA6IHt9KSAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGNvbm5lY3RlZEJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdCYWNrIHJlZmVyZW5jZSBub3QgZm91bmQuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsIFxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IGZhbHNlLCBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBudWxsLCB7IHR5cGVzOiBbICdyZWZlcnNUbycsICdiZWxvbmdzVG8nIF0sIGFzc29jaWF0aW9uOiBhc3NvYyB9KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdXJhbGl6ZShlbnRpdHkubmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IHRydWUsIHJlbW90ZUZpZWxkOiBsb2NhbEZpZWxkIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0xpc3Q6IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgbG9jYWxGaWVsZE5hbWUsIHJlbW90ZUZpZWxkTmFtZSwgb29sQ29uLCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgW2Nvbm5FbnRpdHkubmFtZV0gOiBhbmNob3JcbiAgICAgICAgfTsgICAgICAgIFxuXG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuXG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmaWVsZC5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7XG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgZW50aXR5MVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIGVudGl0eTJcbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=