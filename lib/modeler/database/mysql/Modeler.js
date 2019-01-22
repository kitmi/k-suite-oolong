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
                [fields[1]]: record
              };
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
                [fields[1]]: record
              };
            } else {
              record = Object.assign({
                [entity.key]: key
              }, record);
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
        throw new Error('todo');
        break;

      case 'hasMany':
        let backRef = destEntity.getReferenceTo(entity.name, assoc.connectedBy);

        if (backRef) {
          if (backRef.type === 'hasMany') {
            let connEntityName = OolUtils.entityNaming(assoc.connectedBy);

            if (!connEntityName) {
              throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
            }

            let tag1 = `${entity.name}:m-${destEntityName}:n by ${connEntityName}`;
            let tag2 = `${destEntityName}:m-${entity.name}:n by ${connEntityName}`;

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            let connEntity = schema.entities[connEntityName];

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, entity, destEntity);
            }

            this._updateRelationEntity(connEntity, entity, destEntity);

            this._processedRef.add(tag1);

            this._processedRef.add(tag2);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.connectedBy) {
              throw new Error('todo: belongsTo connectedBy');
            } else {}
          } else {
            if (!(backRef.type === 'hasOne')) {
              throw new Error("Assertion failed: backRef.type === 'hasOne'");
            }

            throw new Error('todo: Many to one');
          }
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityName;
        let fieldProps = { ..._.omit(destKeyField, ['optional']),
          ..._.pick(assoc, ['optional'])
        };
        entity.addAssocField(localField, destEntity, fieldProps);

        this._addReference(entity.name, localField, destEntityName, destKeyField.name);

        break;
    }
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

  _buildRelation(schema, relation) {
    this.logger.log('debug', 'Analyzing relation between [' + relation.left + '] and [' + relation.right + '] relationship: ' + relation.relationship + ' ...');

    if (relation.relationship === 'n:n') {
      this._buildNToNRelation(schema, relation);
    } else if (relation.relationship === '1:n') {
      this._buildOneToAnyRelation(schema, relation, false);
    } else if (relation.relationship === '1:1') {
      this._buildOneToAnyRelation(schema, relation, true);
    } else if (relation.relationship === 'n:1') {
      this._buildManyToOneRelation(schema, relation);
    } else {
      console.log(relation);
      throw new Error('TBD');
    }
  }

  _buildManyToOneRelation(schema, relation) {
    let leftEntity = schema.entities[relation.left];
    let rightEntity = schema.entities[relation.right];
    let rightKeyInfo = rightEntity.getKeyField();
    let leftField = relation.leftField || MySQLModeler.foreignKeyFieldNaming(relation.right, rightEntity);

    let fieldInfo = this._refineLeftField(rightKeyInfo);

    if (relation.optional) {
      fieldInfo.optional = true;
    }

    leftEntity.addField(leftField, fieldInfo);

    this._addReference(relation.left, leftField, relation.right, rightEntity.key);
  }

  _buildOneToAnyRelation(schema, relation, unique) {
    let leftEntity = schema.entities[relation.left];
    let rightEntity = schema.entities[relation.right];
    let rightKeyInfo = rightEntity.getKeyField();
    let leftField = relation.leftField || MySQLModeler.foreignKeyFieldNaming(relation.right, rightEntity);

    let fieldInfo = this._refineLeftField(rightKeyInfo);

    if (relation.optional) {
      fieldInfo.optional = true;
    }

    leftEntity.addField(leftField, fieldInfo);

    this._addReference(relation.left, leftField, relation.right, rightEntity.key);

    if (relation.multi && _.last(relation.multi) === relation.right) {
      this._events.on('afterRelationshipBuilding', () => {
        let index = {
          fields: _.map(relation.multi, to => MySQLModeler.foreignKeyFieldNaming(to, schema.entities[to])),
          unique: unique
        };
        leftEntity.addIndex(index);
      });
    }
  }

  _buildNToNRelation(schema, relation) {
    let relationEntityName = relation.left + Util.pascalCase(pluralize.plural(relation.right));

    if (schema.hasEntity(relationEntityName)) {
      let fullName = schema.entities[relationEntityName].id;
      throw new Error(`Entity [${relationEntityName}] conflicts with entity [${fullName}] in schema [${schema.name}].`);
    }

    this.logger.log('debug', `Create a relation entity for "${relation.left}" and "${relation.right}".`);
    let leftEntity = schema.entities[relation.left];
    let rightEntity = schema.entities[relation.right];
    let leftKeyInfo = leftEntity.getKeyField();
    let rightKeyInfo = rightEntity.getKeyField();

    if (Array.isArray(leftKeyInfo) || Array.isArray(rightKeyInfo)) {
      throw new Error('Multi-fields key not supported for non-relationship entity.');
    }

    let leftField1 = MySQLModeler.foreignKeyFieldNaming(relation.left, leftEntity);
    let leftField2 = MySQLModeler.foreignKeyFieldNaming(relation.right, rightEntity);
    let entityInfo = {
      features: ['createTimestamp'],
      fields: {
        [leftField1]: leftKeyInfo,
        [leftField2]: rightKeyInfo
      },
      key: [leftField1, leftField2]
    };
    let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
    entity.link();
    entity.markAsRelationshipEntity();

    this._addReference(relationEntityName, leftField1, relation.left, leftEntity.key);

    this._addReference(relationEntityName, leftField2, relation.right, rightEntity.key);

    schema.addEntity(relationEntityName, entity);
  }

  _refineLeftField(fieldInfo) {
    return Object.assign(_.pick(fieldInfo, Oolong.BUILTIN_TYPE_ATTR), {
      isReference: true
    });
  }

  _writeFile(filePath, content) {
    fs.ensureFileSync(filePath);
    fs.writeFileSync(filePath, content);
    this.logger.log('info', 'Generated db script: ' + filePath);
  }

  _addRelationEntity(schema, relationEntityName, entity1, entity2) {
    let entityInfo = {
      features: ['createTimestamp'],
      key: [entity1.name, entity2.name]
    };
    let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
    entity.link();
    schema.addEntity(entity);
    return entity;
  }

  _updateRelationEntity(relationEntity, entity1, entity2) {
    let relationEntityName = relationEntity.name;
    let keyEntity1 = entity1.getKeyField();

    if (Array.isArray(keyEntity1)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity1.name}`);
    }

    let keyEntity2 = entity2.getKeyField();

    if (Array.isArray(keyEntity2)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity2.name}`);
    }

    relationEntity.addAssocField(entity1.name, entity1, _.omit(keyEntity1, ['optional']));
    relationEntity.addAssocField(entity2.name, entity2, _.omit(keyEntity2, ['optional']));

    this._addReference(relationEntityName, entity1.name, entity1.name, keyEntity1.name);

    this._addReference(relationEntityName, entity2.name, entity2.name, keyEntity2.name);

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

    if (info.type == 'decimal') {
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

    if (!info.optional && !info.hasOwnProperty('default') && !info.hasOwnProperty('auto')) {
      if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
        return '';
      }

      if (info.type === 'bool' || info.type === 'int' || info.type === 'float' || info.type === 'decimal') {
        sql += ' DEFAULT 0';
      } else {
        sql += ' DEFAULT ""';
      }

      info.createByDb = true;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwicHVzaCIsImFzc2lnbiIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiSlNPTiIsInN0cmluZ2lmeSIsImV4aXN0c1N5bmMiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImdldEtleUZpZWxkIiwidHlwZSIsImJhY2tSZWYiLCJnZXRSZWZlcmVuY2VUbyIsImNvbm5lY3RlZEJ5IiwiY29ubkVudGl0eU5hbWUiLCJlbnRpdHlOYW1pbmciLCJ0YWcxIiwidGFnMiIsImhhcyIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJhZGQiLCJsb2NhbEZpZWxkIiwic3JjRmllbGQiLCJmaWVsZFByb3BzIiwib21pdCIsInBpY2siLCJhZGRBc3NvY0ZpZWxkIiwiX2FkZFJlZmVyZW5jZSIsImxlZnQiLCJsZWZ0RmllbGQiLCJyaWdodCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJfYnVpbGRSZWxhdGlvbiIsInJlbGF0aW9uIiwicmVsYXRpb25zaGlwIiwiX2J1aWxkTlRvTlJlbGF0aW9uIiwiX2J1aWxkT25lVG9BbnlSZWxhdGlvbiIsIl9idWlsZE1hbnlUb09uZVJlbGF0aW9uIiwiY29uc29sZSIsImxlZnRFbnRpdHkiLCJyaWdodEVudGl0eSIsInJpZ2h0S2V5SW5mbyIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImZpZWxkSW5mbyIsIl9yZWZpbmVMZWZ0RmllbGQiLCJvcHRpb25hbCIsImFkZEZpZWxkIiwidW5pcXVlIiwibXVsdGkiLCJsYXN0IiwiaW5kZXgiLCJtYXAiLCJ0byIsImFkZEluZGV4IiwicmVsYXRpb25FbnRpdHlOYW1lIiwicGFzY2FsQ2FzZSIsInBsdXJhbCIsImhhc0VudGl0eSIsImZ1bGxOYW1lIiwiaWQiLCJsZWZ0S2V5SW5mbyIsImxlZnRGaWVsZDEiLCJsZWZ0RmllbGQyIiwiZW50aXR5SW5mbyIsIm9vbE1vZHVsZSIsImxpbmsiLCJtYXJrQXNSZWxhdGlvbnNoaXBFbnRpdHkiLCJhZGRFbnRpdHkiLCJPb2xvbmciLCJCVUlMVElOX1RZUEVfQVRUUiIsImlzUmVmZXJlbmNlIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiZW50aXR5MSIsImVudGl0eTIiLCJyZWxhdGlvbkVudGl0eSIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0Iiwic3RhcnRJbmRleCIsImsiLCJzdWJEb2N1bWVudHMiLCJmaWVsZE5hbWUiLCJzdWJDb2xMaXN0Iiwic3ViQWxpYXMiLCJzdWJKb2lucyIsInN0YXJ0SW5kZXgyIiwiY29uY2F0IiwibGlua1dpdGhGaWVsZCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXhlcyIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxZQUFZLEdBQUdDLE9BQU8sQ0FBQyxRQUFELENBQTVCOztBQUNB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QUFpRDtBQUM3Q2xOLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDZ0wsTUFBWCxDQUFrQmtDLGlCQUFpQixDQUFDN00sTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBTzNELFFBQVEsQ0FBQ2tHLFlBQVQsQ0FBc0I1QyxVQUF0QixDQUFQO0FBQ0g7O0FBemhDYzs7QUE0aENuQnVOLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnpRLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGx1cmFsaXplID0gcmVxdWlyZSgncGx1cmFsaXplJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZmllbGRzWzFdXTogcmVjb3JkfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiByZWNvcmR9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYykge1xuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG8nKTtcbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBhc3NvYy5jb25uZWN0ZWRCeSk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoYXNzb2MuY29ubmVjdGVkQnkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHlOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNvbm5lY3RlZEJ5XCIgcmVxdWlyZWQgZm9yIG06biByZWxhdGlvbi4gU291cmNlOiAke2VudGl0eS5uYW1lfSwgZGVzdGluYXRpb246ICR7ZGVzdEVudGl0eU5hbWV9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTptLSR7ZGVzdEVudGl0eU5hbWV9Om4gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06bS0ke2VudGl0eS5uYW1lfTpuIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHksIGRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGNvbm5lY3RlZEJ5Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IE1hbnkgdG8gb25lJyk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgIGxldCBmaWVsZFByb3BzID0geyAuLi5fLm9taXQoZGVzdEtleUZpZWxkLCBbJ29wdGlvbmFsJ10pLCAuLi5fLnBpY2soYXNzb2MsIFsnb3B0aW9uYWwnXSkgfTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGZpZWxkUHJvcHMpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuXG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmaWVsZC5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYnVpbGRSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQW5hbHl6aW5nIHJlbGF0aW9uIGJldHdlZW4gWydcbiAgICAgICAgKyByZWxhdGlvbi5sZWZ0ICsgJ10gYW5kIFsnXG4gICAgICAgICsgcmVsYXRpb24ucmlnaHQgKyAnXSByZWxhdGlvbnNoaXA6ICdcbiAgICAgICAgKyByZWxhdGlvbi5yZWxhdGlvbnNoaXAgKyAnIC4uLicpO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICduOm4nKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE5Ub05SZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICcxOm4nKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE9uZVRvQW55UmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbiwgZmFsc2UpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlbGF0aW9uLnJlbGF0aW9uc2hpcCA9PT0gJzE6MScpIHtcbiAgICAgICAgICAgIHRoaXMuX2J1aWxkT25lVG9BbnlSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uLCB0cnVlKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICduOjEnKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE1hbnlUb09uZVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24pO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgY29uc29sZS5sb2cocmVsYXRpb24pO1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUQkQnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9idWlsZE1hbnlUb09uZVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24pIHtcbiAgICAgICAgbGV0IGxlZnRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ubGVmdF07XG4gICAgICAgIGxldCByaWdodEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5yaWdodF07XG5cbiAgICAgICAgbGV0IHJpZ2h0S2V5SW5mbyA9IHJpZ2h0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGxldCBsZWZ0RmllbGQgPSByZWxhdGlvbi5sZWZ0RmllbGQgfHwgTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkpO1xuXG4gICAgICAgIGxldCBmaWVsZEluZm8gPSB0aGlzLl9yZWZpbmVMZWZ0RmllbGQocmlnaHRLZXlJbmZvKTtcbiAgICAgICAgaWYgKHJlbGF0aW9uLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICBmaWVsZEluZm8ub3B0aW9uYWwgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGxlZnRFbnRpdHkuYWRkRmllbGQobGVmdEZpZWxkLCBmaWVsZEluZm8pO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbi5sZWZ0LCBsZWZ0RmllbGQsIHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eS5rZXkpO1xuICAgIH1cblxuICAgIF9idWlsZE9uZVRvQW55UmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbiwgdW5pcXVlKSB7XG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuXG4gICAgICAgIGxldCByaWdodEtleUluZm8gPSByaWdodEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgbGVmdEZpZWxkID0gcmVsYXRpb24ubGVmdEZpZWxkIHx8IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5KTtcblxuICAgICAgICBsZXQgZmllbGRJbmZvID0gdGhpcy5fcmVmaW5lTGVmdEZpZWxkKHJpZ2h0S2V5SW5mbyk7XG4gICAgICAgIGlmIChyZWxhdGlvbi5vcHRpb25hbCkge1xuICAgICAgICAgICAgZmllbGRJbmZvLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBsZWZ0RW50aXR5LmFkZEZpZWxkKGxlZnRGaWVsZCwgZmllbGRJbmZvKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb24ubGVmdCwgbGVmdEZpZWxkLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAocmVsYXRpb24ubXVsdGkgJiYgXy5sYXN0KHJlbGF0aW9uLm11bHRpKSA9PT0gcmVsYXRpb24ucmlnaHQpIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJywgKCkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBpbmRleCA9IHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGRzOiBfLm1hcChyZWxhdGlvbi5tdWx0aSwgdG8gPT4gTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyh0bywgc2NoZW1hLmVudGl0aWVzW3RvXSkpLFxuICAgICAgICAgICAgICAgICAgICB1bmlxdWU6IHVuaXF1ZVxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBsZWZ0RW50aXR5LmFkZEluZGV4KGluZGV4KTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2J1aWxkTlRvTlJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24pIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uLmxlZnQgKyBVdGlsLnBhc2NhbENhc2UocGx1cmFsaXplLnBsdXJhbChyZWxhdGlvbi5yaWdodCkpO1xuXG4gICAgICAgIGlmIChzY2hlbWEuaGFzRW50aXR5KHJlbGF0aW9uRW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIGxldCBmdWxsTmFtZSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdLmlkO1xuXG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBbJHtyZWxhdGlvbkVudGl0eU5hbWV9XSBjb25mbGljdHMgd2l0aCBlbnRpdHkgWyR7ZnVsbE5hbWV9XSBpbiBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgQ3JlYXRlIGEgcmVsYXRpb24gZW50aXR5IGZvciBcIiR7cmVsYXRpb24ubGVmdH1cIiBhbmQgXCIke3JlbGF0aW9uLnJpZ2h0fVwiLmApO1xuICAgICAgICBcbiAgICAgICAgbGV0IGxlZnRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ubGVmdF07XG4gICAgICAgIGxldCByaWdodEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5yaWdodF07XG4gICAgICAgIFxuICAgICAgICBsZXQgbGVmdEtleUluZm8gPSBsZWZ0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGxldCByaWdodEtleUluZm8gPSByaWdodEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEtleUluZm8pIHx8IEFycmF5LmlzQXJyYXkocmlnaHRLZXlJbmZvKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdNdWx0aS1maWVsZHMga2V5IG5vdCBzdXBwb3J0ZWQgZm9yIG5vbi1yZWxhdGlvbnNoaXAgZW50aXR5LicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxlZnRGaWVsZDEgPSBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLmxlZnQsIGxlZnRFbnRpdHkpO1xuICAgICAgICBsZXQgbGVmdEZpZWxkMiA9IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5KTtcbiAgICAgICAgXG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGZpZWxkczoge1xuICAgICAgICAgICAgICAgIFtsZWZ0RmllbGQxXTogbGVmdEtleUluZm8sXG4gICAgICAgICAgICAgICAgW2xlZnRGaWVsZDJdOiByaWdodEtleUluZm9cbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBrZXk6IFsgbGVmdEZpZWxkMSwgbGVmdEZpZWxkMiBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG4gICAgICAgIGVudGl0eS5tYXJrQXNSZWxhdGlvbnNoaXBFbnRpdHkoKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBsZWZ0RmllbGQxLCByZWxhdGlvbi5sZWZ0LCBsZWZ0RW50aXR5LmtleSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGxlZnRGaWVsZDIsIHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eS5rZXkpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkocmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkpO1xuICAgIH1cblxuICAgIF9yZWZpbmVMZWZ0RmllbGQoZmllbGRJbmZvKSB7XG4gICAgICAgIHJldHVybiBPYmplY3QuYXNzaWduKF8ucGljayhmaWVsZEluZm8sIE9vbG9uZy5CVUlMVElOX1RZUEVfQVRUUiksIHsgaXNSZWZlcmVuY2U6IHRydWUgfSk7XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MSwgZW50aXR5Mikge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MS5uYW1lLCBlbnRpdHkyLm5hbWUgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5Mikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTEubmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyLm5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGVudGl0eTEubmFtZSwgZW50aXR5MSwgXy5vbWl0KGtleUVudGl0eTEsIFsnb3B0aW9uYWwnXSkpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGVudGl0eTIubmFtZSwgZW50aXR5MiwgXy5vbWl0KGtleUVudGl0eTIsIFsnb3B0aW9uYWwnXSkpO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTEubmFtZSwgZW50aXR5MS5uYW1lLCBrZXlFbnRpdHkxLm5hbWUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkyLm5hbWUsIGVudGl0eTIubmFtZSwga2V5RW50aXR5Mi5uYW1lKTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbE9wVG9TcWwob3ApIHtcbiAgICAgICAgc3dpdGNoIChvcCkge1xuICAgICAgICAgICAgY2FzZSAnPSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuICc9JztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbE9wVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7ICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgIGxldCBsZWZ0LCByaWdodDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAob29sLmxlZnQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wubGVmdCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gb29sLmxlZnQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5yaWdodC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wucmlnaHQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBvb2wucmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgJyAnICsgTXlTUUxNb2RlbGVyLm9vbE9wVG9TcWwob29sLm9wZXJhdG9yKSArICcgJyArIHJpZ2h0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdPYmplY3RSZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgIGlmICghT29sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IE9vbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9XG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVsYXRpb24ucmlnaHQgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9ICcnO1xuXG4gICAgICAgIGlmICh0aGlzLl9yZWxhdGlvbkVudGl0aWVzW2VudGl0eU5hbWVdKSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBDQVNDQURFIE9OIFVQREFURSBDQVNDQURFJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIE5PIEFDVElPTiBPTiBVUERBVEUgTk8gQUNUSU9OJztcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdkZWNpbWFsJykge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsICYmICFpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcgfHwgaW5mby50eXBlID09PSAnaW50JyB8fCBpbmZvLnR5cGUgPT09ICdmbG9hdCcgfHwgaW5mby50eXBlID09PSAnZGVjaW1hbCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=