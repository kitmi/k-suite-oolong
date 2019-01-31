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
        let backRef = destEntity.getReferenceTo(entity.name, {
          type: 'refersTo',
          association: assoc
        });

        if (backRef) {
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            let connEntityName = OolUtils.entityNaming(assoc.connectedBy);

            if (!connEntityName) {
              throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}::${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

            if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
              return;
            }

            entity.addAssociation(assoc.srcField || pluralize(destEntityName), destEntity, {
              optional: assoc.optional,
              connectedBy: connEntityName,
              ...(assoc.type === 'hasMany' ? {
                isList: true
              } : {})
            });
            destEntity.addAssociation(backRef.srcField || pluralize(entity.name), entity, {
              optional: backRef.optional,
              connectedBy: connEntityName,
              ...(backRef.type === 'hasMany' ? {
                isList: true
              } : {})
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
            throw new Error('Unexpected path');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsIk9vbFV0aWxzIiwiRW50aXR5IiwiVHlwZXMiLCJVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFIiwiU2V0IiwiTXlTUUxNb2RlbGVyIiwiY29uc3RydWN0b3IiLCJjb250ZXh0IiwiY29ubmVjdG9yIiwiZGJPcHRpb25zIiwibG9nZ2VyIiwibGlua2VyIiwib3V0cHV0UGF0aCIsInNjcmlwdE91dHB1dFBhdGgiLCJfZXZlbnRzIiwiX2RiT3B0aW9ucyIsImRiIiwibWFwS2V5cyIsInZhbHVlIiwia2V5IiwidXBwZXJDYXNlIiwidGFibGUiLCJfcmVmZXJlbmNlcyIsIl9yZWxhdGlvbkVudGl0aWVzIiwiX3Byb2Nlc3NlZFJlZiIsIm1vZGVsaW5nIiwic2NoZW1hIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJleGlzdGluZ0VudGl0aWVzIiwiT2JqZWN0IiwidmFsdWVzIiwiZW50aXRpZXMiLCJlYWNoIiwiZW50aXR5IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiYXNzb2NpYXRpb24iLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsImNvbm5lY3RlZEJ5IiwidGFnMSIsInRhZzIiLCJoYXMiLCJhZGRBc3NvY2lhdGlvbiIsInNyY0ZpZWxkIiwib3B0aW9uYWwiLCJpc0xpc3QiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwiYWRkIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJ0eXBlcyIsInJlbW90ZUZpZWxkIiwiX2FkZFJlZmVyZW5jZSIsImxlZnQiLCJsZWZ0RmllbGQiLCJyaWdodCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJfYnVpbGRSZWxhdGlvbiIsInJlbGF0aW9uIiwicmVsYXRpb25zaGlwIiwiX2J1aWxkTlRvTlJlbGF0aW9uIiwiX2J1aWxkT25lVG9BbnlSZWxhdGlvbiIsIl9idWlsZE1hbnlUb09uZVJlbGF0aW9uIiwiY29uc29sZSIsImxlZnRFbnRpdHkiLCJyaWdodEVudGl0eSIsInJpZ2h0S2V5SW5mbyIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImZpZWxkSW5mbyIsIl9yZWZpbmVMZWZ0RmllbGQiLCJhZGRGaWVsZCIsInVuaXF1ZSIsIm11bHRpIiwibGFzdCIsImluZGV4IiwibWFwIiwidG8iLCJhZGRJbmRleCIsInJlbGF0aW9uRW50aXR5TmFtZSIsInBhc2NhbENhc2UiLCJwbHVyYWwiLCJoYXNFbnRpdHkiLCJmdWxsTmFtZSIsImlkIiwibGVmdEtleUluZm8iLCJsZWZ0RmllbGQxIiwibGVmdEZpZWxkMiIsImVudGl0eUluZm8iLCJsaW5rIiwibWFya0FzUmVsYXRpb25zaGlwRW50aXR5IiwiYWRkRW50aXR5IiwiT29sb25nIiwiQlVJTFRJTl9UWVBFX0FUVFIiLCJpc1JlZmVyZW5jZSIsImZpbGVQYXRoIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsImVudGl0eTEiLCJlbnRpdHkyIiwicmVsYXRpb25FbnRpdHkiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwib29sVHlwZSIsIm9wZXJhdG9yIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlZHVjZSIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJ2IiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIs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QUFjLFFBQXhFLEVBQWtGO0FBQzlFa0gsVUFBQUEsR0FBRyxJQUFJLFlBQVA7QUFDSCxTQUZELE1BRU87QUFDSEEsVUFBQUEsR0FBRyxJQUFJLGFBQVA7QUFDSDs7QUFFRDNLLFFBQUFBLElBQUksQ0FBQ3NPLFVBQUwsR0FBa0IsSUFBbEI7QUFDSDtBQUNKOztBQTRERCxXQUFPM0QsR0FBUDtBQUNIOztBQUVELFNBQU8rRCxxQkFBUCxDQUE2QjFOLFVBQTdCLEVBQXlDMk4saUJBQXpDLEVBQTREO0FBQ3hELFFBQUlBLGlCQUFKLEVBQXVCO0FBQ25CM04sTUFBQUEsVUFBVSxHQUFHeEQsQ0FBQyxDQUFDb1IsSUFBRixDQUFPcFIsQ0FBQyxDQUFDcVIsU0FBRixDQUFZN04sVUFBWixDQUFQLENBQWI7QUFFQTJOLE1BQUFBLGlCQUFpQixHQUFHblIsQ0FBQyxDQUFDc1IsT0FBRixDQUFVdFIsQ0FBQyxDQUFDcVIsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUluUixDQUFDLENBQUN1UixVQUFGLENBQWEvTixVQUFiLEVBQXlCMk4saUJBQXpCLENBQUosRUFBaUQ7QUFDN0MzTixRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ3NMLE1BQVgsQ0FBa0JxQyxpQkFBaUIsQ0FBQ3ROLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU8zRCxRQUFRLENBQUNvRyxZQUFULENBQXNCOUMsVUFBdEIsQ0FBUDtBQUNIOztBQWhsQ2M7O0FBbWxDbkJnTyxNQUFNLENBQUNDLE9BQVAsR0FBaUJsUixZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBsdXJhbGl6ZSA9IHJlcXVpcmUoJ3BsdXJhbGl6ZScpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcyB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYykge1xuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBhc3NvY2lhdGlvbjogYXNzb2MgfSk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhhc3NvYy5jb25uZWN0ZWRCeSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTo6JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsLCBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsLCBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSkgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHksIGRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGNvbm5lY3RlZEJ5Jyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsIFxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IGZhbHNlLCBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGVzOiBbICdyZWZlcnNUbycsICdiZWxvbmdzVG8nIF0sIGFzc29jaWF0aW9uOiBhc3NvYyB9KTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdXJhbGl6ZShlbnRpdHkubmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IHRydWUsIHJlbW90ZUZpZWxkOiBsb2NhbEZpZWxkIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0xpc3Q6IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZpZWxkLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9idWlsZFJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24pIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdBbmFseXppbmcgcmVsYXRpb24gYmV0d2VlbiBbJ1xuICAgICAgICArIHJlbGF0aW9uLmxlZnQgKyAnXSBhbmQgWydcbiAgICAgICAgKyByZWxhdGlvbi5yaWdodCArICddIHJlbGF0aW9uc2hpcDogJ1xuICAgICAgICArIHJlbGF0aW9uLnJlbGF0aW9uc2hpcCArICcgLi4uJyk7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uLnJlbGF0aW9uc2hpcCA9PT0gJ246bicpIHtcbiAgICAgICAgICAgIHRoaXMuX2J1aWxkTlRvTlJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24pO1xuICAgICAgICB9IGVsc2UgaWYgKHJlbGF0aW9uLnJlbGF0aW9uc2hpcCA9PT0gJzE6bicpIHtcbiAgICAgICAgICAgIHRoaXMuX2J1aWxkT25lVG9BbnlSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uLCBmYWxzZSk7XG4gICAgICAgIH0gZWxzZSBpZiAocmVsYXRpb24ucmVsYXRpb25zaGlwID09PSAnMToxJykge1xuICAgICAgICAgICAgdGhpcy5fYnVpbGRPbmVUb0FueVJlbGF0aW9uKHNjaGVtYSwgcmVsYXRpb24sIHRydWUpO1xuICAgICAgICB9IGVsc2UgaWYgKHJlbGF0aW9uLnJlbGF0aW9uc2hpcCA9PT0gJ246MScpIHtcbiAgICAgICAgICAgIHRoaXMuX2J1aWxkTWFueVRvT25lUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbik7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhyZWxhdGlvbik7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RCRCcpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX2J1aWxkTWFueVRvT25lUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5sZWZ0XTtcbiAgICAgICAgbGV0IHJpZ2h0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLnJpZ2h0XTtcblxuICAgICAgICBsZXQgcmlnaHRLZXlJbmZvID0gcmlnaHRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgbGV0IGxlZnRGaWVsZCA9IHJlbGF0aW9uLmxlZnRGaWVsZCB8fCBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eSk7XG5cbiAgICAgICAgbGV0IGZpZWxkSW5mbyA9IHRoaXMuX3JlZmluZUxlZnRGaWVsZChyaWdodEtleUluZm8pO1xuICAgICAgICBpZiAocmVsYXRpb24ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIGZpZWxkSW5mby5vcHRpb25hbCA9IHRydWU7XG4gICAgICAgIH1cbiAgICAgICAgbGVmdEVudGl0eS5hZGRGaWVsZChsZWZ0RmllbGQsIGZpZWxkSW5mbyk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uLmxlZnQsIGxlZnRGaWVsZCwgcmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5LmtleSk7XG4gICAgfVxuXG4gICAgX2J1aWxkT25lVG9BbnlSZWxhdGlvbihzY2hlbWEsIHJlbGF0aW9uLCB1bmlxdWUpIHtcbiAgICAgICAgbGV0IGxlZnRFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbcmVsYXRpb24ubGVmdF07XG4gICAgICAgIGxldCByaWdodEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5yaWdodF07XG5cbiAgICAgICAgbGV0IHJpZ2h0S2V5SW5mbyA9IHJpZ2h0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGxldCBsZWZ0RmllbGQgPSByZWxhdGlvbi5sZWZ0RmllbGQgfHwgTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkpO1xuXG4gICAgICAgIGxldCBmaWVsZEluZm8gPSB0aGlzLl9yZWZpbmVMZWZ0RmllbGQocmlnaHRLZXlJbmZvKTtcbiAgICAgICAgaWYgKHJlbGF0aW9uLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICBmaWVsZEluZm8ub3B0aW9uYWwgPSB0cnVlO1xuICAgICAgICB9XG4gICAgICAgIGxlZnRFbnRpdHkuYWRkRmllbGQobGVmdEZpZWxkLCBmaWVsZEluZm8pO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbi5sZWZ0LCBsZWZ0RmllbGQsIHJlbGF0aW9uLnJpZ2h0LCByaWdodEVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbi5tdWx0aSAmJiBfLmxhc3QocmVsYXRpb24ubXVsdGkpID09PSByZWxhdGlvbi5yaWdodCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnLCAoKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IGluZGV4ID0ge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZHM6IF8ubWFwKHJlbGF0aW9uLm11bHRpLCB0byA9PiBNeVNRTE1vZGVsZXIuZm9yZWlnbktleUZpZWxkTmFtaW5nKHRvLCBzY2hlbWEuZW50aXRpZXNbdG9dKSksXG4gICAgICAgICAgICAgICAgICAgIHVuaXF1ZTogdW5pcXVlXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGxlZnRFbnRpdHkuYWRkSW5kZXgoaW5kZXgpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfYnVpbGROVG9OUmVsYXRpb24oc2NoZW1hLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb24ubGVmdCArIFV0aWwucGFzY2FsQ2FzZShwbHVyYWxpemUucGx1cmFsKHJlbGF0aW9uLnJpZ2h0KSk7XG5cbiAgICAgICAgaWYgKHNjaGVtYS5oYXNFbnRpdHkocmVsYXRpb25FbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgbGV0IGZ1bGxOYW1lID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0uaWQ7XG5cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFske3JlbGF0aW9uRW50aXR5TmFtZX1dIGNvbmZsaWN0cyB3aXRoIGVudGl0eSBbJHtmdWxsTmFtZX1dIGluIHNjaGVtYSBbJHtzY2hlbWEubmFtZX1dLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBDcmVhdGUgYSByZWxhdGlvbiBlbnRpdHkgZm9yIFwiJHtyZWxhdGlvbi5sZWZ0fVwiIGFuZCBcIiR7cmVsYXRpb24ucmlnaHR9XCIuYCk7XG4gICAgICAgIFxuICAgICAgICBsZXQgbGVmdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tyZWxhdGlvbi5sZWZ0XTtcbiAgICAgICAgbGV0IHJpZ2h0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW3JlbGF0aW9uLnJpZ2h0XTtcbiAgICAgICAgXG4gICAgICAgIGxldCBsZWZ0S2V5SW5mbyA9IGxlZnRFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgbGV0IHJpZ2h0S2V5SW5mbyA9IHJpZ2h0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIFxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0S2V5SW5mbykgfHwgQXJyYXkuaXNBcnJheShyaWdodEtleUluZm8pKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ011bHRpLWZpZWxkcyBrZXkgbm90IHN1cHBvcnRlZCBmb3Igbm9uLXJlbGF0aW9uc2hpcCBlbnRpdHkuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGVmdEZpZWxkMSA9IE15U1FMTW9kZWxlci5mb3JlaWduS2V5RmllbGROYW1pbmcocmVsYXRpb24ubGVmdCwgbGVmdEVudGl0eSk7XG4gICAgICAgIGxldCBsZWZ0RmllbGQyID0gTXlTUUxNb2RlbGVyLmZvcmVpZ25LZXlGaWVsZE5hbWluZyhyZWxhdGlvbi5yaWdodCwgcmlnaHRFbnRpdHkpO1xuICAgICAgICBcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAgZmllbGRzOiB7XG4gICAgICAgICAgICAgICAgW2xlZnRGaWVsZDFdOiBsZWZ0S2V5SW5mbyxcbiAgICAgICAgICAgICAgICBbbGVmdEZpZWxkMl06IHJpZ2h0S2V5SW5mb1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGtleTogWyBsZWZ0RmllbGQxLCBsZWZ0RmllbGQyIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcbiAgICAgICAgZW50aXR5Lm1hcmtBc1JlbGF0aW9uc2hpcEVudGl0eSgpO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGxlZnRGaWVsZDEsIHJlbGF0aW9uLmxlZnQsIGxlZnRFbnRpdHkua2V5KTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgbGVmdEZpZWxkMiwgcmVsYXRpb24ucmlnaHQsIHJpZ2h0RW50aXR5LmtleSk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShyZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eSk7XG4gICAgfVxuXG4gICAgX3JlZmluZUxlZnRGaWVsZChmaWVsZEluZm8pIHtcbiAgICAgICAgcmV0dXJuIE9iamVjdC5hc3NpZ24oXy5waWNrKGZpZWxkSW5mbywgT29sb25nLkJVSUxUSU5fVFlQRV9BVFRSKSwgeyBpc1JlZmVyZW5jZTogdHJ1ZSB9KTtcbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxLCBlbnRpdHkyKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxLm5hbWUsIGVudGl0eTIubmFtZSBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MS5uYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTIubmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoZW50aXR5MS5uYW1lLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoZW50aXR5Mi5uYW1lLCBlbnRpdHkyLCBfLm9taXQoa2V5RW50aXR5MiwgWydvcHRpb25hbCddKSk7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBlbnRpdHkxLm5hbWUsIFxuICAgICAgICAgICAgZW50aXR5MVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGVudGl0eTIubmFtZSwgXG4gICAgICAgICAgICBlbnRpdHkyXG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MS5uYW1lLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTIubmFtZSwgZW50aXR5Mi5uYW1lLCBrZXlFbnRpdHkyLm5hbWUpO1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH1cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWxhdGlvbi5yaWdodCArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==