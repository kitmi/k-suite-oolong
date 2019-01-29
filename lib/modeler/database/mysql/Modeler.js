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
        throw new Error('todo');
        break;

      case 'hasMany':
        let backRef = destEntity.getReferenceTo(entity.name, {
          type: 'refersTo',
          association: assoc
        });

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

            entity.addAssociation(assoc.srcField || pluralize(destEntityName), destEntity, {
              isList: true,
              optional: assoc.optional,
              connectedBy: connEntityName
            });
            destEntity.addAssociation(backRef.srcField || pluralize(entity.name), entity, {
              isList: true,
              optional: backRef.optional,
              connectedBy: connEntityName
            });
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
        entity.addAssociation(localField, destEntity, {
          isList: false,
          optional: assoc.optional
        });

        if (assoc.type === 'belongsTo') {
          let backRef = destEntity.getReferenceTo(entity.name, {
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
    relationEntity.addAssociation(entity1.name, entity1);
    relationEntity.addAssociation(entity2.name, entity2);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiYXNzb2NpYXRpb24iLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsImNvbm5lY3RlZEJ5IiwidGFnMSIsInRhZzIiLCJoYXMiLCJhZGRBc3NvY2lhdGlvbiIsInNyY0ZpZWxkIiwiaXNMaXN0Iiwib3B0aW9uYWwiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwiYWRkIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJ0eXBlcyIsInJlbW90ZUZpZWxkIiwiX2FkZFJlZmVyZW5jZSIsImxlZnQiLCJsZWZ0RmllbGQiLCJyaWdodCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJfYnVpbGRSZWxhdGlvbiIsInJlbGF0aW9uIiwicmVsYXRpb25zaGlwIiwiX2J1aWxkTlRvTlJlbGF0aW9uIiwiX2J1aWxkT25lVG9BbnlSZWxhdGlvbiIsIl9idWlsZE1hbnlUb09uZVJlbGF0aW9uIiwiY29uc29sZSIsImxlZnRFbnRpdHkiLCJyaWdodEVudGl0eSIsInJpZ2h0S2V5SW5mbyIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImZpZWxkSW5mbyIsIl9yZWZpbmVMZWZ0RmllbGQiLCJhZGRGaWVsZCIsInVuaXF1ZSIsIm11bHRpIiwibGFzdCIsImluZGV4IiwibWFwIiwidG8iLCJhZGRJbmRleCIsInJlbGF0aW9uRW50aXR5TmFtZSIsInBhc2NhbENhc2UiLCJwbHVyYWwiLCJoYXNFbnRpdHkiLCJmdWxsTmFtZSIsImlkIiwibGVmdEtleUluZm8iLCJsZWZ0RmllbGQxIiwibGVmdEZpZWxkMiIsImVudGl0eUluZm8iLCJsaW5rIiwibWFya0FzUmVsYXRpb25zaGlwRW50aXR5IiwiYWRkRW50aXR5IiwiT29sb25nIiwiQlVJTFRJTl9UWVBFX0FUVFIiLCJpc1JlZmVyZW5jZSIsImZpbGVQYXRoIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsImVudGl0eTEiLCJlbnRpdHkyIiwicmVsYXRpb25FbnRpdHkiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwib29sVHlwZSIsIm9wZXJhdG9yIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlZHVjZSIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJ2IiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRo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LENBQWtCbUMsaUJBQWlCLENBQUNwTixNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPM0QsUUFBUSxDQUFDb0csWUFBVCxDQUFzQjlDLFVBQXRCLENBQVA7QUFDSDs7QUF6a0NjOztBQTRrQ25COE4sTUFBTSxDQUFDQyxPQUFQLEdBQWlCaFIsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwbHVyYWxpemUgPSByZXF1aXJlKCdwbHVyYWxpemUnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgZXhpc3RpbmdFbnRpdGllcyA9IE9iamVjdC52YWx1ZXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIF8uZWFjaChleGlzdGluZ0VudGl0aWVzLCAoZW50aXR5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvJyk7XG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBhc3NvY2lhdGlvbjogYXNzb2MgfSk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoYXNzb2MuY29ubmVjdGVkQnkpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHlOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNvbm5lY3RlZEJ5XCIgcmVxdWlyZWQgZm9yIG06biByZWxhdGlvbi4gU291cmNlOiAke2VudGl0eS5uYW1lfSwgZGVzdGluYXRpb246ICR7ZGVzdEVudGl0eU5hbWV9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTptLSR7ZGVzdEVudGl0eU5hbWV9Om4gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06bS0ke2VudGl0eS5uYW1lfTpuIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogdHJ1ZSwgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsLCBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiB0cnVlLCBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCwgY29ubmVjdGVkQnk6IGNvbm5FbnRpdHlOYW1lIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHksIGRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGNvbm5lY3RlZEJ5Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IE1hbnkgdG8gb25lJyk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgIGxldCBmaWVsZFByb3BzID0geyAuLi5fLm9taXQoZGVzdEtleUZpZWxkLCBbJ29wdGlvbmFsJ10pLCAuLi5fLnBpY2soYXNzb2MsIFsnb3B0aW9uYWwnXSkgfTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgXG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogZmFsc2UsIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZXM6IFsgJ3JlZmVyc1RvJywgJ2JlbG9uZ3NUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogdHJ1ZSwgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzTGlzdDogYmFja1JlZi50eXBlID09PSAnaGFzTWFueScsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmllbGQuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2J1aWxkUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbikge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0FuYWx5emluZyByZWxhdGlvbiBiZXR3ZWVuIFsnXG4gICAgICAgICsgcmVsYXRpb24ubGVmdCArICddIGFuZCBbJ1xuICAgICAgICArIHJlbGF0aW9uLnJpZ2h0ICsgJ10gcmVsYXRpb25zaGlwOiAnXG4gICAgICAgICsgcmVsYXRpb24ucmVsYXRpb25zaGlwICsgJyAuLi4nKTtcblxuICAgICAgICBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGROVG9OUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbik7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnMTpuJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIGZhbHNlKTtcbiAgICAgICAgfSBlbHNlIGlmIChyZWxhdGlvbi5yZWxhdGlvbnNoaXAgPT09ICcxOjEnKSB7XG4gICAgICAgICAgICB0aGlzLl9idWlsZE9uZVRvQW55UmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbiwgdHJ1ZSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnbjoxJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKHJlbGF0aW9uKTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVEJEJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYnVpbGRNYW55VG9PbmVSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuXG4gICAgICAgIGxldCByaWdodEtleUluZm8gPSByaWdodEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgbGVmdEZpZWxkID0gcmVsYXRpb24ubGVmdEZpZWxkIHx8IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5KTtcblxuICAgICAgICBsZXQgZmllbGRJbmZvID0gdGhpcy5fcmVmaW5lTGVmdEZpZWxkKHJpZ2h0S2V5SW5mbyk7XG4gICAgICAgIGlmIChyZWxhdGlvbi5vcHRpb25hbCkge1xuICAgICAgICAgICAgZmllbGRJbmZvLm9wdGlvbmFsID0gdHJ1ZTtcbiAgICAgICAgfVxuICAgICAgICBsZWZ0RW50aXR5LmFkZEZpZWxkKGxlZnRGaWVsZCwgZmllbGRJbmZvKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb24ubGVmdCwgbGVmdEZpZWxkLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcbiAgICB9XG5cbiAgICBfYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIHVuaXF1ZSkge1xuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5sZWZ0XTtcbiAgICAgICAgbGV0IHJpZ2h0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLnJpZ2h0XTtcblxuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZCA9IHJlbGF0aW9uLmxlZnRGaWVsZCB8fCBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG5cbiAgICAgICAgbGV0IGZpZWxkSW5mbyA9IHRoaXMuX3JlZmluZUxlZnRGaWVsZChyaWdodEtleUluZm8pO1xuICAgICAgICBpZiAocmVsYXRpb24ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGZpZWxkSW5mby5vcHRpb25hbCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgbGVmdEVudGl0eS5hZGRGaWVsZChsZWZ0RmllbGQsIGZpZWxkSW5mbyk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uLmxlZnQsIGxlZnRGaWVsZCwgcmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uLm11bHRpICYmIF8ubGFzdChyZWxhdGlvbi5tdWx0aSkgPT09IHJlbGF0aW9uLnJpZ2h0KSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycsICgpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgaW5kZXggPSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkczogXy5tYXAocmVsYXRpb24ubXVsdGksIHRvID0+IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcodG8sIHNjaGVtYS5lbnRpdGllc1t0b10pKSxcbiAgICAgICAgICAgICAgICAgICAgdW5pcXVlOiB1bmlxdWVcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgbGVmdEVudGl0eS5hZGRJbmRleChpbmRleCk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9idWlsZE5Ub05SZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbi5sZWZ0ICsgVXRpbC5wYXNjYWxDYXNlKHBsdXJhbGl6ZS5wbHVyYWwocmVsYXRpb24ucmlnaHQpKTtcblxuICAgICAgICBpZiAoc2NoZW1hLmhhc0VudGl0eShyZWxhdGlvbkVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICBsZXQgZnVsbE5hbWUgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXS5pZDtcblxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgWyR7cmVsYXRpb25FbnRpdHlOYW1lfV0gY29uZmxpY3RzIHdpdGggZW50aXR5IFske2Z1bGxOYW1lfV0gaW4gc2NoZW1hIFske3NjaGVtYS5uYW1lfV0uYCk7XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYENyZWF0ZSBhIHJlbGF0aW9uIGVudGl0eSBmb3IgXCIke3JlbGF0aW9uLmxlZnR9XCIgYW5kIFwiJHtyZWxhdGlvbi5yaWdodH1cIi5gKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBsZWZ0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLmxlZnRdO1xuICAgICAgICBsZXQgcmlnaHRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ucmlnaHRdO1xuICAgICAgICBcbiAgICAgICAgbGV0IGxlZnRLZXlJbmZvID0gbGVmdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRLZXlJbmZvKSB8fCBBcnJheS5pc0FycmF5KHJpZ2h0S2V5SW5mbykpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignTXVsdGktZmllbGRzIGtleSBub3Qgc3VwcG9ydGVkIGZvciBub24tcmVsYXRpb25zaGlwIGVudGl0eS4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsZWZ0RmllbGQxID0gTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5sZWZ0LCBsZWZ0RW50aXR5KTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZDIgPSBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG4gICAgICAgIFxuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBmaWVsZHM6IHtcbiAgICAgICAgICAgICAgICBbbGVmdEZpZWxkMV06IGxlZnRLZXlJbmZvLFxuICAgICAgICAgICAgICAgIFtsZWZ0RmllbGQyXTogcmlnaHRLZXlJbmZvXG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAga2V5OiBbIGxlZnRGaWVsZDEsIGxlZnRGaWVsZDIgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuICAgICAgICBlbnRpdHkubWFya0FzUmVsYXRpb25zaGlwRW50aXR5KCk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgbGVmdEZpZWxkMSwgcmVsYXRpb24ubGVmdCwgbGVmdEVudGl0eS5rZXkpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBsZWZ0RmllbGQyLCByZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkua2V5KTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5KTtcbiAgICB9XG5cbiAgICBfcmVmaW5lTGVmdEZpZWxkKGZpZWxkSW5mbykge1xuICAgICAgICByZXR1cm4gT2JqZWN0LmFzc2lnbihfLnBpY2soZmllbGRJbmZvLCBPb2xvbmcuQlVJTFRJTl9UWVBFX0FUVFIpLCB7IGlzUmVmZXJlbmNlOiB0cnVlIH0pO1xuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTEubmFtZSwgZW50aXR5Mi5uYW1lIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkxLm5hbWUsIGVudGl0eTEsIF8ub21pdChrZXlFbnRpdHkxLCBbJ29wdGlvbmFsJ10pKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChlbnRpdHkyLm5hbWUsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGVudGl0eTEubmFtZSwgXG4gICAgICAgICAgICBlbnRpdHkxXG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgZW50aXR5Mi5uYW1lLCBcbiAgICAgICAgICAgIGVudGl0eTJcbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxLm5hbWUsIGVudGl0eTEubmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5Mi5uYW1lLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwgJiYgIWluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiAhaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgIH1cbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19