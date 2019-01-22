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

    if (!info.optional && !info.hasOwnProperty('default') && !info.hasOwnProperty('auto')) {
      if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
        return '';
      }

      if (info.type === 'boolean' || info.type === 'integer' || info.type === 'number') {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwicHVzaCIsImFzc2lnbiIsInJlZnMiLCJzcmNFbnRpdHlOYW1lIiwicmVmIiwiX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQiLCJfd3JpdGVGaWxlIiwiSlNPTiIsInN0cmluZ2lmeSIsImV4aXN0c1N5bmMiLCJmdW5jU1FMIiwic3BGaWxlUGF0aCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eSIsImRlc3RLZXlGaWVsZCIsImdldEtleUZpZWxkIiwidHlwZSIsImJhY2tSZWYiLCJnZXRSZWZlcmVuY2VUbyIsImNvbm5lY3RlZEJ5IiwiY29ubkVudGl0eU5hbWUiLCJlbnRpdHlOYW1pbmciLCJ0YWcxIiwidGFnMiIsImhhcyIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJhZGQiLCJsb2NhbEZpZWxkIiwic3JjRmllbGQiLCJmaWVsZFByb3BzIiwib21pdCIsInBpY2siLCJhZGRBc3NvY0ZpZWxkIiwiX2FkZFJlZmVyZW5jZSIsImxlZnQiLCJsZWZ0RmllbGQiLCJyaWdodCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJfYnVpbGRSZWxhdGlvbiIsInJlbGF0aW9uIiwicmVsYXRpb25zaGlwIiwiX2J1aWxkTlRvTlJlbGF0aW9uIiwiX2J1aWxkT25lVG9BbnlSZWxhdGlvbiIsIl9idWlsZE1hbnlUb09uZVJlbGF0aW9uIiwiY29uc29sZSIsImxlZnRFbnRpdHkiLCJyaWdodEVudGl0eSIsInJpZ2h0S2V5SW5mbyIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImZpZWxkSW5mbyIsIl9yZWZpbmVMZWZ0RmllbGQiLCJvcHRpb25hbCIsImFkZEZpZWxkIiwidW5pcXVlIiwibXVsdGkiLCJsYXN0IiwiaW5kZXgiLCJtYXAiLCJ0byIsImFkZEluZGV4IiwicmVsYXRpb25FbnRpdHlOYW1lIiwicGFzY2FsQ2FzZSIsInBsdXJhbCIsImhhc0VudGl0eSIsImZ1bGxOYW1lIiwiaWQiLCJsZWZ0S2V5SW5mbyIsImxlZnRGaWVsZDEiLCJsZWZ0RmllbGQyIiwiZW50aXR5SW5mbyIsIm9vbE1vZHVsZSIsImxpbmsiLCJtYXJrQXNSZWxhdGlvbnNoaXBFbnRpdHkiLCJhZGRFbnRpdHkiLCJPb2xvbmciLCJCVUlMVElOX1RZUEVfQVRUUiIsImlzUmVmZXJlbmNlIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiZW50aXR5MSIsImVudGl0eTIiLCJyZWxhdGlvbkVudGl0eSIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0Iiwic3RhcnRJbmRleCIsImsiLCJzdWJEb2N1bWVudHMiLCJmaWVsZE5hbWUiLCJzdWJDb2xMaXN0Iiwic3ViQWxpYXMiLCJzdWJKb2lucyIsInN0YXJ0SW5kZXgyIiwiY29uY2F0IiwibGlua1dpdGhGaWVsZCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXhlcyIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsU0FBUyxHQUFHRCxPQUFPLENBQUMsV0FBRCxDQUF6Qjs7QUFDQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1JLElBQUksR0FBR0osT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBO0FBQUwsSUFBWUYsSUFBbEI7O0FBRUEsTUFBTUcsUUFBUSxHQUFHUCxPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVEsTUFBTSxHQUFHUixPQUFPLENBQUMsc0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTVMsS0FBSyxHQUFHVCxPQUFPLENBQUMsd0JBQUQsQ0FBckI7O0FBRUEsTUFBTVUseUJBQXlCLEdBQUcsSUFBSUMsR0FBSixDQUFRLENBQUMsTUFBRCxFQUFTLE1BQVQsRUFBaUIsTUFBakIsRUFBeUIsVUFBekIsQ0FBUixDQUFsQzs7QUF1Q0EsTUFBTUMsWUFBTixDQUFtQjtBQVVmQyxFQUFBQSxXQUFXLENBQUNDLE9BQUQsRUFBVUMsU0FBVixFQUFxQkMsU0FBckIsRUFBZ0M7QUFDdkMsU0FBS0MsTUFBTCxHQUFjSCxPQUFPLENBQUNHLE1BQXRCO0FBQ0EsU0FBS0MsTUFBTCxHQUFjSixPQUFPLENBQUNJLE1BQXRCO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQkwsT0FBTyxDQUFDTSxnQkFBMUI7QUFDQSxTQUFLTCxTQUFMLEdBQWlCQSxTQUFqQjtBQUVBLFNBQUtNLE9BQUwsR0FBZSxJQUFJdEIsWUFBSixFQUFmO0FBRUEsU0FBS3VCLFVBQUwsR0FBa0JOLFNBQVMsR0FBRztBQUMxQk8sTUFBQUEsRUFBRSxFQUFFbEIsQ0FBQyxDQUFDbUIsT0FBRixDQUFVUixTQUFTLENBQUNPLEVBQXBCLEVBQXdCLENBQUNFLEtBQUQsRUFBUUMsR0FBUixLQUFnQnJCLENBQUMsQ0FBQ3NCLFNBQUYsQ0FBWUQsR0FBWixDQUF4QyxDQURzQjtBQUUxQkUsTUFBQUEsS0FBSyxFQUFFdkIsQ0FBQyxDQUFDbUIsT0FBRixDQUFVUixTQUFTLENBQUNZLEtBQXBCLEVBQTJCLENBQUNILEtBQUQsRUFBUUMsR0FBUixLQUFnQnJCLENBQUMsQ0FBQ3NCLFNBQUYsQ0FBWUQsR0FBWixDQUEzQztBQUZtQixLQUFILEdBR3ZCLEVBSEo7QUFLQSxTQUFLRyxXQUFMLEdBQW1CLEVBQW5CO0FBQ0EsU0FBS0MsaUJBQUwsR0FBeUIsRUFBekI7QUFDQSxTQUFLQyxhQUFMLEdBQXFCLElBQUlwQixHQUFKLEVBQXJCO0FBQ0g7O0FBRURxQixFQUFBQSxRQUFRLENBQUNDLE1BQUQsRUFBUztBQUNiLFNBQUtoQixNQUFMLENBQVlpQixHQUFaLENBQWdCLE1BQWhCLEVBQXdCLDBDQUEwQ0QsTUFBTSxDQUFDRSxJQUFqRCxHQUF3RCxNQUFoRjtBQUVBLFFBQUlDLGNBQWMsR0FBR0gsTUFBTSxDQUFDSSxLQUFQLEVBQXJCO0FBRUEsU0FBS3BCLE1BQUwsQ0FBWWlCLEdBQVosQ0FBZ0IsT0FBaEIsRUFBeUIsdUJBQXpCO0FBRUEsUUFBSUksZ0JBQWdCLEdBQUdDLE1BQU0sQ0FBQ0MsTUFBUCxDQUFjSixjQUFjLENBQUNLLFFBQTdCLENBQXZCOztBQUVBcEMsSUFBQUEsQ0FBQyxDQUFDcUMsSUFBRixDQUFPSixnQkFBUCxFQUEwQkssTUFBRCxJQUFZO0FBQ2pDLFVBQUksQ0FBQ3RDLENBQUMsQ0FBQ3VDLE9BQUYsQ0FBVUQsTUFBTSxDQUFDRSxJQUFQLENBQVlDLFlBQXRCLENBQUwsRUFBMEM7QUFDdENILFFBQUFBLE1BQU0sQ0FBQ0UsSUFBUCxDQUFZQyxZQUFaLENBQXlCQyxPQUF6QixDQUFpQ0MsS0FBSyxJQUFJLEtBQUtDLG1CQUFMLENBQXlCYixjQUF6QixFQUF5Q08sTUFBekMsRUFBaURLLEtBQWpELENBQTFDO0FBQ0g7QUFDSixLQUpEOztBQU1BLFNBQUszQixPQUFMLENBQWE2QixJQUFiLENBQWtCLDJCQUFsQjs7QUFHQSxRQUFJQyxXQUFXLEdBQUdqRCxJQUFJLENBQUNrRCxJQUFMLENBQVUsT0FBVixFQUFtQixLQUFLckMsU0FBTCxDQUFlc0MsUUFBbEMsQ0FBbEI7QUFDQSxRQUFJQyxVQUFVLEdBQUdwRCxJQUFJLENBQUNrRCxJQUFMLENBQVVELFdBQVYsRUFBdUIsY0FBdkIsQ0FBakI7QUFDQSxRQUFJSSxVQUFVLEdBQUdyRCxJQUFJLENBQUNrRCxJQUFMLENBQVVELFdBQVYsRUFBdUIsZUFBdkIsQ0FBakI7QUFDQSxRQUFJSyxlQUFlLEdBQUd0RCxJQUFJLENBQUNrRCxJQUFMLENBQVVELFdBQVYsRUFBdUIsTUFBdkIsRUFBK0IsT0FBL0IsRUFBd0MsWUFBeEMsQ0FBdEI7QUFDQSxRQUFJTSxZQUFZLEdBQUd2RCxJQUFJLENBQUNrRCxJQUFMLENBQVVELFdBQVYsRUFBdUIsTUFBdkIsRUFBK0IsT0FBL0IsRUFBd0MsYUFBeEMsQ0FBbkI7QUFDQSxRQUFJTyxRQUFRLEdBQUcsRUFBZjtBQUFBLFFBQW1CQyxXQUFXLEdBQUcsRUFBakM7QUFBQSxRQUFxQ0MsSUFBSSxHQUFHLEVBQTVDOztBQUVBdkQsSUFBQUEsQ0FBQyxDQUFDcUMsSUFBRixDQUFPTixjQUFjLENBQUNLLFFBQXRCLEVBQWdDLENBQUNFLE1BQUQsRUFBU2tCLFVBQVQsS0FBd0I7QUFDcERsQixNQUFBQSxNQUFNLENBQUNtQixVQUFQO0FBRUEsVUFBSUMsTUFBTSxHQUFHbkQsWUFBWSxDQUFDb0QsZUFBYixDQUE2QnJCLE1BQTdCLENBQWI7O0FBQ0EsVUFBSW9CLE1BQU0sQ0FBQ0UsTUFBUCxDQUFjQyxNQUFsQixFQUEwQjtBQUN0QixZQUFJQyxPQUFPLEdBQUcsRUFBZDs7QUFDQSxZQUFJSixNQUFNLENBQUNLLFFBQVAsQ0FBZ0JGLE1BQWhCLEdBQXlCLENBQTdCLEVBQWdDO0FBQzVCQyxVQUFBQSxPQUFPLElBQUksaUJBQWlCSixNQUFNLENBQUNLLFFBQVAsQ0FBZ0JoQixJQUFoQixDQUFxQixJQUFyQixDQUFqQixHQUE4QyxJQUF6RDtBQUNIOztBQUNEZSxRQUFBQSxPQUFPLElBQUlKLE1BQU0sQ0FBQ0UsTUFBUCxDQUFjYixJQUFkLENBQW1CLElBQW5CLENBQVg7QUFFQSxjQUFNLElBQUlpQixLQUFKLENBQVVGLE9BQVYsQ0FBTjtBQUNIOztBQUVELFVBQUl4QixNQUFNLENBQUMyQixRQUFYLEVBQXFCO0FBQ2pCakUsUUFBQUEsQ0FBQyxDQUFDa0UsTUFBRixDQUFTNUIsTUFBTSxDQUFDMkIsUUFBaEIsRUFBMEIsQ0FBQ0UsQ0FBRCxFQUFJQyxXQUFKLEtBQW9CO0FBQzFDLGNBQUlDLEtBQUssQ0FBQ0MsT0FBTixDQUFjSCxDQUFkLENBQUosRUFBc0I7QUFDbEJBLFlBQUFBLENBQUMsQ0FBQ3pCLE9BQUYsQ0FBVTZCLEVBQUUsSUFBSSxLQUFLQyxlQUFMLENBQXFCbEMsTUFBckIsRUFBNkI4QixXQUE3QixFQUEwQ0csRUFBMUMsQ0FBaEI7QUFDSCxXQUZELE1BRU87QUFDSCxpQkFBS0MsZUFBTCxDQUFxQmxDLE1BQXJCLEVBQTZCOEIsV0FBN0IsRUFBMENELENBQTFDO0FBQ0g7QUFDSixTQU5EO0FBT0g7O0FBRURkLE1BQUFBLFFBQVEsSUFBSSxLQUFLb0IscUJBQUwsQ0FBMkJqQixVQUEzQixFQUF1Q2xCLE1BQXZDLElBQWlELElBQTdEOztBQUVBLFVBQUlBLE1BQU0sQ0FBQ0UsSUFBUCxDQUFZZSxJQUFoQixFQUFzQjtBQUVsQixZQUFJbUIsVUFBVSxHQUFHLEVBQWpCOztBQUVBLFlBQUlMLEtBQUssQ0FBQ0MsT0FBTixDQUFjaEMsTUFBTSxDQUFDRSxJQUFQLENBQVllLElBQTFCLENBQUosRUFBcUM7QUFDakNqQixVQUFBQSxNQUFNLENBQUNFLElBQVAsQ0FBWWUsSUFBWixDQUFpQmIsT0FBakIsQ0FBeUJpQyxNQUFNLElBQUk7QUFDL0IsZ0JBQUksQ0FBQzNFLENBQUMsQ0FBQzRFLGFBQUYsQ0FBZ0JELE1BQWhCLENBQUwsRUFBOEI7QUFDMUIsa0JBQUlFLE1BQU0sR0FBRzNDLE1BQU0sQ0FBQzRDLElBQVAsQ0FBWXhDLE1BQU0sQ0FBQ3VDLE1BQW5CLENBQWI7O0FBQ0Esa0JBQUlBLE1BQU0sQ0FBQ2hCLE1BQVAsS0FBa0IsQ0FBdEIsRUFBeUI7QUFDckIsc0JBQU0sSUFBSUcsS0FBSixDQUFXLGdDQUErQjFCLE1BQU0sQ0FBQ1IsSUFBSywyQkFBdEQsQ0FBTjtBQUNIOztBQUVENkMsY0FBQUEsTUFBTSxHQUFHO0FBQUMsaUJBQUNFLE1BQU0sQ0FBQyxDQUFELENBQVAsR0FBYUY7QUFBZCxlQUFUO0FBQ0g7O0FBRURELFlBQUFBLFVBQVUsQ0FBQ0ssSUFBWCxDQUFnQkosTUFBaEI7QUFDSCxXQVhEO0FBWUgsU0FiRCxNQWFPO0FBQ0gzRSxVQUFBQSxDQUFDLENBQUNrRSxNQUFGLENBQVM1QixNQUFNLENBQUNFLElBQVAsQ0FBWWUsSUFBckIsRUFBMkIsQ0FBQ29CLE1BQUQsRUFBU3RELEdBQVQsS0FBaUI7QUFDeEMsZ0JBQUksQ0FBQ3JCLENBQUMsQ0FBQzRFLGFBQUYsQ0FBZ0JELE1BQWhCLENBQUwsRUFBOEI7QUFDMUIsa0JBQUlFLE1BQU0sR0FBRzNDLE1BQU0sQ0FBQzRDLElBQVAsQ0FBWXhDLE1BQU0sQ0FBQ3VDLE1BQW5CLENBQWI7O0FBQ0Esa0JBQUlBLE1BQU0sQ0FBQ2hCLE1BQVAsS0FBa0IsQ0FBdEIsRUFBeUI7QUFDckIsc0JBQU0sSUFBSUcsS0FBSixDQUFXLGdDQUErQjFCLE1BQU0sQ0FBQ1IsSUFBSywyQkFBdEQsQ0FBTjtBQUNIOztBQUVENkMsY0FBQUEsTUFBTSxHQUFHO0FBQUMsaUJBQUNyQyxNQUFNLENBQUNqQixHQUFSLEdBQWNBLEdBQWY7QUFBb0IsaUJBQUN3RCxNQUFNLENBQUMsQ0FBRCxDQUFQLEdBQWFGO0FBQWpDLGVBQVQ7QUFDSCxhQVBELE1BT087QUFDSEEsY0FBQUEsTUFBTSxHQUFHekMsTUFBTSxDQUFDOEMsTUFBUCxDQUFjO0FBQUMsaUJBQUMxQyxNQUFNLENBQUNqQixHQUFSLEdBQWNBO0FBQWYsZUFBZCxFQUFtQ3NELE1BQW5DLENBQVQ7QUFDSDs7QUFFREQsWUFBQUEsVUFBVSxDQUFDSyxJQUFYLENBQWdCSixNQUFoQjtBQUVILFdBZEQ7QUFlSDs7QUFFRCxZQUFJLENBQUMzRSxDQUFDLENBQUN1QyxPQUFGLENBQVVtQyxVQUFWLENBQUwsRUFBNEI7QUFDeEJuQixVQUFBQSxJQUFJLENBQUNDLFVBQUQsQ0FBSixHQUFtQmtCLFVBQW5CO0FBQ0g7QUFHSjtBQUNKLEtBbkVEOztBQXFFQTFFLElBQUFBLENBQUMsQ0FBQ2tFLE1BQUYsQ0FBUyxLQUFLMUMsV0FBZCxFQUEyQixDQUFDeUQsSUFBRCxFQUFPQyxhQUFQLEtBQXlCO0FBQ2hEbEYsTUFBQUEsQ0FBQyxDQUFDcUMsSUFBRixDQUFPNEMsSUFBUCxFQUFhRSxHQUFHLElBQUk7QUFDaEI3QixRQUFBQSxXQUFXLElBQUksS0FBSzhCLHVCQUFMLENBQTZCRixhQUE3QixFQUE0Q0MsR0FBNUMsSUFBbUQsSUFBbEU7QUFDSCxPQUZEO0FBR0gsS0FKRDs7QUFNQSxTQUFLRSxVQUFMLENBQWdCeEYsSUFBSSxDQUFDa0QsSUFBTCxDQUFVLEtBQUtqQyxVQUFmLEVBQTJCbUMsVUFBM0IsQ0FBaEIsRUFBd0RJLFFBQXhEOztBQUNBLFNBQUtnQyxVQUFMLENBQWdCeEYsSUFBSSxDQUFDa0QsSUFBTCxDQUFVLEtBQUtqQyxVQUFmLEVBQTJCb0MsVUFBM0IsQ0FBaEIsRUFBd0RJLFdBQXhEOztBQUVBLFFBQUksQ0FBQ3RELENBQUMsQ0FBQ3VDLE9BQUYsQ0FBVWdCLElBQVYsQ0FBTCxFQUFzQjtBQUNsQixXQUFLOEIsVUFBTCxDQUFnQnhGLElBQUksQ0FBQ2tELElBQUwsQ0FBVSxLQUFLakMsVUFBZixFQUEyQnNDLFlBQTNCLENBQWhCLEVBQTBEa0MsSUFBSSxDQUFDQyxTQUFMLENBQWVoQyxJQUFmLEVBQXFCLElBQXJCLEVBQTJCLENBQTNCLENBQTFEOztBQUVBLFVBQUksQ0FBQ3RELEVBQUUsQ0FBQ3VGLFVBQUgsQ0FBYzNGLElBQUksQ0FBQ2tELElBQUwsQ0FBVSxLQUFLakMsVUFBZixFQUEyQnFDLGVBQTNCLENBQWQsQ0FBTCxFQUFpRTtBQUM3RCxhQUFLa0MsVUFBTCxDQUFnQnhGLElBQUksQ0FBQ2tELElBQUwsQ0FBVSxLQUFLakMsVUFBZixFQUEyQnFDLGVBQTNCLENBQWhCLEVBQTZELGVBQTdEO0FBQ0g7QUFDSjs7QUFFRCxRQUFJc0MsT0FBTyxHQUFHLEVBQWQ7QUEwQkEsUUFBSUMsVUFBVSxHQUFHN0YsSUFBSSxDQUFDa0QsSUFBTCxDQUFVRCxXQUFWLEVBQXVCLGdCQUF2QixDQUFqQjs7QUFDQSxTQUFLdUMsVUFBTCxDQUFnQnhGLElBQUksQ0FBQ2tELElBQUwsQ0FBVSxLQUFLakMsVUFBZixFQUEyQjRFLFVBQTNCLENBQWhCLEVBQXdERCxPQUF4RDs7QUFFQSxXQUFPMUQsY0FBUDtBQUNIOztBQUVEYSxFQUFBQSxtQkFBbUIsQ0FBQ2hCLE1BQUQsRUFBU1UsTUFBVCxFQUFpQkssS0FBakIsRUFBd0I7QUFDdkMsUUFBSWdELGNBQWMsR0FBR2hELEtBQUssQ0FBQ2lELFVBQTNCO0FBRUEsUUFBSUEsVUFBVSxHQUFHaEUsTUFBTSxDQUFDUSxRQUFQLENBQWdCdUQsY0FBaEIsQ0FBakI7O0FBQ0EsUUFBSSxDQUFDQyxVQUFMLEVBQWlCO0FBQ2IsWUFBTSxJQUFJNUIsS0FBSixDQUFXLFdBQVUxQixNQUFNLENBQUNSLElBQUsseUNBQXdDNkQsY0FBZSxJQUF4RixDQUFOO0FBQ0g7O0FBRUQsUUFBSUUsWUFBWSxHQUFHRCxVQUFVLENBQUNFLFdBQVgsRUFBbkI7O0FBQ0EsUUFBSXpCLEtBQUssQ0FBQ0MsT0FBTixDQUFjdUIsWUFBZCxDQUFKLEVBQWlDO0FBQzdCLFlBQU0sSUFBSTdCLEtBQUosQ0FBVyx1QkFBc0IyQixjQUFlLGtEQUFoRCxDQUFOO0FBQ0g7O0FBRUQsWUFBUWhELEtBQUssQ0FBQ29ELElBQWQ7QUFDSSxXQUFLLFFBQUw7QUFDSSxjQUFNLElBQUkvQixLQUFKLENBQVUsTUFBVixDQUFOO0FBQ0o7O0FBRUEsV0FBSyxTQUFMO0FBQ0ksWUFBSWdDLE9BQU8sR0FBR0osVUFBVSxDQUFDSyxjQUFYLENBQTBCM0QsTUFBTSxDQUFDUixJQUFqQyxFQUF1Q2EsS0FBSyxDQUFDdUQsV0FBN0MsQ0FBZDs7QUFDQSxZQUFJRixPQUFKLEVBQWE7QUFDVCxjQUFJQSxPQUFPLENBQUNELElBQVIsS0FBaUIsU0FBckIsRUFBZ0M7QUFDNUIsZ0JBQUlJLGNBQWMsR0FBR2pHLFFBQVEsQ0FBQ2tHLFlBQVQsQ0FBc0J6RCxLQUFLLENBQUN1RCxXQUE1QixDQUFyQjs7QUFFQSxnQkFBSSxDQUFDQyxjQUFMLEVBQXFCO0FBQ2pCLG9CQUFNLElBQUluQyxLQUFKLENBQVcsb0RBQW1EMUIsTUFBTSxDQUFDUixJQUFLLGtCQUFpQjZELGNBQWUsRUFBMUcsQ0FBTjtBQUNIOztBQUVELGdCQUFJVSxJQUFJLEdBQUksR0FBRS9ELE1BQU0sQ0FBQ1IsSUFBSyxNQUFLNkQsY0FBZSxTQUFRUSxjQUFlLEVBQXJFO0FBQ0EsZ0JBQUlHLElBQUksR0FBSSxHQUFFWCxjQUFlLE1BQUtyRCxNQUFNLENBQUNSLElBQUssU0FBUXFFLGNBQWUsRUFBckU7O0FBRUEsZ0JBQUksS0FBS3pFLGFBQUwsQ0FBbUI2RSxHQUFuQixDQUF1QkYsSUFBdkIsS0FBZ0MsS0FBSzNFLGFBQUwsQ0FBbUI2RSxHQUFuQixDQUF1QkQsSUFBdkIsQ0FBcEMsRUFBa0U7QUFFOUQ7QUFDSDs7QUFFRCxnQkFBSUUsVUFBVSxHQUFHNUUsTUFBTSxDQUFDUSxRQUFQLENBQWdCK0QsY0FBaEIsQ0FBakI7O0FBQ0EsZ0JBQUksQ0FBQ0ssVUFBTCxFQUFpQjtBQUNiQSxjQUFBQSxVQUFVLEdBQUcsS0FBS0Msa0JBQUwsQ0FBd0I3RSxNQUF4QixFQUFnQ3VFLGNBQWhDLEVBQWdEN0QsTUFBaEQsRUFBd0RzRCxVQUF4RCxDQUFiO0FBQ0g7O0FBRUQsaUJBQUtjLHFCQUFMLENBQTJCRixVQUEzQixFQUF1Q2xFLE1BQXZDLEVBQStDc0QsVUFBL0M7O0FBRUEsaUJBQUtsRSxhQUFMLENBQW1CaUYsR0FBbkIsQ0FBdUJOLElBQXZCOztBQUNBLGlCQUFLM0UsYUFBTCxDQUFtQmlGLEdBQW5CLENBQXVCTCxJQUF2QjtBQUNILFdBeEJELE1Bd0JPLElBQUlOLE9BQU8sQ0FBQ0QsSUFBUixLQUFpQixXQUFyQixFQUFrQztBQUNyQyxnQkFBSXBELEtBQUssQ0FBQ3VELFdBQVYsRUFBdUI7QUFDbkIsb0JBQU0sSUFBSWxDLEtBQUosQ0FBVSw2QkFBVixDQUFOO0FBQ0gsYUFGRCxNQUVPLENBRU47QUFDSixXQU5NLE1BTUE7QUFBQSxrQkFDS2dDLE9BQU8sQ0FBQ0QsSUFBUixLQUFpQixRQUR0QjtBQUFBO0FBQUE7O0FBR0gsa0JBQU0sSUFBSS9CLEtBQUosQ0FBVSxtQkFBVixDQUFOO0FBQ0g7QUFDSjs7QUFFTDs7QUFFQSxXQUFLLFVBQUw7QUFDQSxXQUFLLFdBQUw7QUFDSSxZQUFJNEMsVUFBVSxHQUFHakUsS0FBSyxDQUFDa0UsUUFBTixJQUFrQmxCLGNBQW5DO0FBQ0EsWUFBSW1CLFVBQVUsR0FBRyxFQUFFLEdBQUc5RyxDQUFDLENBQUMrRyxJQUFGLENBQU9sQixZQUFQLEVBQXFCLENBQUMsVUFBRCxDQUFyQixDQUFMO0FBQXlDLGFBQUc3RixDQUFDLENBQUNnSCxJQUFGLENBQU9yRSxLQUFQLEVBQWMsQ0FBQyxVQUFELENBQWQ7QUFBNUMsU0FBakI7QUFFQUwsUUFBQUEsTUFBTSxDQUFDMkUsYUFBUCxDQUFxQkwsVUFBckIsRUFBaUNoQixVQUFqQyxFQUE2Q2tCLFVBQTdDOztBQUVBLGFBQUtJLGFBQUwsQ0FBbUI1RSxNQUFNLENBQUNSLElBQTFCLEVBQWdDOEUsVUFBaEMsRUFBNENqQixjQUE1QyxFQUE0REUsWUFBWSxDQUFDL0QsSUFBekU7O0FBQ0o7QUF2REo7QUF5REg7O0FBRURvRixFQUFBQSxhQUFhLENBQUNDLElBQUQsRUFBT0MsU0FBUCxFQUFrQkMsS0FBbEIsRUFBeUJDLFVBQXpCLEVBQXFDO0FBQzlDLFFBQUlDLGVBQWUsR0FBRyxLQUFLL0YsV0FBTCxDQUFpQjJGLElBQWpCLENBQXRCOztBQUNBLFFBQUksQ0FBQ0ksZUFBTCxFQUFzQjtBQUNsQkEsTUFBQUEsZUFBZSxHQUFHLEVBQWxCO0FBQ0EsV0FBSy9GLFdBQUwsQ0FBaUIyRixJQUFqQixJQUF5QkksZUFBekI7QUFDSCxLQUhELE1BR087QUFDSCxVQUFJQyxLQUFLLEdBQUd4SCxDQUFDLENBQUN5SCxJQUFGLENBQU9GLGVBQVAsRUFDUkcsSUFBSSxJQUFLQSxJQUFJLENBQUNOLFNBQUwsS0FBbUJBLFNBQW5CLElBQWdDTSxJQUFJLENBQUNMLEtBQUwsS0FBZUEsS0FBL0MsSUFBd0RLLElBQUksQ0FBQ0osVUFBTCxLQUFvQkEsVUFEN0UsQ0FBWjs7QUFJQSxVQUFJRSxLQUFKLEVBQVc7QUFDUCxlQUFPLElBQVA7QUFDSDtBQUNKOztBQUVERCxJQUFBQSxlQUFlLENBQUN4QyxJQUFoQixDQUFxQjtBQUFDcUMsTUFBQUEsU0FBRDtBQUFZQyxNQUFBQSxLQUFaO0FBQW1CQyxNQUFBQTtBQUFuQixLQUFyQjtBQUVBLFdBQU8sSUFBUDtBQUNIOztBQUVESyxFQUFBQSxvQkFBb0IsQ0FBQ1IsSUFBRCxFQUFPQyxTQUFQLEVBQWtCO0FBQ2xDLFFBQUlHLGVBQWUsR0FBRyxLQUFLL0YsV0FBTCxDQUFpQjJGLElBQWpCLENBQXRCOztBQUNBLFFBQUksQ0FBQ0ksZUFBTCxFQUFzQjtBQUNsQixhQUFPSyxTQUFQO0FBQ0g7O0FBRUQsUUFBSUMsU0FBUyxHQUFHN0gsQ0FBQyxDQUFDeUgsSUFBRixDQUFPRixlQUFQLEVBQ1pHLElBQUksSUFBS0EsSUFBSSxDQUFDTixTQUFMLEtBQW1CQSxTQURoQixDQUFoQjs7QUFJQSxRQUFJLENBQUNTLFNBQUwsRUFBZ0I7QUFDWixhQUFPRCxTQUFQO0FBQ0g7O0FBRUQsV0FBT0MsU0FBUDtBQUNIOztBQUVEQyxFQUFBQSxvQkFBb0IsQ0FBQ1gsSUFBRCxFQUFPQyxTQUFQLEVBQWtCO0FBQ2xDLFFBQUlHLGVBQWUsR0FBRyxLQUFLL0YsV0FBTCxDQUFpQjJGLElBQWpCLENBQXRCO0FBQ0EsUUFBSSxDQUFDSSxlQUFMLEVBQXNCLE9BQU8sS0FBUDtBQUV0QixXQUFRSyxTQUFTLEtBQUs1SCxDQUFDLENBQUN5SCxJQUFGLENBQU9GLGVBQVAsRUFDbEJHLElBQUksSUFBS0EsSUFBSSxDQUFDTixTQUFMLEtBQW1CQSxTQURWLENBQXRCO0FBR0g7O0FBRURXLEVBQUFBLG9CQUFvQixDQUFDWixJQUFELEVBQU9FLEtBQVAsRUFBYztBQUM5QixRQUFJRSxlQUFlLEdBQUcsS0FBSy9GLFdBQUwsQ0FBaUIyRixJQUFqQixDQUF0Qjs7QUFDQSxRQUFJLENBQUNJLGVBQUwsRUFBc0I7QUFDbEIsYUFBT0ssU0FBUDtBQUNIOztBQUVELFFBQUlDLFNBQVMsR0FBRzdILENBQUMsQ0FBQ3lILElBQUYsQ0FBT0YsZUFBUCxFQUNaRyxJQUFJLElBQUtBLElBQUksQ0FBQ0wsS0FBTCxLQUFlQSxLQURaLENBQWhCOztBQUlBLFFBQUksQ0FBQ1EsU0FBTCxFQUFnQjtBQUNaLGFBQU9ELFNBQVA7QUFDSDs7QUFFRCxXQUFPQyxTQUFQO0FBQ0g7O0FBRURHLEVBQUFBLG9CQUFvQixDQUFDYixJQUFELEVBQU9FLEtBQVAsRUFBYztBQUM5QixRQUFJRSxlQUFlLEdBQUcsS0FBSy9GLFdBQUwsQ0FBaUIyRixJQUFqQixDQUF0QjtBQUNBLFFBQUksQ0FBQ0ksZUFBTCxFQUFzQixPQUFPLEtBQVA7QUFFdEIsV0FBUUssU0FBUyxLQUFLNUgsQ0FBQyxDQUFDeUgsSUFBRixDQUFPRixlQUFQLEVBQ2xCRyxJQUFJLElBQUtBLElBQUksQ0FBQ0wsS0FBTCxLQUFlQSxLQUROLENBQXRCO0FBR0g7O0FBRUQ3QyxFQUFBQSxlQUFlLENBQUNsQyxNQUFELEVBQVM4QixXQUFULEVBQXNCNkQsT0FBdEIsRUFBK0I7QUFDMUMsUUFBSUMsS0FBSjs7QUFFQSxZQUFROUQsV0FBUjtBQUNJLFdBQUssUUFBTDtBQUNJOEQsUUFBQUEsS0FBSyxHQUFHNUYsTUFBTSxDQUFDdUMsTUFBUCxDQUFjb0QsT0FBTyxDQUFDQyxLQUF0QixDQUFSOztBQUVBLFlBQUlBLEtBQUssQ0FBQ25DLElBQU4sS0FBZSxTQUFmLElBQTRCLENBQUNtQyxLQUFLLENBQUNDLFNBQXZDLEVBQWtEO0FBQzlDRCxVQUFBQSxLQUFLLENBQUNFLGVBQU4sR0FBd0IsSUFBeEI7O0FBQ0EsY0FBSSxlQUFlRixLQUFuQixFQUEwQjtBQUN0QixpQkFBS2xILE9BQUwsQ0FBYXFILEVBQWIsQ0FBZ0IscUJBQXFCL0YsTUFBTSxDQUFDUixJQUE1QyxFQUFrRHdHLFNBQVMsSUFBSTtBQUMzREEsY0FBQUEsU0FBUyxDQUFDLGdCQUFELENBQVQsR0FBOEJKLEtBQUssQ0FBQ0ssU0FBcEM7QUFDSCxhQUZEO0FBR0g7QUFDSjs7QUFDRDs7QUFFSixXQUFLLGlCQUFMO0FBQ0lMLFFBQUFBLEtBQUssR0FBRzVGLE1BQU0sQ0FBQ3VDLE1BQVAsQ0FBY29ELE9BQU8sQ0FBQ0MsS0FBdEIsQ0FBUjtBQUNBQSxRQUFBQSxLQUFLLENBQUNNLGlCQUFOLEdBQTBCLElBQTFCO0FBQ0E7O0FBRUosV0FBSyxpQkFBTDtBQUNJTixRQUFBQSxLQUFLLEdBQUc1RixNQUFNLENBQUN1QyxNQUFQLENBQWNvRCxPQUFPLENBQUNDLEtBQXRCLENBQVI7QUFDQUEsUUFBQUEsS0FBSyxDQUFDTyxpQkFBTixHQUEwQixJQUExQjtBQUNBOztBQUVKLFdBQUssaUJBQUw7QUFDSTs7QUFFSixXQUFLLG1CQUFMO0FBQ0k7O0FBRUosV0FBSyw2QkFBTDtBQUNJOztBQUVKLFdBQUssZUFBTDtBQUNJOztBQUVKLFdBQUssTUFBTDtBQUNJOztBQUVKO0FBQ0ksY0FBTSxJQUFJekUsS0FBSixDQUFVLDBCQUEwQkksV0FBMUIsR0FBd0MsSUFBbEQsQ0FBTjtBQXhDUjtBQTBDSDs7QUFFRHNFLEVBQUFBLGNBQWMsQ0FBQzlHLE1BQUQsRUFBUytHLFFBQVQsRUFBbUI7QUFDN0IsU0FBSy9ILE1BQUwsQ0FBWWlCLEdBQVosQ0FBZ0IsT0FBaEIsRUFBeUIsaUNBQ3ZCOEcsUUFBUSxDQUFDeEIsSUFEYyxHQUNQLFNBRE8sR0FFdkJ3QixRQUFRLENBQUN0QixLQUZjLEdBRU4sa0JBRk0sR0FHdkJzQixRQUFRLENBQUNDLFlBSGMsR0FHQyxNQUgxQjs7QUFLQSxRQUFJRCxRQUFRLENBQUNDLFlBQVQsS0FBMEIsS0FBOUIsRUFBcUM7QUFDakMsV0FBS0Msa0JBQUwsQ0FBd0JqSCxNQUF4QixFQUFnQytHLFFBQWhDO0FBQ0gsS0FGRCxNQUVPLElBQUlBLFFBQVEsQ0FBQ0MsWUFBVCxLQUEwQixLQUE5QixFQUFxQztBQUN4QyxXQUFLRSxzQkFBTCxDQUE0QmxILE1BQTVCLEVBQW9DK0csUUFBcEMsRUFBOEMsS0FBOUM7QUFDSCxLQUZNLE1BRUEsSUFBSUEsUUFBUSxDQUFDQyxZQUFULEtBQTBCLEtBQTlCLEVBQXFDO0FBQ3hDLFdBQUtFLHNCQUFMLENBQTRCbEgsTUFBNUIsRUFBb0MrRyxRQUFwQyxFQUE4QyxJQUE5QztBQUNILEtBRk0sTUFFQSxJQUFJQSxRQUFRLENBQUNDLFlBQVQsS0FBMEIsS0FBOUIsRUFBcUM7QUFDeEMsV0FBS0csdUJBQUwsQ0FBNkJuSCxNQUE3QixFQUFxQytHLFFBQXJDO0FBQ0gsS0FGTSxNQUVBO0FBQ0hLLE1BQUFBLE9BQU8sQ0FBQ25ILEdBQVIsQ0FBWThHLFFBQVo7QUFDQSxZQUFNLElBQUkzRSxLQUFKLENBQVUsS0FBVixDQUFOO0FBQ0g7QUFDSjs7QUFFRCtFLEVBQUFBLHVCQUF1QixDQUFDbkgsTUFBRCxFQUFTK0csUUFBVCxFQUFtQjtBQUN0QyxRQUFJTSxVQUFVLEdBQUdySCxNQUFNLENBQUNRLFFBQVAsQ0FBZ0J1RyxRQUFRLENBQUN4QixJQUF6QixDQUFqQjtBQUNBLFFBQUkrQixXQUFXLEdBQUd0SCxNQUFNLENBQUNRLFFBQVAsQ0FBZ0J1RyxRQUFRLENBQUN0QixLQUF6QixDQUFsQjtBQUVBLFFBQUk4QixZQUFZLEdBQUdELFdBQVcsQ0FBQ3BELFdBQVosRUFBbkI7QUFDQSxRQUFJc0IsU0FBUyxHQUFHdUIsUUFBUSxDQUFDdkIsU0FBVCxJQUFzQjdHLFlBQVksQ0FBQzZJLHFCQUFiLENBQW1DVCxRQUFRLENBQUN0QixLQUE1QyxFQUFtRDZCLFdBQW5ELENBQXRDOztBQUVBLFFBQUlHLFNBQVMsR0FBRyxLQUFLQyxnQkFBTCxDQUFzQkgsWUFBdEIsQ0FBaEI7O0FBQ0EsUUFBSVIsUUFBUSxDQUFDWSxRQUFiLEVBQXVCO0FBQ25CRixNQUFBQSxTQUFTLENBQUNFLFFBQVYsR0FBcUIsSUFBckI7QUFDSDs7QUFDRE4sSUFBQUEsVUFBVSxDQUFDTyxRQUFYLENBQW9CcEMsU0FBcEIsRUFBK0JpQyxTQUEvQjs7QUFFQSxTQUFLbkMsYUFBTCxDQUFtQnlCLFFBQVEsQ0FBQ3hCLElBQTVCLEVBQWtDQyxTQUFsQyxFQUE2Q3VCLFFBQVEsQ0FBQ3RCLEtBQXRELEVBQTZENkIsV0FBVyxDQUFDN0gsR0FBekU7QUFDSDs7QUFFRHlILEVBQUFBLHNCQUFzQixDQUFDbEgsTUFBRCxFQUFTK0csUUFBVCxFQUFtQmMsTUFBbkIsRUFBMkI7QUFDN0MsUUFBSVIsVUFBVSxHQUFHckgsTUFBTSxDQUFDUSxRQUFQLENBQWdCdUcsUUFBUSxDQUFDeEIsSUFBekIsQ0FBakI7QUFDQSxRQUFJK0IsV0FBVyxHQUFHdEgsTUFBTSxDQUFDUSxRQUFQLENBQWdCdUcsUUFBUSxDQUFDdEIsS0FBekIsQ0FBbEI7QUFFQSxRQUFJOEIsWUFBWSxHQUFHRCxXQUFXLENBQUNwRCxXQUFaLEVBQW5CO0FBQ0EsUUFBSXNCLFNBQVMsR0FBR3VCLFFBQVEsQ0FBQ3ZCLFNBQVQsSUFBc0I3RyxZQUFZLENBQUM2SSxxQkFBYixDQUFtQ1QsUUFBUSxDQUFDdEIsS0FBNUMsRUFBbUQ2QixXQUFuRCxDQUF0Qzs7QUFFQSxRQUFJRyxTQUFTLEdBQUcsS0FBS0MsZ0JBQUwsQ0FBc0JILFlBQXRCLENBQWhCOztBQUNBLFFBQUlSLFFBQVEsQ0FBQ1ksUUFBYixFQUF1QjtBQUNuQkYsTUFBQUEsU0FBUyxDQUFDRSxRQUFWLEdBQXFCLElBQXJCO0FBQ0g7O0FBQ0ROLElBQUFBLFVBQVUsQ0FBQ08sUUFBWCxDQUFvQnBDLFNBQXBCLEVBQStCaUMsU0FBL0I7O0FBRUEsU0FBS25DLGFBQUwsQ0FBbUJ5QixRQUFRLENBQUN4QixJQUE1QixFQUFrQ0MsU0FBbEMsRUFBNkN1QixRQUFRLENBQUN0QixLQUF0RCxFQUE2RDZCLFdBQVcsQ0FBQzdILEdBQXpFOztBQUVBLFFBQUlzSCxRQUFRLENBQUNlLEtBQVQsSUFBa0IxSixDQUFDLENBQUMySixJQUFGLENBQU9oQixRQUFRLENBQUNlLEtBQWhCLE1BQTJCZixRQUFRLENBQUN0QixLQUExRCxFQUFpRTtBQUU3RCxXQUFLckcsT0FBTCxDQUFhcUgsRUFBYixDQUFnQiwyQkFBaEIsRUFBNkMsTUFBTTtBQUMvQyxZQUFJdUIsS0FBSyxHQUFHO0FBQ1IvRSxVQUFBQSxNQUFNLEVBQUU3RSxDQUFDLENBQUM2SixHQUFGLENBQU1sQixRQUFRLENBQUNlLEtBQWYsRUFBc0JJLEVBQUUsSUFBSXZKLFlBQVksQ0FBQzZJLHFCQUFiLENBQW1DVSxFQUFuQyxFQUF1Q2xJLE1BQU0sQ0FBQ1EsUUFBUCxDQUFnQjBILEVBQWhCLENBQXZDLENBQTVCLENBREE7QUFFUkwsVUFBQUEsTUFBTSxFQUFFQTtBQUZBLFNBQVo7QUFLQVIsUUFBQUEsVUFBVSxDQUFDYyxRQUFYLENBQW9CSCxLQUFwQjtBQUNILE9BUEQ7QUFRSDtBQUNKOztBQUVEZixFQUFBQSxrQkFBa0IsQ0FBQ2pILE1BQUQsRUFBUytHLFFBQVQsRUFBbUI7QUFDakMsUUFBSXFCLGtCQUFrQixHQUFHckIsUUFBUSxDQUFDeEIsSUFBVCxHQUFnQnBILElBQUksQ0FBQ2tLLFVBQUwsQ0FBZ0JySyxTQUFTLENBQUNzSyxNQUFWLENBQWlCdkIsUUFBUSxDQUFDdEIsS0FBMUIsQ0FBaEIsQ0FBekM7O0FBRUEsUUFBSXpGLE1BQU0sQ0FBQ3VJLFNBQVAsQ0FBaUJILGtCQUFqQixDQUFKLEVBQTBDO0FBQ3RDLFVBQUlJLFFBQVEsR0FBR3hJLE1BQU0sQ0FBQ1EsUUFBUCxDQUFnQjRILGtCQUFoQixFQUFvQ0ssRUFBbkQ7QUFFQSxZQUFNLElBQUlyRyxLQUFKLENBQVcsV0FBVWdHLGtCQUFtQiw0QkFBMkJJLFFBQVMsZ0JBQWV4SSxNQUFNLENBQUNFLElBQUssSUFBdkcsQ0FBTjtBQUNIOztBQUVELFNBQUtsQixNQUFMLENBQVlpQixHQUFaLENBQWdCLE9BQWhCLEVBQTBCLGlDQUFnQzhHLFFBQVEsQ0FBQ3hCLElBQUssVUFBU3dCLFFBQVEsQ0FBQ3RCLEtBQU0sSUFBaEc7QUFFQSxRQUFJNEIsVUFBVSxHQUFHckgsTUFBTSxDQUFDUSxRQUFQLENBQWdCdUcsUUFBUSxDQUFDeEIsSUFBekIsQ0FBakI7QUFDQSxRQUFJK0IsV0FBVyxHQUFHdEgsTUFBTSxDQUFDUSxRQUFQLENBQWdCdUcsUUFBUSxDQUFDdEIsS0FBekIsQ0FBbEI7QUFFQSxRQUFJaUQsV0FBVyxHQUFHckIsVUFBVSxDQUFDbkQsV0FBWCxFQUFsQjtBQUNBLFFBQUlxRCxZQUFZLEdBQUdELFdBQVcsQ0FBQ3BELFdBQVosRUFBbkI7O0FBRUEsUUFBSXpCLEtBQUssQ0FBQ0MsT0FBTixDQUFjZ0csV0FBZCxLQUE4QmpHLEtBQUssQ0FBQ0MsT0FBTixDQUFjNkUsWUFBZCxDQUFsQyxFQUErRDtBQUMzRCxZQUFNLElBQUluRixLQUFKLENBQVUsNkRBQVYsQ0FBTjtBQUNIOztBQUVELFFBQUl1RyxVQUFVLEdBQUdoSyxZQUFZLENBQUM2SSxxQkFBYixDQUFtQ1QsUUFBUSxDQUFDeEIsSUFBNUMsRUFBa0Q4QixVQUFsRCxDQUFqQjtBQUNBLFFBQUl1QixVQUFVLEdBQUdqSyxZQUFZLENBQUM2SSxxQkFBYixDQUFtQ1QsUUFBUSxDQUFDdEIsS0FBNUMsRUFBbUQ2QixXQUFuRCxDQUFqQjtBQUVBLFFBQUl1QixVQUFVLEdBQUc7QUFDYnhHLE1BQUFBLFFBQVEsRUFBRSxDQUFFLGlCQUFGLENBREc7QUFFYlksTUFBQUEsTUFBTSxFQUFFO0FBQ0osU0FBQzBGLFVBQUQsR0FBY0QsV0FEVjtBQUVKLFNBQUNFLFVBQUQsR0FBY3JCO0FBRlYsT0FGSztBQU1iOUgsTUFBQUEsR0FBRyxFQUFFLENBQUVrSixVQUFGLEVBQWNDLFVBQWQ7QUFOUSxLQUFqQjtBQVNBLFFBQUlsSSxNQUFNLEdBQUcsSUFBSW5DLE1BQUosQ0FBVyxLQUFLVSxNQUFoQixFQUF3Qm1KLGtCQUF4QixFQUE0Q3BJLE1BQU0sQ0FBQzhJLFNBQW5ELEVBQThERCxVQUE5RCxDQUFiO0FBQ0FuSSxJQUFBQSxNQUFNLENBQUNxSSxJQUFQO0FBQ0FySSxJQUFBQSxNQUFNLENBQUNzSSx3QkFBUDs7QUFFQSxTQUFLMUQsYUFBTCxDQUFtQjhDLGtCQUFuQixFQUF1Q08sVUFBdkMsRUFBbUQ1QixRQUFRLENBQUN4QixJQUE1RCxFQUFrRThCLFVBQVUsQ0FBQzVILEdBQTdFOztBQUNBLFNBQUs2RixhQUFMLENBQW1COEMsa0JBQW5CLEVBQXVDUSxVQUF2QyxFQUFtRDdCLFFBQVEsQ0FBQ3RCLEtBQTVELEVBQW1FNkIsV0FBVyxDQUFDN0gsR0FBL0U7O0FBRUFPLElBQUFBLE1BQU0sQ0FBQ2lKLFNBQVAsQ0FBaUJiLGtCQUFqQixFQUFxQzFILE1BQXJDO0FBQ0g7O0FBRURnSCxFQUFBQSxnQkFBZ0IsQ0FBQ0QsU0FBRCxFQUFZO0FBQ3hCLFdBQU9uSCxNQUFNLENBQUM4QyxNQUFQLENBQWNoRixDQUFDLENBQUNnSCxJQUFGLENBQU9xQyxTQUFQLEVBQWtCeUIsTUFBTSxDQUFDQyxpQkFBekIsQ0FBZCxFQUEyRDtBQUFFQyxNQUFBQSxXQUFXLEVBQUU7QUFBZixLQUEzRCxDQUFQO0FBQ0g7O0FBRUQzRixFQUFBQSxVQUFVLENBQUM0RixRQUFELEVBQVdDLE9BQVgsRUFBb0I7QUFDMUJqTCxJQUFBQSxFQUFFLENBQUNrTCxjQUFILENBQWtCRixRQUFsQjtBQUNBaEwsSUFBQUEsRUFBRSxDQUFDbUwsYUFBSCxDQUFpQkgsUUFBakIsRUFBMkJDLE9BQTNCO0FBRUEsU0FBS3RLLE1BQUwsQ0FBWWlCLEdBQVosQ0FBZ0IsTUFBaEIsRUFBd0IsMEJBQTBCb0osUUFBbEQ7QUFDSDs7QUFFRHhFLEVBQUFBLGtCQUFrQixDQUFDN0UsTUFBRCxFQUFTb0ksa0JBQVQsRUFBNkJxQixPQUE3QixFQUFzQ0MsT0FBdEMsRUFBK0M7QUFDN0QsUUFBSWIsVUFBVSxHQUFHO0FBQ2J4RyxNQUFBQSxRQUFRLEVBQUUsQ0FBRSxpQkFBRixDQURHO0FBRWI1QyxNQUFBQSxHQUFHLEVBQUUsQ0FBRWdLLE9BQU8sQ0FBQ3ZKLElBQVYsRUFBZ0J3SixPQUFPLENBQUN4SixJQUF4QjtBQUZRLEtBQWpCO0FBS0EsUUFBSVEsTUFBTSxHQUFHLElBQUluQyxNQUFKLENBQVcsS0FBS1UsTUFBaEIsRUFBd0JtSixrQkFBeEIsRUFBNENwSSxNQUFNLENBQUM4SSxTQUFuRCxFQUE4REQsVUFBOUQsQ0FBYjtBQUNBbkksSUFBQUEsTUFBTSxDQUFDcUksSUFBUDtBQUVBL0ksSUFBQUEsTUFBTSxDQUFDaUosU0FBUCxDQUFpQnZJLE1BQWpCO0FBRUEsV0FBT0EsTUFBUDtBQUNIOztBQUVEb0UsRUFBQUEscUJBQXFCLENBQUM2RSxjQUFELEVBQWlCRixPQUFqQixFQUEwQkMsT0FBMUIsRUFBbUM7QUFDcEQsUUFBSXRCLGtCQUFrQixHQUFHdUIsY0FBYyxDQUFDekosSUFBeEM7QUFFQSxRQUFJMEosVUFBVSxHQUFHSCxPQUFPLENBQUN2RixXQUFSLEVBQWpCOztBQUNBLFFBQUl6QixLQUFLLENBQUNDLE9BQU4sQ0FBY2tILFVBQWQsQ0FBSixFQUErQjtBQUMzQixZQUFNLElBQUl4SCxLQUFKLENBQVcscURBQW9EcUgsT0FBTyxDQUFDdkosSUFBSyxFQUE1RSxDQUFOO0FBQ0g7O0FBRUQsUUFBSTJKLFVBQVUsR0FBR0gsT0FBTyxDQUFDeEYsV0FBUixFQUFqQjs7QUFDQSxRQUFJekIsS0FBSyxDQUFDQyxPQUFOLENBQWNtSCxVQUFkLENBQUosRUFBK0I7QUFDM0IsWUFBTSxJQUFJekgsS0FBSixDQUFXLHFEQUFvRHNILE9BQU8sQ0FBQ3hKLElBQUssRUFBNUUsQ0FBTjtBQUNIOztBQUVEeUosSUFBQUEsY0FBYyxDQUFDdEUsYUFBZixDQUE2Qm9FLE9BQU8sQ0FBQ3ZKLElBQXJDLEVBQTJDdUosT0FBM0MsRUFBb0RyTCxDQUFDLENBQUMrRyxJQUFGLENBQU95RSxVQUFQLEVBQW1CLENBQUMsVUFBRCxDQUFuQixDQUFwRDtBQUNBRCxJQUFBQSxjQUFjLENBQUN0RSxhQUFmLENBQTZCcUUsT0FBTyxDQUFDeEosSUFBckMsRUFBMkN3SixPQUEzQyxFQUFvRHRMLENBQUMsQ0FBQytHLElBQUYsQ0FBTzBFLFVBQVAsRUFBbUIsQ0FBQyxVQUFELENBQW5CLENBQXBEOztBQUVBLFNBQUt2RSxhQUFMLENBQW1COEMsa0JBQW5CLEVBQXVDcUIsT0FBTyxDQUFDdkosSUFBL0MsRUFBcUR1SixPQUFPLENBQUN2SixJQUE3RCxFQUFtRTBKLFVBQVUsQ0FBQzFKLElBQTlFOztBQUNBLFNBQUtvRixhQUFMLENBQW1COEMsa0JBQW5CLEVBQXVDc0IsT0FBTyxDQUFDeEosSUFBL0MsRUFBcUR3SixPQUFPLENBQUN4SixJQUE3RCxFQUFtRTJKLFVBQVUsQ0FBQzNKLElBQTlFOztBQUNBLFNBQUtMLGlCQUFMLENBQXVCdUksa0JBQXZCLElBQTZDLElBQTdDO0FBQ0g7O0FBRUQsU0FBTzBCLFVBQVAsQ0FBa0JDLEVBQWxCLEVBQXNCO0FBQ2xCLFlBQVFBLEVBQVI7QUFDSSxXQUFLLEdBQUw7QUFDSSxlQUFPLEdBQVA7O0FBRUo7QUFDSSxjQUFNLElBQUkzSCxLQUFKLENBQVUsK0JBQVYsQ0FBTjtBQUxSO0FBT0g7O0FBRUQsU0FBTzRILFFBQVAsQ0FBZ0JoSyxNQUFoQixFQUF3QmlLLEdBQXhCLEVBQTZCQyxHQUE3QixFQUFrQ0MsTUFBbEMsRUFBMEM7QUFDdEMsUUFBSSxDQUFDRCxHQUFHLENBQUNFLE9BQVQsRUFBa0I7QUFDZCxhQUFPRixHQUFQO0FBQ0g7O0FBRUQsWUFBUUEsR0FBRyxDQUFDRSxPQUFaO0FBQ0ksV0FBSyxrQkFBTDtBQUNJLFlBQUk3RSxJQUFKLEVBQVVFLEtBQVY7O0FBRUEsWUFBSXlFLEdBQUcsQ0FBQzNFLElBQUosQ0FBUzZFLE9BQWIsRUFBc0I7QUFDbEI3RSxVQUFBQSxJQUFJLEdBQUc1RyxZQUFZLENBQUNxTCxRQUFiLENBQXNCaEssTUFBdEIsRUFBOEJpSyxHQUE5QixFQUFtQ0MsR0FBRyxDQUFDM0UsSUFBdkMsRUFBNkM0RSxNQUE3QyxDQUFQO0FBQ0gsU0FGRCxNQUVPO0FBQ0g1RSxVQUFBQSxJQUFJLEdBQUcyRSxHQUFHLENBQUMzRSxJQUFYO0FBQ0g7O0FBRUQsWUFBSTJFLEdBQUcsQ0FBQ3pFLEtBQUosQ0FBVTJFLE9BQWQsRUFBdUI7QUFDbkIzRSxVQUFBQSxLQUFLLEdBQUc5RyxZQUFZLENBQUNxTCxRQUFiLENBQXNCaEssTUFBdEIsRUFBOEJpSyxHQUE5QixFQUFtQ0MsR0FBRyxDQUFDekUsS0FBdkMsRUFBOEMwRSxNQUE5QyxDQUFSO0FBQ0gsU0FGRCxNQUVPO0FBQ0gxRSxVQUFBQSxLQUFLLEdBQUd5RSxHQUFHLENBQUN6RSxLQUFaO0FBQ0g7O0FBRUQsZUFBT0YsSUFBSSxHQUFHLEdBQVAsR0FBYTVHLFlBQVksQ0FBQ21MLFVBQWIsQ0FBd0JJLEdBQUcsQ0FBQ0csUUFBNUIsQ0FBYixHQUFxRCxHQUFyRCxHQUEyRDVFLEtBQWxFOztBQUVKLFdBQUssaUJBQUw7QUFDSSxZQUFJLENBQUNuSCxRQUFRLENBQUNnTSxjQUFULENBQXdCSixHQUFHLENBQUNoSyxJQUE1QixDQUFMLEVBQXdDO0FBQ3BDLGNBQUlpSyxNQUFNLElBQUkvTCxDQUFDLENBQUN5SCxJQUFGLENBQU9zRSxNQUFQLEVBQWVJLENBQUMsSUFBSUEsQ0FBQyxDQUFDckssSUFBRixLQUFXZ0ssR0FBRyxDQUFDaEssSUFBbkMsTUFBNkMsQ0FBQyxDQUE1RCxFQUErRDtBQUMzRCxtQkFBTyxNQUFNOUIsQ0FBQyxDQUFDb00sVUFBRixDQUFhTixHQUFHLENBQUNoSyxJQUFqQixDQUFiO0FBQ0g7O0FBRUQsZ0JBQU0sSUFBSWtDLEtBQUosQ0FBVyx3Q0FBdUM4SCxHQUFHLENBQUNoSyxJQUFLLElBQTNELENBQU47QUFDSDs7QUFFRCxZQUFJO0FBQUV1SyxVQUFBQSxVQUFGO0FBQWMvSixVQUFBQSxNQUFkO0FBQXNCNEYsVUFBQUE7QUFBdEIsWUFBZ0NoSSxRQUFRLENBQUNvTSx3QkFBVCxDQUFrQzFLLE1BQWxDLEVBQTBDaUssR0FBMUMsRUFBK0NDLEdBQUcsQ0FBQ2hLLElBQW5ELENBQXBDO0FBRUEsZUFBT3VLLFVBQVUsQ0FBQ0UsS0FBWCxHQUFtQixHQUFuQixHQUF5QmhNLFlBQVksQ0FBQ2lNLGVBQWIsQ0FBNkJ0RSxLQUFLLENBQUNwRyxJQUFuQyxDQUFoQzs7QUFFSjtBQUNJLGNBQU0sSUFBSWtDLEtBQUosQ0FBVSw2QkFBVixDQUFOO0FBaENSO0FBa0NIOztBQUVELFNBQU95SSxhQUFQLENBQXFCN0ssTUFBckIsRUFBNkJpSyxHQUE3QixFQUFrQ0MsR0FBbEMsRUFBdUM7QUFDbkMsV0FBT3ZMLFlBQVksQ0FBQ3FMLFFBQWIsQ0FBc0JoSyxNQUF0QixFQUE4QmlLLEdBQTlCLEVBQW1DO0FBQUVHLE1BQUFBLE9BQU8sRUFBRSxpQkFBWDtBQUE4QmxLLE1BQUFBLElBQUksRUFBRWdLLEdBQUcsQ0FBQzVEO0FBQXhDLEtBQW5DLEtBQXVGNEQsR0FBRyxDQUFDWSxNQUFKLEdBQWEsRUFBYixHQUFrQixPQUF6RyxDQUFQO0FBQ0g7O0FBRURDLEVBQUFBLGtCQUFrQixDQUFDNUssY0FBRCxFQUFpQjZLLElBQWpCLEVBQXVCO0FBQ3JDLFFBQUlDLEdBQUcsR0FBRyxJQUFWOztBQUVBLFFBQUloQixHQUFHLEdBQUc3TCxDQUFDLENBQUM4TSxTQUFGLENBQVlGLElBQUksQ0FBQ0csb0JBQUwsQ0FBMEJoTCxjQUExQixDQUFaLENBQVY7O0FBSUEsUUFBSSxDQUFFaUwsT0FBRixFQUFXVCxLQUFYLEVBQWtCVSxLQUFsQixJQUE0QixLQUFLQyxnQkFBTCxDQUFzQm5MLGNBQXRCLEVBQXNDOEosR0FBdEMsRUFBMkMsQ0FBM0MsQ0FBaEM7O0FBRUFnQixJQUFBQSxHQUFHLElBQUksWUFBWUcsT0FBTyxDQUFDakssSUFBUixDQUFhLElBQWIsQ0FBWixHQUFpQyxRQUFqQyxHQUE0Q3hDLFlBQVksQ0FBQ2lNLGVBQWIsQ0FBNkJYLEdBQUcsQ0FBQ3ZKLE1BQWpDLENBQTVDLEdBQXVGLE1BQXZGLEdBQWdHaUssS0FBdkc7O0FBRUEsUUFBSSxDQUFDdk0sQ0FBQyxDQUFDdUMsT0FBRixDQUFVMEssS0FBVixDQUFMLEVBQXVCO0FBQ25CSixNQUFBQSxHQUFHLElBQUksTUFBTUksS0FBSyxDQUFDbEssSUFBTixDQUFXLEdBQVgsQ0FBYjtBQUNIOztBQUVELFFBQUksQ0FBQy9DLENBQUMsQ0FBQ3VDLE9BQUYsQ0FBVXFLLElBQUksQ0FBQ08sUUFBZixDQUFMLEVBQStCO0FBQzNCTixNQUFBQSxHQUFHLElBQUksWUFBWUQsSUFBSSxDQUFDTyxRQUFMLENBQWN0RCxHQUFkLENBQWtCdUQsTUFBTSxJQUFJN00sWUFBWSxDQUFDcUwsUUFBYixDQUFzQjdKLGNBQXRCLEVBQXNDOEosR0FBdEMsRUFBMkN1QixNQUEzQyxFQUFtRFIsSUFBSSxDQUFDYixNQUF4RCxDQUE1QixFQUE2RmhKLElBQTdGLENBQWtHLE9BQWxHLENBQW5CO0FBQ0g7O0FBRUQsUUFBSSxDQUFDL0MsQ0FBQyxDQUFDdUMsT0FBRixDQUFVcUssSUFBSSxDQUFDUyxPQUFmLENBQUwsRUFBOEI7QUFDMUJSLE1BQUFBLEdBQUcsSUFBSSxlQUFlRCxJQUFJLENBQUNTLE9BQUwsQ0FBYXhELEdBQWIsQ0FBaUJ5RCxHQUFHLElBQUkvTSxZQUFZLENBQUNrTSxhQUFiLENBQTJCMUssY0FBM0IsRUFBMkM4SixHQUEzQyxFQUFnRHlCLEdBQWhELENBQXhCLEVBQThFdkssSUFBOUUsQ0FBbUYsSUFBbkYsQ0FBdEI7QUFDSDs7QUFFRCxRQUFJLENBQUMvQyxDQUFDLENBQUN1QyxPQUFGLENBQVVxSyxJQUFJLENBQUNXLE9BQWYsQ0FBTCxFQUE4QjtBQUMxQlYsTUFBQUEsR0FBRyxJQUFJLGVBQWVELElBQUksQ0FBQ1csT0FBTCxDQUFhMUQsR0FBYixDQUFpQnlELEdBQUcsSUFBSS9NLFlBQVksQ0FBQ2tNLGFBQWIsQ0FBMkIxSyxjQUEzQixFQUEyQzhKLEdBQTNDLEVBQWdEeUIsR0FBaEQsQ0FBeEIsRUFBOEV2SyxJQUE5RSxDQUFtRixJQUFuRixDQUF0QjtBQUNIOztBQUVELFFBQUl5SyxJQUFJLEdBQUdaLElBQUksQ0FBQ1ksSUFBTCxJQUFhLENBQXhCOztBQUNBLFFBQUlaLElBQUksQ0FBQ2EsS0FBVCxFQUFnQjtBQUNaWixNQUFBQSxHQUFHLElBQUksWUFBWXRNLFlBQVksQ0FBQ3FMLFFBQWIsQ0FBc0I3SixjQUF0QixFQUFzQzhKLEdBQXRDLEVBQTJDMkIsSUFBM0MsRUFBaURaLElBQUksQ0FBQ2IsTUFBdEQsQ0FBWixHQUE0RSxJQUE1RSxHQUFtRnhMLFlBQVksQ0FBQ3FMLFFBQWIsQ0FBc0I3SixjQUF0QixFQUFzQzhKLEdBQXRDLEVBQTJDZSxJQUFJLENBQUNhLEtBQWhELEVBQXVEYixJQUFJLENBQUNiLE1BQTVELENBQTFGO0FBQ0gsS0FGRCxNQUVPLElBQUlhLElBQUksQ0FBQ1ksSUFBVCxFQUFlO0FBQ2xCWCxNQUFBQSxHQUFHLElBQUksYUFBYXRNLFlBQVksQ0FBQ3FMLFFBQWIsQ0FBc0I3SixjQUF0QixFQUFzQzhKLEdBQXRDLEVBQTJDZSxJQUFJLENBQUNZLElBQWhELEVBQXNEWixJQUFJLENBQUNiLE1BQTNELENBQXBCO0FBQ0g7O0FBRUQsV0FBT2MsR0FBUDtBQUNIOztBQUVESyxFQUFBQSxnQkFBZ0IsQ0FBQ3RMLE1BQUQsRUFBU2lLLEdBQVQsRUFBYzZCLFVBQWQsRUFBMEI7QUFDdEMsUUFBSXBMLE1BQU0sR0FBR1YsTUFBTSxDQUFDUSxRQUFQLENBQWdCeUosR0FBRyxDQUFDdkosTUFBcEIsQ0FBYjtBQUNBLFFBQUlpSyxLQUFLLEdBQUd6TSxJQUFJLENBQUM0TixVQUFVLEVBQVgsQ0FBaEI7QUFDQTdCLElBQUFBLEdBQUcsQ0FBQ1UsS0FBSixHQUFZQSxLQUFaO0FBRUEsUUFBSVMsT0FBTyxHQUFHOUssTUFBTSxDQUFDNEMsSUFBUCxDQUFZeEMsTUFBTSxDQUFDdUMsTUFBbkIsRUFBMkJnRixHQUEzQixDQUErQjhELENBQUMsSUFBSXBCLEtBQUssR0FBRyxHQUFSLEdBQWNoTSxZQUFZLENBQUNpTSxlQUFiLENBQTZCbUIsQ0FBN0IsQ0FBbEQsQ0FBZDtBQUNBLFFBQUlWLEtBQUssR0FBRyxFQUFaOztBQUVBLFFBQUksQ0FBQ2pOLENBQUMsQ0FBQ3VDLE9BQUYsQ0FBVXNKLEdBQUcsQ0FBQytCLFlBQWQsQ0FBTCxFQUFrQztBQUM5QjVOLE1BQUFBLENBQUMsQ0FBQ2tFLE1BQUYsQ0FBUzJILEdBQUcsQ0FBQytCLFlBQWIsRUFBMkIsQ0FBQy9CLEdBQUQsRUFBTWdDLFNBQU4sS0FBb0I7QUFDM0MsWUFBSSxDQUFFQyxVQUFGLEVBQWNDLFFBQWQsRUFBd0JDLFFBQXhCLEVBQWtDQyxXQUFsQyxJQUFrRCxLQUFLZixnQkFBTCxDQUFzQnRMLE1BQXRCLEVBQThCaUssR0FBOUIsRUFBbUM2QixVQUFuQyxDQUF0RDs7QUFDQUEsUUFBQUEsVUFBVSxHQUFHTyxXQUFiO0FBQ0FqQixRQUFBQSxPQUFPLEdBQUdBLE9BQU8sQ0FBQ2tCLE1BQVIsQ0FBZUosVUFBZixDQUFWO0FBRUFiLFFBQUFBLEtBQUssQ0FBQ2xJLElBQU4sQ0FBVyxlQUFleEUsWUFBWSxDQUFDaU0sZUFBYixDQUE2QlgsR0FBRyxDQUFDdkosTUFBakMsQ0FBZixHQUEwRCxNQUExRCxHQUFtRXlMLFFBQW5FLEdBQ0wsTUFESyxHQUNJeEIsS0FESixHQUNZLEdBRFosR0FDa0JoTSxZQUFZLENBQUNpTSxlQUFiLENBQTZCcUIsU0FBN0IsQ0FEbEIsR0FDNEQsS0FENUQsR0FFUEUsUUFGTyxHQUVJLEdBRkosR0FFVXhOLFlBQVksQ0FBQ2lNLGVBQWIsQ0FBNkJYLEdBQUcsQ0FBQ3NDLGFBQWpDLENBRnJCOztBQUlBLFlBQUksQ0FBQ25PLENBQUMsQ0FBQ3VDLE9BQUYsQ0FBVXlMLFFBQVYsQ0FBTCxFQUEwQjtBQUN0QmYsVUFBQUEsS0FBSyxHQUFHQSxLQUFLLENBQUNpQixNQUFOLENBQWFGLFFBQWIsQ0FBUjtBQUNIO0FBQ0osT0FaRDtBQWFIOztBQUVELFdBQU8sQ0FBRWhCLE9BQUYsRUFBV1QsS0FBWCxFQUFrQlUsS0FBbEIsRUFBeUJTLFVBQXpCLENBQVA7QUFDSDs7QUFFRGpKLEVBQUFBLHFCQUFxQixDQUFDakIsVUFBRCxFQUFhbEIsTUFBYixFQUFxQjtBQUN0QyxRQUFJdUssR0FBRyxHQUFHLGlDQUFpQ3JKLFVBQWpDLEdBQThDLE9BQXhEOztBQUdBeEQsSUFBQUEsQ0FBQyxDQUFDcUMsSUFBRixDQUFPQyxNQUFNLENBQUN1QyxNQUFkLEVBQXNCLENBQUNxRCxLQUFELEVBQVFwRyxJQUFSLEtBQWlCO0FBQ25DK0ssTUFBQUEsR0FBRyxJQUFJLE9BQU90TSxZQUFZLENBQUNpTSxlQUFiLENBQTZCMUssSUFBN0IsQ0FBUCxHQUE0QyxHQUE1QyxHQUFrRHZCLFlBQVksQ0FBQzZOLGdCQUFiLENBQThCbEcsS0FBOUIsQ0FBbEQsR0FBeUYsS0FBaEc7QUFDSCxLQUZEOztBQUtBMkUsSUFBQUEsR0FBRyxJQUFJLG9CQUFvQnRNLFlBQVksQ0FBQzhOLGdCQUFiLENBQThCL0wsTUFBTSxDQUFDakIsR0FBckMsQ0FBcEIsR0FBZ0UsTUFBdkU7O0FBR0EsUUFBSWlCLE1BQU0sQ0FBQ2dNLE9BQVAsSUFBa0JoTSxNQUFNLENBQUNnTSxPQUFQLENBQWV6SyxNQUFmLEdBQXdCLENBQTlDLEVBQWlEO0FBQzdDdkIsTUFBQUEsTUFBTSxDQUFDZ00sT0FBUCxDQUFlNUwsT0FBZixDQUF1QmtILEtBQUssSUFBSTtBQUM1QmlELFFBQUFBLEdBQUcsSUFBSSxJQUFQOztBQUNBLFlBQUlqRCxLQUFLLENBQUNILE1BQVYsRUFBa0I7QUFDZG9ELFVBQUFBLEdBQUcsSUFBSSxTQUFQO0FBQ0g7O0FBQ0RBLFFBQUFBLEdBQUcsSUFBSSxVQUFVdE0sWUFBWSxDQUFDOE4sZ0JBQWIsQ0FBOEJ6RSxLQUFLLENBQUMvRSxNQUFwQyxDQUFWLEdBQXdELE1BQS9EO0FBQ0gsT0FORDtBQU9IOztBQUVELFFBQUkwSixLQUFLLEdBQUcsRUFBWjs7QUFDQSxTQUFLdk4sT0FBTCxDQUFhNkIsSUFBYixDQUFrQiwrQkFBK0JXLFVBQWpELEVBQTZEK0ssS0FBN0Q7O0FBQ0EsUUFBSUEsS0FBSyxDQUFDMUssTUFBTixHQUFlLENBQW5CLEVBQXNCO0FBQ2xCZ0osTUFBQUEsR0FBRyxJQUFJLE9BQU8wQixLQUFLLENBQUN4TCxJQUFOLENBQVcsT0FBWCxDQUFkO0FBQ0gsS0FGRCxNQUVPO0FBQ0g4SixNQUFBQSxHQUFHLEdBQUdBLEdBQUcsQ0FBQzJCLE1BQUosQ0FBVyxDQUFYLEVBQWMzQixHQUFHLENBQUNoSixNQUFKLEdBQVcsQ0FBekIsQ0FBTjtBQUNIOztBQUVEZ0osSUFBQUEsR0FBRyxJQUFJLEtBQVA7QUFHQSxRQUFJNEIsVUFBVSxHQUFHLEVBQWpCOztBQUNBLFNBQUt6TixPQUFMLENBQWE2QixJQUFiLENBQWtCLHFCQUFxQlcsVUFBdkMsRUFBbURpTCxVQUFuRDs7QUFDQSxRQUFJQyxLQUFLLEdBQUd4TSxNQUFNLENBQUM4QyxNQUFQLENBQWMsRUFBZCxFQUFrQixLQUFLL0QsVUFBTCxDQUFnQk0sS0FBbEMsRUFBeUNrTixVQUF6QyxDQUFaO0FBRUE1QixJQUFBQSxHQUFHLEdBQUc3TSxDQUFDLENBQUMyTyxNQUFGLENBQVNELEtBQVQsRUFBZ0IsVUFBU2hMLE1BQVQsRUFBaUJ0QyxLQUFqQixFQUF3QkMsR0FBeEIsRUFBNkI7QUFDL0MsYUFBT3FDLE1BQU0sR0FBRyxHQUFULEdBQWVyQyxHQUFmLEdBQXFCLEdBQXJCLEdBQTJCRCxLQUFsQztBQUNILEtBRkssRUFFSHlMLEdBRkcsQ0FBTjtBQUlBQSxJQUFBQSxHQUFHLElBQUksS0FBUDtBQUVBLFdBQU9BLEdBQVA7QUFDSDs7QUFFRHpILEVBQUFBLHVCQUF1QixDQUFDNUIsVUFBRCxFQUFhbUYsUUFBYixFQUF1QjtBQUMxQyxRQUFJa0UsR0FBRyxHQUFHLGtCQUFrQnJKLFVBQWxCLEdBQ04sc0JBRE0sR0FDbUJtRixRQUFRLENBQUN2QixTQUQ1QixHQUN3QyxLQUR4QyxHQUVOLGNBRk0sR0FFV3VCLFFBQVEsQ0FBQ3RCLEtBRnBCLEdBRTRCLE1BRjVCLEdBRXFDc0IsUUFBUSxDQUFDckIsVUFGOUMsR0FFMkQsS0FGckU7QUFJQXVGLElBQUFBLEdBQUcsSUFBSSxFQUFQOztBQUVBLFFBQUksS0FBS3BMLGlCQUFMLENBQXVCK0IsVUFBdkIsQ0FBSixFQUF3QztBQUNwQ3FKLE1BQUFBLEdBQUcsSUFBSSxxQ0FBUDtBQUNILEtBRkQsTUFFTztBQUNIQSxNQUFBQSxHQUFHLElBQUkseUNBQVA7QUFDSDs7QUFFREEsSUFBQUEsR0FBRyxJQUFJLEtBQVA7QUFFQSxXQUFPQSxHQUFQO0FBQ0g7O0FBRUQsU0FBT3pELHFCQUFQLENBQTZCNUYsVUFBN0IsRUFBeUNsQixNQUF6QyxFQUFpRDtBQUM3QyxRQUFJc00sUUFBUSxHQUFHN08sSUFBSSxDQUFDQyxDQUFMLENBQU82TyxTQUFQLENBQWlCckwsVUFBakIsQ0FBZjs7QUFDQSxRQUFJc0wsU0FBUyxHQUFHL08sSUFBSSxDQUFDa0ssVUFBTCxDQUFnQjNILE1BQU0sQ0FBQ2pCLEdBQXZCLENBQWhCOztBQUVBLFFBQUlyQixDQUFDLENBQUMrTyxRQUFGLENBQVdILFFBQVgsRUFBcUJFLFNBQXJCLENBQUosRUFBcUM7QUFDakMsYUFBT0YsUUFBUDtBQUNIOztBQUVELFdBQU9BLFFBQVEsR0FBR0UsU0FBbEI7QUFDSDs7QUFFRCxTQUFPRSxXQUFQLENBQW1CQyxHQUFuQixFQUF3QjtBQUNwQixXQUFPLE1BQU1BLEdBQUcsQ0FBQ0MsT0FBSixDQUFZLElBQVosRUFBa0IsS0FBbEIsQ0FBTixHQUFpQyxHQUF4QztBQUNIOztBQUVELFNBQU8xQyxlQUFQLENBQXVCeUMsR0FBdkIsRUFBNEI7QUFDeEIsV0FBTyxNQUFNQSxHQUFOLEdBQVksR0FBbkI7QUFDSDs7QUFFRCxTQUFPWixnQkFBUCxDQUF3QmMsR0FBeEIsRUFBNkI7QUFDekIsV0FBT25QLENBQUMsQ0FBQ3NFLE9BQUYsQ0FBVTZLLEdBQVYsSUFDSEEsR0FBRyxDQUFDdEYsR0FBSixDQUFRdUYsQ0FBQyxJQUFJN08sWUFBWSxDQUFDaU0sZUFBYixDQUE2QjRDLENBQTdCLENBQWIsRUFBOENyTSxJQUE5QyxDQUFtRCxJQUFuRCxDQURHLEdBRUh4QyxZQUFZLENBQUNpTSxlQUFiLENBQTZCMkMsR0FBN0IsQ0FGSjtBQUdIOztBQUVELFNBQU94TCxlQUFQLENBQXVCckIsTUFBdkIsRUFBK0I7QUFDM0IsUUFBSW9CLE1BQU0sR0FBRztBQUFFRSxNQUFBQSxNQUFNLEVBQUUsRUFBVjtBQUFjRyxNQUFBQSxRQUFRLEVBQUU7QUFBeEIsS0FBYjs7QUFFQSxRQUFJLENBQUN6QixNQUFNLENBQUNqQixHQUFaLEVBQWlCO0FBQ2JxQyxNQUFBQSxNQUFNLENBQUNFLE1BQVAsQ0FBY21CLElBQWQsQ0FBbUIsK0JBQW5CO0FBQ0g7O0FBRUQsV0FBT3JCLE1BQVA7QUFDSDs7QUFFRCxTQUFPMEssZ0JBQVAsQ0FBd0JsRyxLQUF4QixFQUErQm1ILE1BQS9CLEVBQXVDO0FBQ25DLFFBQUkvQixHQUFKOztBQUVBLFlBQVFwRixLQUFLLENBQUNuQyxJQUFkO0FBQ0ksV0FBSyxTQUFMO0FBQ0F1SCxRQUFBQSxHQUFHLEdBQUcvTSxZQUFZLENBQUMrTyxtQkFBYixDQUFpQ3BILEtBQWpDLENBQU47QUFDSTs7QUFFSixXQUFLLFFBQUw7QUFDQW9GLFFBQUFBLEdBQUcsR0FBSS9NLFlBQVksQ0FBQ2dQLHFCQUFiLENBQW1DckgsS0FBbkMsQ0FBUDtBQUNJOztBQUVKLFdBQUssTUFBTDtBQUNBb0YsUUFBQUEsR0FBRyxHQUFJL00sWUFBWSxDQUFDaVAsb0JBQWIsQ0FBa0N0SCxLQUFsQyxDQUFQO0FBQ0k7O0FBRUosV0FBSyxTQUFMO0FBQ0FvRixRQUFBQSxHQUFHLEdBQUkvTSxZQUFZLENBQUNrUCxvQkFBYixDQUFrQ3ZILEtBQWxDLENBQVA7QUFDSTs7QUFFSixXQUFLLFFBQUw7QUFDQW9GLFFBQUFBLEdBQUcsR0FBSS9NLFlBQVksQ0FBQ21QLHNCQUFiLENBQW9DeEgsS0FBcEMsQ0FBUDtBQUNJOztBQUVKLFdBQUssVUFBTDtBQUNBb0YsUUFBQUEsR0FBRyxHQUFJL00sWUFBWSxDQUFDb1Asd0JBQWIsQ0FBc0N6SCxLQUF0QyxDQUFQO0FBQ0k7O0FBRUosV0FBSyxRQUFMO0FBQ0FvRixRQUFBQSxHQUFHLEdBQUkvTSxZQUFZLENBQUNpUCxvQkFBYixDQUFrQ3RILEtBQWxDLENBQVA7QUFDSTs7QUFFSixXQUFLLE1BQUw7QUFDQW9GLFFBQUFBLEdBQUcsR0FBSS9NLFlBQVksQ0FBQ3FQLG9CQUFiLENBQWtDMUgsS0FBbEMsQ0FBUDtBQUNJOztBQUVKLFdBQUssT0FBTDtBQUNBb0YsUUFBQUEsR0FBRyxHQUFJL00sWUFBWSxDQUFDaVAsb0JBQWIsQ0FBa0N0SCxLQUFsQyxDQUFQO0FBQ0k7O0FBRUo7QUFDSSxjQUFNLElBQUlsRSxLQUFKLENBQVUsdUJBQXVCa0UsS0FBSyxDQUFDbkMsSUFBN0IsR0FBb0MsSUFBOUMsQ0FBTjtBQXRDUjs7QUF5Q0EsUUFBSTtBQUFFOEcsTUFBQUEsR0FBRjtBQUFPOUcsTUFBQUE7QUFBUCxRQUFnQnVILEdBQXBCOztBQUVBLFFBQUksQ0FBQytCLE1BQUwsRUFBYTtBQUNUeEMsTUFBQUEsR0FBRyxJQUFJLEtBQUtnRCxjQUFMLENBQW9CM0gsS0FBcEIsQ0FBUDtBQUNBMkUsTUFBQUEsR0FBRyxJQUFJLEtBQUtpRCxZQUFMLENBQWtCNUgsS0FBbEIsRUFBeUJuQyxJQUF6QixDQUFQO0FBQ0g7O0FBRUQsV0FBTzhHLEdBQVA7QUFDSDs7QUFFRCxTQUFPeUMsbUJBQVAsQ0FBMkI5TSxJQUEzQixFQUFpQztBQUM3QixRQUFJcUssR0FBSixFQUFTOUcsSUFBVDs7QUFFQSxRQUFJdkQsSUFBSSxDQUFDdU4sTUFBVCxFQUFpQjtBQUNiLFVBQUl2TixJQUFJLENBQUN1TixNQUFMLEdBQWMsRUFBbEIsRUFBc0I7QUFDbEJoSyxRQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsUUFBYjtBQUNILE9BRkQsTUFFTyxJQUFJckssSUFBSSxDQUFDdU4sTUFBTCxHQUFjLENBQWxCLEVBQXFCO0FBQ3hCaEssUUFBQUEsSUFBSSxHQUFHOEcsR0FBRyxHQUFHLEtBQWI7QUFDSCxPQUZNLE1BRUEsSUFBSXJLLElBQUksQ0FBQ3VOLE1BQUwsR0FBYyxDQUFsQixFQUFxQjtBQUN4QmhLLFFBQUFBLElBQUksR0FBRzhHLEdBQUcsR0FBRyxXQUFiO0FBQ0gsT0FGTSxNQUVBLElBQUlySyxJQUFJLENBQUN1TixNQUFMLEdBQWMsQ0FBbEIsRUFBcUI7QUFDeEJoSyxRQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsVUFBYjtBQUNILE9BRk0sTUFFQTtBQUNIOUcsUUFBQUEsSUFBSSxHQUFHOEcsR0FBRyxHQUFHLFNBQWI7QUFDSDs7QUFFREEsTUFBQUEsR0FBRyxJQUFLLElBQUdySyxJQUFJLENBQUN1TixNQUFPLEdBQXZCO0FBQ0gsS0FkRCxNQWNPO0FBQ0hoSyxNQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsS0FBYjtBQUNIOztBQUVELFFBQUlySyxJQUFJLENBQUN3TixRQUFULEVBQW1CO0FBQ2ZuRCxNQUFBQSxHQUFHLElBQUksV0FBUDtBQUNIOztBQUVELFdBQU87QUFBRUEsTUFBQUEsR0FBRjtBQUFPOUcsTUFBQUE7QUFBUCxLQUFQO0FBQ0g7O0FBRUQsU0FBT3dKLHFCQUFQLENBQTZCL00sSUFBN0IsRUFBbUM7QUFDL0IsUUFBSXFLLEdBQUcsR0FBRyxFQUFWO0FBQUEsUUFBYzlHLElBQWQ7O0FBRUEsUUFBSXZELElBQUksQ0FBQ3VELElBQUwsSUFBYSxRQUFiLElBQXlCdkQsSUFBSSxDQUFDeU4sS0FBbEMsRUFBeUM7QUFDckNsSyxNQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsU0FBYjs7QUFFQSxVQUFJckssSUFBSSxDQUFDME4sV0FBTCxHQUFtQixFQUF2QixFQUEyQjtBQUN2QixjQUFNLElBQUlsTSxLQUFKLENBQVUsb0NBQVYsQ0FBTjtBQUNIO0FBQ0osS0FORCxNQU1PO0FBQ0gsVUFBSXhCLElBQUksQ0FBQzBOLFdBQUwsR0FBbUIsRUFBdkIsRUFBMkI7QUFDdkJuSyxRQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsUUFBYjs7QUFFQSxZQUFJckssSUFBSSxDQUFDME4sV0FBTCxHQUFtQixFQUF2QixFQUEyQjtBQUN2QixnQkFBTSxJQUFJbE0sS0FBSixDQUFVLG9DQUFWLENBQU47QUFDSDtBQUNKLE9BTkQsTUFNTztBQUNIK0IsUUFBQUEsSUFBSSxHQUFHOEcsR0FBRyxHQUFHLE9BQWI7QUFDSDtBQUNKOztBQUVELFFBQUksaUJBQWlCckssSUFBckIsRUFBMkI7QUFDdkJxSyxNQUFBQSxHQUFHLElBQUksTUFBTXJLLElBQUksQ0FBQzBOLFdBQWxCOztBQUNBLFVBQUksbUJBQW1CMU4sSUFBdkIsRUFBNkI7QUFDekJxSyxRQUFBQSxHQUFHLElBQUksT0FBTXJLLElBQUksQ0FBQzJOLGFBQWxCO0FBQ0g7O0FBQ0R0RCxNQUFBQSxHQUFHLElBQUksR0FBUDtBQUVILEtBUEQsTUFPTztBQUNILFVBQUksbUJBQW1CckssSUFBdkIsRUFBNkI7QUFDekIsWUFBSUEsSUFBSSxDQUFDMk4sYUFBTCxHQUFxQixFQUF6QixFQUE2QjtBQUN6QnRELFVBQUFBLEdBQUcsSUFBSSxVQUFTckssSUFBSSxDQUFDMk4sYUFBZCxHQUE4QixHQUFyQztBQUNILFNBRkQsTUFFUTtBQUNKdEQsVUFBQUEsR0FBRyxJQUFJLFVBQVNySyxJQUFJLENBQUMyTixhQUFkLEdBQThCLEdBQXJDO0FBQ0g7QUFDSjtBQUNKOztBQUVELFdBQU87QUFBRXRELE1BQUFBLEdBQUY7QUFBTzlHLE1BQUFBO0FBQVAsS0FBUDtBQUNIOztBQUVELFNBQU95SixvQkFBUCxDQUE0QmhOLElBQTVCLEVBQWtDO0FBQzlCLFFBQUlxSyxHQUFHLEdBQUcsRUFBVjtBQUFBLFFBQWM5RyxJQUFkOztBQUVBLFFBQUl2RCxJQUFJLENBQUM0TixXQUFMLElBQW9CNU4sSUFBSSxDQUFDNE4sV0FBTCxJQUFvQixHQUE1QyxFQUFpRDtBQUM3Q3ZELE1BQUFBLEdBQUcsR0FBRyxVQUFVckssSUFBSSxDQUFDNE4sV0FBZixHQUE2QixHQUFuQztBQUNBckssTUFBQUEsSUFBSSxHQUFHLE1BQVA7QUFDSCxLQUhELE1BR08sSUFBSXZELElBQUksQ0FBQzZOLFNBQVQsRUFBb0I7QUFDdkIsVUFBSTdOLElBQUksQ0FBQzZOLFNBQUwsR0FBaUIsUUFBckIsRUFBK0I7QUFDM0J0SyxRQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsVUFBYjtBQUNILE9BRkQsTUFFTyxJQUFJckssSUFBSSxDQUFDNk4sU0FBTCxHQUFpQixLQUFyQixFQUE0QjtBQUMvQnRLLFFBQUFBLElBQUksR0FBRzhHLEdBQUcsR0FBRyxZQUFiO0FBQ0gsT0FGTSxNQUVBLElBQUlySyxJQUFJLENBQUM2TixTQUFMLEdBQWlCLElBQXJCLEVBQTJCO0FBQzlCdEssUUFBQUEsSUFBSSxHQUFHOEcsR0FBRyxHQUFHLE1BQWI7QUFDSCxPQUZNLE1BRUE7QUFDSDlHLFFBQUFBLElBQUksR0FBRzhHLEdBQUcsR0FBRyxTQUFiOztBQUNBLFlBQUlySyxJQUFJLENBQUM0TixXQUFULEVBQXNCO0FBQ2xCdkQsVUFBQUEsR0FBRyxJQUFJLE1BQU1ySyxJQUFJLENBQUM0TixXQUFYLEdBQXlCLEdBQWhDO0FBQ0gsU0FGRCxNQUVPO0FBQ0h2RCxVQUFBQSxHQUFHLElBQUksTUFBTXJLLElBQUksQ0FBQzZOLFNBQVgsR0FBdUIsR0FBOUI7QUFDSDtBQUNKO0FBQ0osS0FmTSxNQWVBO0FBQ0h0SyxNQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsTUFBYjtBQUNIOztBQUVELFdBQU87QUFBRUEsTUFBQUEsR0FBRjtBQUFPOUcsTUFBQUE7QUFBUCxLQUFQO0FBQ0g7O0FBRUQsU0FBTzJKLHNCQUFQLENBQThCbE4sSUFBOUIsRUFBb0M7QUFDaEMsUUFBSXFLLEdBQUcsR0FBRyxFQUFWO0FBQUEsUUFBYzlHLElBQWQ7O0FBRUEsUUFBSXZELElBQUksQ0FBQzROLFdBQUwsSUFBb0IsR0FBeEIsRUFBNkI7QUFDekJ2RCxNQUFBQSxHQUFHLEdBQUcsWUFBWXJLLElBQUksQ0FBQzROLFdBQWpCLEdBQStCLEdBQXJDO0FBQ0FySyxNQUFBQSxJQUFJLEdBQUcsUUFBUDtBQUNILEtBSEQsTUFHTyxJQUFJdkQsSUFBSSxDQUFDNk4sU0FBVCxFQUFvQjtBQUN2QixVQUFJN04sSUFBSSxDQUFDNk4sU0FBTCxHQUFpQixRQUFyQixFQUErQjtBQUMzQnRLLFFBQUFBLElBQUksR0FBRzhHLEdBQUcsR0FBRyxVQUFiO0FBQ0gsT0FGRCxNQUVPLElBQUlySyxJQUFJLENBQUM2TixTQUFMLEdBQWlCLEtBQXJCLEVBQTRCO0FBQy9CdEssUUFBQUEsSUFBSSxHQUFHOEcsR0FBRyxHQUFHLFlBQWI7QUFDSCxPQUZNLE1BRUE7QUFDSDlHLFFBQUFBLElBQUksR0FBRzhHLEdBQUcsR0FBRyxXQUFiOztBQUNBLFlBQUlySyxJQUFJLENBQUM0TixXQUFULEVBQXNCO0FBQ2xCdkQsVUFBQUEsR0FBRyxJQUFJLE1BQU1ySyxJQUFJLENBQUM0TixXQUFYLEdBQXlCLEdBQWhDO0FBQ0gsU0FGRCxNQUVPO0FBQ0h2RCxVQUFBQSxHQUFHLElBQUksTUFBTXJLLElBQUksQ0FBQzZOLFNBQVgsR0FBdUIsR0FBOUI7QUFDSDtBQUNKO0FBQ0osS0FiTSxNQWFBO0FBQ0h0SyxNQUFBQSxJQUFJLEdBQUc4RyxHQUFHLEdBQUcsTUFBYjtBQUNIOztBQUVELFdBQU87QUFBRUEsTUFBQUEsR0FBRjtBQUFPOUcsTUFBQUE7QUFBUCxLQUFQO0FBQ0g7O0FBRUQsU0FBTzBKLG9CQUFQLEdBQThCO0FBQzFCLFdBQU87QUFBRTVDLE1BQUFBLEdBQUcsRUFBRSxZQUFQO0FBQXFCOUcsTUFBQUEsSUFBSSxFQUFFO0FBQTNCLEtBQVA7QUFDSDs7QUFFRCxTQUFPNEosd0JBQVAsQ0FBZ0NuTixJQUFoQyxFQUFzQztBQUNsQyxRQUFJcUssR0FBSjs7QUFFQSxRQUFJLENBQUNySyxJQUFJLENBQUM4TixLQUFOLElBQWU5TixJQUFJLENBQUM4TixLQUFMLEtBQWUsVUFBbEMsRUFBOEM7QUFDMUN6RCxNQUFBQSxHQUFHLEdBQUcsVUFBTjtBQUNILEtBRkQsTUFFTyxJQUFJckssSUFBSSxDQUFDOE4sS0FBTCxLQUFlLE1BQW5CLEVBQTJCO0FBQzlCekQsTUFBQUEsR0FBRyxHQUFHLE1BQU47QUFDSCxLQUZNLE1BRUEsSUFBSXJLLElBQUksQ0FBQzhOLEtBQUwsS0FBZSxNQUFuQixFQUEyQjtBQUM5QnpELE1BQUFBLEdBQUcsR0FBRyxNQUFOO0FBQ0gsS0FGTSxNQUVBLElBQUlySyxJQUFJLENBQUM4TixLQUFMLEtBQWUsTUFBbkIsRUFBMkI7QUFDOUJ6RCxNQUFBQSxHQUFHLEdBQUcsTUFBTjtBQUNILEtBRk0sTUFFQSxJQUFJckssSUFBSSxDQUFDOE4sS0FBTCxLQUFlLFdBQW5CLEVBQWdDO0FBQ25DekQsTUFBQUEsR0FBRyxHQUFHLFdBQU47QUFDSDs7QUFFRCxXQUFPO0FBQUVBLE1BQUFBLEdBQUY7QUFBTzlHLE1BQUFBLElBQUksRUFBRThHO0FBQWIsS0FBUDtBQUNIOztBQUVELFNBQU8rQyxvQkFBUCxDQUE0QnBOLElBQTVCLEVBQWtDO0FBQzlCLFdBQU87QUFBRXFLLE1BQUFBLEdBQUcsRUFBRSxVQUFVN00sQ0FBQyxDQUFDNkosR0FBRixDQUFNckgsSUFBSSxDQUFDTCxNQUFYLEVBQW9CaU4sQ0FBRCxJQUFPN08sWUFBWSxDQUFDeU8sV0FBYixDQUF5QkksQ0FBekIsQ0FBMUIsRUFBdURyTSxJQUF2RCxDQUE0RCxJQUE1RCxDQUFWLEdBQThFLEdBQXJGO0FBQTBGZ0QsTUFBQUEsSUFBSSxFQUFFO0FBQWhHLEtBQVA7QUFDSDs7QUFFRCxTQUFPOEosY0FBUCxDQUFzQnJOLElBQXRCLEVBQTRCO0FBQ3hCLFFBQUlBLElBQUksQ0FBQytOLGNBQUwsQ0FBb0IsVUFBcEIsS0FBbUMvTixJQUFJLENBQUMrRyxRQUE1QyxFQUFzRDtBQUNsRCxhQUFPLE9BQVA7QUFDSDs7QUFFRCxXQUFPLFdBQVA7QUFDSDs7QUFFRCxTQUFPdUcsWUFBUCxDQUFvQnROLElBQXBCLEVBQTBCdUQsSUFBMUIsRUFBZ0M7QUFDNUIsUUFBSXZELElBQUksQ0FBQ2dHLGlCQUFULEVBQTRCO0FBQ3hCaEcsTUFBQUEsSUFBSSxDQUFDZ08sVUFBTCxHQUFrQixJQUFsQjtBQUNBLGFBQU8sNEJBQVA7QUFDSDs7QUFFRCxRQUFJaE8sSUFBSSxDQUFDNEYsZUFBVCxFQUEwQjtBQUN0QjVGLE1BQUFBLElBQUksQ0FBQ2dPLFVBQUwsR0FBa0IsSUFBbEI7QUFDQSxhQUFPLGlCQUFQO0FBQ0g7O0FBRUQsUUFBSWhPLElBQUksQ0FBQ2lHLGlCQUFULEVBQTRCO0FBQ3hCakcsTUFBQUEsSUFBSSxDQUFDaU8sVUFBTCxHQUFrQixJQUFsQjtBQUNBLGFBQU8sOEJBQVA7QUFDSDs7QUFFRCxRQUFJNUQsR0FBRyxHQUFHLEVBQVY7O0FBRUEsUUFBSSxDQUFDckssSUFBSSxDQUFDK0csUUFBTixJQUFrQixDQUFDL0csSUFBSSxDQUFDK04sY0FBTCxDQUFvQixTQUFwQixDQUFuQixJQUFxRCxDQUFDL04sSUFBSSxDQUFDK04sY0FBTCxDQUFvQixNQUFwQixDQUExRCxFQUF1RjtBQUNuRixVQUFJbFEseUJBQXlCLENBQUNrRyxHQUExQixDQUE4QlIsSUFBOUIsQ0FBSixFQUF5QztBQUNyQyxlQUFPLEVBQVA7QUFDSDs7QUFFRCxVQUFJdkQsSUFBSSxDQUFDdUQsSUFBTCxLQUFjLFNBQWQsSUFBMkJ2RCxJQUFJLENBQUN1RCxJQUFMLEtBQWMsU0FBekMsSUFBc0R2RCxJQUFJLENBQUN1RCxJQUFMLEtBQWMsUUFBeEUsRUFBa0Y7QUFDOUU4RyxRQUFBQSxHQUFHLElBQUksWUFBUDtBQUNILE9BRkQsTUFFTztBQUNIQSxRQUFBQSxHQUFHLElBQUksYUFBUDtBQUNIOztBQUVEckssTUFBQUEsSUFBSSxDQUFDZ08sVUFBTCxHQUFrQixJQUFsQjtBQUNIOztBQTRERCxXQUFPM0QsR0FBUDtBQUNIOztBQUVELFNBQU82RCxxQkFBUCxDQUE2QmxOLFVBQTdCLEVBQXlDbU4saUJBQXpDLEVBQTREO0FBQ3hELFFBQUlBLGlCQUFKLEVBQXVCO0FBQ25Cbk4sTUFBQUEsVUFBVSxHQUFHeEQsQ0FBQyxDQUFDNFEsSUFBRixDQUFPNVEsQ0FBQyxDQUFDNlEsU0FBRixDQUFZck4sVUFBWixDQUFQLENBQWI7QUFFQW1OLE1BQUFBLGlCQUFpQixHQUFHM1EsQ0FBQyxDQUFDOFEsT0FBRixDQUFVOVEsQ0FBQyxDQUFDNlEsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUkzUSxDQUFDLENBQUMrUSxVQUFGLENBQWF2TixVQUFiLEVBQXlCbU4saUJBQXpCLENBQUosRUFBaUQ7QUFDN0NuTixRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ2dMLE1BQVgsQ0FBa0JtQyxpQkFBaUIsQ0FBQzlNLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU8zRCxRQUFRLENBQUNrRyxZQUFULENBQXNCNUMsVUFBdEIsQ0FBUDtBQUNIOztBQXpoQ2M7O0FBNGhDbkJ3TixNQUFNLENBQUNDLE9BQVAsR0FBaUIxUSxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBsdXJhbGl6ZSA9IHJlcXVpcmUoJ3BsdXJhbGl6ZScpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcyB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2ZpZWxkc1sxXV06IHJlY29yZH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogcmVjb3JkfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgYXNzb2MuY29ubmVjdGVkQnkpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGFzc29jLmNvbm5lY3RlZEJ5KTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06bS0ke2Rlc3RFbnRpdHlOYW1lfTpuIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9Om0tJHtlbnRpdHkubmFtZX06biBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5LCBkZXN0RW50aXR5KTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeScpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogYmFja1JlZi50eXBlID09PSAnaGFzT25lJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBNYW55IHRvIG9uZScpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmllbGQuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2J1aWxkUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbikge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0FuYWx5emluZyByZWxhdGlvbiBiZXR3ZWVuIFsnXG4gICAgICAgICsgcmVsYXRpb24ubGVmdCArICddIGFuZCBbJ1xuICAgICAgICArIHJlbGF0aW9uLnJpZ2h0ICsgJ10gcmVsYXRpb25zaGlwOiAnXG4gICAgICAgICsgcmVsYXRpb24ucmVsYXRpb25zaGlwICsgJyAuLi4nKTtcblxuICAgICAgICBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGROVG9OUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnMTpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIGZhbHNlKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICcxOjEnKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE9uZVRvQW55UmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbiwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjoxJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKHJlbGF0aW9uKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVEJEJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuXG4gICAgICAgIGxldCByaWdodEtleUluZm8gPSByaWdodEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgbGVmdEZpZWxkID0gcmVsYXRpb24ubGVmdEZpZWxkIHx8IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5KTtcblxuICAgICAgICBsZXQgZmllbGRJbmZvID0gdGhpcy5fcmVmaW5lTGVmdEZpZWxkKHJpZ2h0S2V5SW5mbyk7XG4gICAgICAgIGlmIChyZWxhdGlvbi5vcHRpb25hbCkge1xuICAgICAgICAgICAgZmllbGRJbmZvLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBsZWZ0RW50aXR5LmFkZEZpZWxkKGxlZnRGaWVsZCwgZmllbGRJbmZvKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb24ubGVmdCwgbGVmdEZpZWxkLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcbiAgICB9XG5cbiAgICBfYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIHVuaXF1ZSkge1xuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5sZWZ0XTtcbiAgICAgICAgbGV0IHJpZ2h0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLnJpZ2h0XTtcblxuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZCA9IHJlbGF0aW9uLmxlZnRGaWVsZCB8fCBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG5cbiAgICAgICAgbGV0IGZpZWxkSW5mbyA9IHRoaXMuX3JlZmluZUxlZnRGaWVsZChyaWdodEtleUluZm8pO1xuICAgICAgICBpZiAocmVsYXRpb24ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGZpZWxkSW5mby5vcHRpb25hbCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgbGVmdEVudGl0eS5hZGRGaWVsZChsZWZ0RmllbGQsIGZpZWxkSW5mbyk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uLmxlZnQsIGxlZnRGaWVsZCwgcmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uLm11bHRpICYmIF8ubGFzdChyZWxhdGlvbi5tdWx0aSkgPT09IHJlbGF0aW9uLnJpZ2h0KSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycsICgpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkczogXy5tYXAocmVsYXRpb24ubXVsdGksIHRvID0+IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcodG8sIHNjaGVtYS5lbnRpdGllc1t0b10pKSxcbiAgICAgICAgICAgICAgICAgICAgdW5pcXVlOiB1bmlxdWVcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgbGVmdEVudGl0eS5hZGRJbmRleChpbmRleCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9idWlsZE5Ub05SZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbi5sZWZ0ICsgVXRpbC5wYXNjYWxDYXNlKHBsdXJhbGl6ZS5wbHVyYWwocmVsYXRpb24ucmlnaHQpKTtcblxuICAgICAgICBpZiAoc2NoZW1hLmhhc0VudGl0eShyZWxhdGlvbkVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICBsZXQgZnVsbE5hbWUgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXS5pZDtcblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgWyR7cmVsYXRpb25FbnRpdHlOYW1lfV0gY29uZmxpY3RzIHdpdGggZW50aXR5IFske2Z1bGxOYW1lfV0gaW4gc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYENyZWF0ZSBhIHJlbGF0aW9uIGVudGl0eSBmb3IgXCIke3JlbGF0aW9uLmxlZnR9XCIgYW5kIFwiJHtyZWxhdGlvbi5yaWdodH1cIi5gKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuICAgICAgICBcbiAgICAgICAgbGV0IGxlZnRLZXlJbmZvID0gbGVmdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRLZXlJbmZvKSB8fCBBcnJheS5pc0FycmF5KHJpZ2h0S2V5SW5mbykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTXVsdGktZmllbGRzIGtleSBub3Qgc3VwcG9ydGVkIGZvciBub24tcmVsYXRpb25zaGlwIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsZWZ0RmllbGQxID0gTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5sZWZ0LCBsZWZ0RW50aXR5KTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZDIgPSBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG4gICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBmaWVsZHM6IHtcbiAgICAgICAgICAgICAgICBbbGVmdEZpZWxkMV06IGxlZnRLZXlJbmZvLFxuICAgICAgICAgICAgICAgIFtsZWZ0RmllbGQyXTogcmlnaHRLZXlJbmZvXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAga2V5OiBbIGxlZnRGaWVsZDEsIGxlZnRGaWVsZDIgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuICAgICAgICBlbnRpdHkubWFya0FzUmVsYXRpb25zaGlwRW50aXR5KCk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgbGVmdEZpZWxkMSwgcmVsYXRpb24ubGVmdCwgbGVmdEVudGl0eS5rZXkpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBsZWZ0RmllbGQyLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5KTtcbiAgICB9XG5cbiAgICBfcmVmaW5lTGVmdEZpZWxkKGZpZWxkSW5mbykge1xuICAgICAgICByZXR1cm4gT2JqZWN0LmFzc2lnbihfLnBpY2soZmllbGRJbmZvLCBPb2xvbmcuQlVJTFRJTl9UWVBFX0FUVFIpLCB7IGlzUmVmZXJlbmNlOiB0cnVlIH0pO1xuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTEubmFtZSwgZW50aXR5Mi5uYW1lIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkxLm5hbWUsIGVudGl0eTEsIF8ub21pdChrZXlFbnRpdHkxLCBbJ29wdGlvbmFsJ10pKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkyLm5hbWUsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxLm5hbWUsIGVudGl0eTEubmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5Mi5uYW1lLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwgJiYgIWluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiAhaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgIH1cbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19