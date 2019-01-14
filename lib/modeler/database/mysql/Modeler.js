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
      info.defaultByDb = true;
      return ' DEFAULT CURRENT_TIMESTAMP';
    }

    if (info.autoIncrementId) {
      info.defaultByDb = true;
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

      info.defaultByDb = true;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwicHVzaCIsImFzc2lnbiIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiSlNPTiIsInN0cmluZ2lmeSIsImV4aXN0c1N5bmMiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImdldEtleUZpZWxkIiwidHlwZSIsImJhY2tSZWYiLCJnZXRSZWZlcmVuY2VUbyIsImNvbm5lY3RlZEJ5IiwiY29ubkVudGl0eU5hbWUiLCJlbnRpdHlOYW1pbmciLCJ0YWcxIiwidGFnMiIsImhhcyIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJhZGQiLCJsb2NhbEZpZWxkIiwic3JjRmllbGQiLCJmaWVsZFByb3BzIiwib21pdCIsInBpY2siLCJhZGRBc3NvY0ZpZWxkIiwiX2FkZFJlZmVyZW5jZSIsImxlZnQiLCJsZWZ0RmllbGQiLCJyaWdodCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJfYnVpbGRSZWxhdGlvbiIsInJlbGF0aW9uIiwicmVsYXRpb25zaGlwIiwiX2J1aWxkTlRvTlJlbGF0aW9uIiwiX2J1aWxkT25lVG9BbnlSZWxhdGlvbiIsIl9idWlsZE1hbnlUb09uZVJlbGF0aW9uIiwiY29uc29sZSIsImxlZnRFbnRpdHkiLCJyaWdodEVudGl0eSIsInJpZ2h0S2V5SW5mbyIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImZpZWxkSW5mbyIsIl9yZWZpbmVMZWZ0RmllbGQiLCJvcHRpb25hbCIsImFkZEZpZWxkIiwidW5pcXVlIiwibXVsdGkiLCJsYXN0IiwiaW5kZXgiLCJtYXAiLCJ0byIsImFkZEluZGV4IiwicmVsYXRpb25FbnRpdHlOYW1lIiwicGFzY2FsQ2FzZSIsInBsdXJhbCIsImhhc0VudGl0eSIsImZ1bGxOYW1lIiwiaWQiLCJsZWZ0S2V5SW5mbyIsImxlZnRGaWVsZDEiLCJsZWZ0RmllbGQyIiwiZW50aXR5SW5mbyIsIm9vbE1vZHVsZSIsImxpbmsiLCJtYXJrQXNSZWxhdGlvbnNoaXBFbnRpdHkiLCJhZGRFbnRpdHkiLCJPb2xvbmciLCJCVUlMVElOX1RZUEVfQVRUUiIsImlzUmVmZXJlbmNlIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiZW50aXR5MSIsImVudGl0eTIiLCJyZWxhdGlvbkVudGl0eSIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0Iiwic3RhcnRJbmRleCIsImsiLCJzdWJEb2N1bWVudHMiLCJmaWVsZE5hbWUiLCJzdWJDb2xMaXN0Iiwic3ViQWxpYXMiLCJzdWJKb2lucyIsInN0YXJ0SW5kZXgyIiwiY29uY2F0IiwibGlua1dpdGhGaWVsZCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXhlcyIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJkZWZhdWx0QnlEYiIsInVwZGF0ZUJ5RGIiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFD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RUFBaUQ7QUFDN0NsTixRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ2dMLE1BQVgsQ0FBa0JrQyxpQkFBaUIsQ0FBQzdNLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU8zRCxRQUFRLENBQUNrRyxZQUFULENBQXNCNUMsVUFBdEIsQ0FBUDtBQUNIOztBQS9nQ2M7O0FBa2hDbkJ1TixNQUFNLENBQUNDLE9BQVAsR0FBaUJ6USxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBsdXJhbGl6ZSA9IHJlcXVpcmUoJ3BsdXJhbGl6ZScpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcyB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2ZpZWxkc1sxXV06IHJlY29yZH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogcmVjb3JkfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgYXNzb2MuY29ubmVjdGVkQnkpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGFzc29jLmNvbm5lY3RlZEJ5KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06bS0ke2Rlc3RFbnRpdHlOYW1lfTpuIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9Om0tJHtlbnRpdHkubmFtZX06biBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5LCBkZXN0RW50aXR5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeScpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogYmFja1JlZi50eXBlID09PSAnaGFzT25lJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBNYW55IHRvIG9uZScpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmllbGQuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2J1aWxkUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbikge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0FuYWx5emluZyByZWxhdGlvbiBiZXR3ZWVuIFsnXG4gICAgICAgICsgcmVsYXRpb24ubGVmdCArICddIGFuZCBbJ1xuICAgICAgICArIHJlbGF0aW9uLnJpZ2h0ICsgJ10gcmVsYXRpb25zaGlwOiAnXG4gICAgICAgICsgcmVsYXRpb24ucmVsYXRpb25zaGlwICsgJyAuLi4nKTtcblxuICAgICAgICBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGROVG9OUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnMTpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIGZhbHNlKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICcxOjEnKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE9uZVRvQW55UmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbiwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjoxJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKHJlbGF0aW9uKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVEJEJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuXG4gICAgICAgIGxldCByaWdodEtleUluZm8gPSByaWdodEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgbGVmdEZpZWxkID0gcmVsYXRpb24ubGVmdEZpZWxkIHx8IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5KTtcblxuICAgICAgICBsZXQgZmllbGRJbmZvID0gdGhpcy5fcmVmaW5lTGVmdEZpZWxkKHJpZ2h0S2V5SW5mbyk7XG4gICAgICAgIGlmIChyZWxhdGlvbi5vcHRpb25hbCkge1xuICAgICAgICAgICAgZmllbGRJbmZvLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBsZWZ0RW50aXR5LmFkZEZpZWxkKGxlZnRGaWVsZCwgZmllbGRJbmZvKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb24ubGVmdCwgbGVmdEZpZWxkLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcbiAgICB9XG5cbiAgICBfYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIHVuaXF1ZSkge1xuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5sZWZ0XTtcbiAgICAgICAgbGV0IHJpZ2h0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLnJpZ2h0XTtcblxuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZCA9IHJlbGF0aW9uLmxlZnRGaWVsZCB8fCBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG5cbiAgICAgICAgbGV0IGZpZWxkSW5mbyA9IHRoaXMuX3JlZmluZUxlZnRGaWVsZChyaWdodEtleUluZm8pO1xuICAgICAgICBpZiAocmVsYXRpb24ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGZpZWxkSW5mby5vcHRpb25hbCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgbGVmdEVudGl0eS5hZGRGaWVsZChsZWZ0RmllbGQsIGZpZWxkSW5mbyk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uLmxlZnQsIGxlZnRGaWVsZCwgcmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uLm11bHRpICYmIF8ubGFzdChyZWxhdGlvbi5tdWx0aSkgPT09IHJlbGF0aW9uLnJpZ2h0KSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycsICgpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkczogXy5tYXAocmVsYXRpb24ubXVsdGksIHRvID0+IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcodG8sIHNjaGVtYS5lbnRpdGllc1t0b10pKSxcbiAgICAgICAgICAgICAgICAgICAgdW5pcXVlOiB1bmlxdWVcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgbGVmdEVudGl0eS5hZGRJbmRleChpbmRleCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9idWlsZE5Ub05SZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbi5sZWZ0ICsgVXRpbC5wYXNjYWxDYXNlKHBsdXJhbGl6ZS5wbHVyYWwocmVsYXRpb24ucmlnaHQpKTtcblxuICAgICAgICBpZiAoc2NoZW1hLmhhc0VudGl0eShyZWxhdGlvbkVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICBsZXQgZnVsbE5hbWUgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXS5pZDtcblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgWyR7cmVsYXRpb25FbnRpdHlOYW1lfV0gY29uZmxpY3RzIHdpdGggZW50aXR5IFske2Z1bGxOYW1lfV0gaW4gc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYENyZWF0ZSBhIHJlbGF0aW9uIGVudGl0eSBmb3IgXCIke3JlbGF0aW9uLmxlZnR9XCIgYW5kIFwiJHtyZWxhdGlvbi5yaWdodH1cIi5gKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuICAgICAgICBcbiAgICAgICAgbGV0IGxlZnRLZXlJbmZvID0gbGVmdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRLZXlJbmZvKSB8fCBBcnJheS5pc0FycmF5KHJpZ2h0S2V5SW5mbykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTXVsdGktZmllbGRzIGtleSBub3Qgc3VwcG9ydGVkIGZvciBub24tcmVsYXRpb25zaGlwIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsZWZ0RmllbGQxID0gTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5sZWZ0LCBsZWZ0RW50aXR5KTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZDIgPSBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG4gICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBmaWVsZHM6IHtcbiAgICAgICAgICAgICAgICBbbGVmdEZpZWxkMV06IGxlZnRLZXlJbmZvLFxuICAgICAgICAgICAgICAgIFtsZWZ0RmllbGQyXTogcmlnaHRLZXlJbmZvXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAga2V5OiBbIGxlZnRGaWVsZDEsIGxlZnRGaWVsZDIgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuICAgICAgICBlbnRpdHkubWFya0FzUmVsYXRpb25zaGlwRW50aXR5KCk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgbGVmdEZpZWxkMSwgcmVsYXRpb24ubGVmdCwgbGVmdEVudGl0eS5rZXkpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBsZWZ0RmllbGQyLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5KTtcbiAgICB9XG5cbiAgICBfcmVmaW5lTGVmdEZpZWxkKGZpZWxkSW5mbykge1xuICAgICAgICByZXR1cm4gT2JqZWN0LmFzc2lnbihfLnBpY2soZmllbGRJbmZvLCBPb2xvbmcuQlVJTFRJTl9UWVBFX0FUVFIpLCB7IGlzUmVmZXJlbmNlOiB0cnVlIH0pO1xuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTEubmFtZSwgZW50aXR5Mi5uYW1lIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkxLm5hbWUsIGVudGl0eTEsIF8ub21pdChrZXlFbnRpdHkxLCBbJ29wdGlvbmFsJ10pKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkyLm5hbWUsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxLm5hbWUsIGVudGl0eTEubmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5Mi5uYW1lLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnZGVjaW1hbCcpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsICYmICFpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcgfHwgaW5mby50eXBlID09PSAnaW50JyB8fCBpbmZvLnR5cGUgPT09ICdmbG9hdCcgfHwgaW5mby50eXBlID09PSAnZGVjaW1hbCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgIH1cblxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgIT09ICdvYmplY3QnKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgICAgICovXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=