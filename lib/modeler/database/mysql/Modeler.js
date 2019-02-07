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
          let connectedByParts = assoc.connectedBy.split('.');

          if (!(connectedByParts.length <= 2)) {
            throw new Error("Assertion failed: connectedByParts.length <= 2");
          }

          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

          if (!connEntityName) {
            throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
          }

          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
          }

          if (!!this._processedRef.has(tag1)) {
            throw new Error("Assertion failed: !this._processedRef.has(tag1)");
          }

          let connectedByField2 = destEntity.name;

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

          this._processedRef.add(tag1);
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
      if (relationEntityName === 'companyRole') {
        console.dir(relationEntity.info.associations, {
          depth: 10,
          colors: true
        });
        console.log(connectedByField, connectedByField2);
      }

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

        if (relationEntityName === 'companyRole') {
          console.log('OK');
        }

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImZvckVhY2giLCJhc3NvYyIsIl9wcm9jZXNzQXNzb2NpYXRpb24iLCJlbWl0Iiwic3FsRmlsZXNEaXIiLCJqb2luIiwiZGF0YWJhc2UiLCJkYkZpbGVQYXRoIiwiZmtGaWxlUGF0aCIsImluaXRJZHhGaWxlUGF0aCIsImluaXRGaWxlUGF0aCIsInRhYmxlU1FMIiwicmVsYXRpb25TUUwiLCJkYXRhIiwiZW50aXR5TmFtZSIsImFkZEluZGV4ZXMiLCJyZXN1bHQiLCJjb21wbGlhbmNlQ2hlY2siLCJlcnJvcnMiLCJsZW5ndGgiLCJtZXNzYWdlIiwid2FybmluZ3MiLCJFcnJvciIsImZlYXR1cmVzIiwiZm9yT3duIiwiZiIsImZlYXR1cmVOYW1lIiwiQXJyYXkiLCJpc0FycmF5IiwiZmYiLCJfZmVhdHVyZVJlZHVjZXIiLCJfY3JlYXRlVGFibGVTdGF0ZW1lbnQiLCJlbnRpdHlEYXRhIiwicmVjb3JkIiwiaXNQbGFpbk9iamVjdCIsImZpZWxkcyIsImtleXMiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsIkpTT04iLCJzdHJpbmdpZnkiLCJleGlzdHNTeW5jIiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsInR5cGUiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJzcmNGaWVsZCIsImhhcyIsImNvbm5lY3RlZEJ5UGFydHMyIiwiY29ubmVjdGVkQnlGaWVsZDIiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwibG9jYWxGaWVsZE5hbWUiLCJhZGRBc3NvY2lhdGlvbiIsIm9wdGlvbmFsIiwicmVtb3RlRmllbGQiLCJyZWZlcnNUb0ZpZWxkIiwiaXNMaXN0IiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJsb2NhbEZpZWxkIiwiZmllbGRQcm9wcyIsIm9taXQiLCJwaWNrIiwiYWRkQXNzb2NGaWVsZCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJhbmNob3IiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJjb25zb2xlIiwiZGlyIiwiZGVwdGgiLCJjb2xvcnMiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJtYXAiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0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QUFDSDs7QUFFRCxTQUFPcUUscUJBQVAsQ0FBNkIxTixVQUE3QixFQUF5QzJOLGlCQUF6QyxFQUE0RDtBQUN4RCxRQUFJQSxpQkFBSixFQUF1QjtBQUNuQjNOLE1BQUFBLFVBQVUsR0FBR3pELENBQUMsQ0FBQ3FSLElBQUYsQ0FBT3JSLENBQUMsQ0FBQ3NSLFNBQUYsQ0FBWTdOLFVBQVosQ0FBUCxDQUFiO0FBRUEyTixNQUFBQSxpQkFBaUIsR0FBR3BSLENBQUMsQ0FBQ3VSLE9BQUYsQ0FBVXZSLENBQUMsQ0FBQ3NSLFNBQUYsQ0FBWUYsaUJBQVosQ0FBVixFQUEwQyxHQUExQyxJQUFpRCxHQUFyRTs7QUFFQSxVQUFJcFIsQ0FBQyxDQUFDd1IsVUFBRixDQUFhL04sVUFBYixFQUF5QjJOLGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDM04sUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUNtTCxNQUFYLENBQWtCd0MsaUJBQWlCLENBQUN0TixNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPM0QsUUFBUSxDQUFDNkcsWUFBVCxDQUFzQnZELFVBQXRCLENBQVA7QUFDSDs7QUFyb0NjOztBQXdvQ25CZ08sTUFBTSxDQUFDQyxPQUFQLEdBQWlCbFIsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwbHVyYWxpemUgPSByZXF1aXJlKCdwbHVyYWxpemUnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jKSB7XG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIC8vdG9kbzogY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgIGxldCBkZXN0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Rlc3RFbnRpdHlOYW1lXTtcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBjb25uZWN0ZWRCeTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKVswXSB9O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkV2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMuY29ubmVjdGVkV2l0aCA9IGFzc29jLmNvbm5lY3RlZFdpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTo6JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbY29ubkVudGl0eU5hbWVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyLCBhc3NvYy5jb25uZWN0ZWRXaXRoLCBsb2NhbEZpZWxkTmFtZSkgfSA6IHt9KSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGROYW1lID0gYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpOyAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyc1RvRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGRlc3RFbnRpdHksIGNvbm5FbnRpdHksIGVudGl0eSwgY29ubmVjdGVkQnlGaWVsZDIsIGNvbm5lY3RlZEJ5RmllbGQsIGJhY2tSZWYuY29ubmVjdGVkV2l0aCwgcmVtb3RlRmllbGROYW1lKSB9IDoge30pICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gY29ubmVjdGVkQnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHlOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImNvbm5lY3RlZEJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMiwgYXNzb2MuY29ubmVjdGVkV2l0aCwgbG9jYWxGaWVsZE5hbWUpIH0gOiB7fSkgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUHJvcHMgPSB7IC4uLl8ub21pdChkZXN0S2V5RmllbGQsIFsnb3B0aW9uYWwnXSksIC4uLl8ucGljayhhc3NvYywgWydvcHRpb25hbCddKSB9O1xuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCBcbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiBmYWxzZSwgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgbnVsbCwgeyB0eXBlczogWyAncmVmZXJzVG8nLCAnYmVsb25nc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfSk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiB0cnVlLCByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNMaXN0OiBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JywgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBsb2NhbEZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGxvY2FsRmllbGROYW1lLCByZW1vdGVGaWVsZE5hbWUsIG9vbENvbiwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBjb250ZXh0ID0geyBcbiAgICAgICAgICAgIFtjb25uRW50aXR5Lm5hbWVdIDogYW5jaG9yXG4gICAgICAgIH07ICAgICAgICBcblxuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmKSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcblxuICAgICAgICByZXR1cm4gdGhpcztcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmllbGQuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykge1xuICAgICAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5TmFtZSA9PT0gJ2NvbXBhbnlSb2xlJykge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGlyKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCB7ZGVwdGg6IDEwLCBjb2xvcnM6IHRydWV9KTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTEubmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MS5uYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTIubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAocmVsYXRpb25FbnRpdHlOYW1lID09PSAnY29tcGFueVJvbGUnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdPSycpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTEubmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyLm5hbWV9YCk7XG4gICAgICAgIH1cblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEsIF8ub21pdChrZXlFbnRpdHkxLCBbJ29wdGlvbmFsJ10pKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5MiwgXy5vbWl0KGtleUVudGl0eTIsIFsnb3B0aW9uYWwnXSkpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICBlbnRpdHkxXG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgZW50aXR5MlxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEubmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIubmFtZSwga2V5RW50aXR5Mi5uYW1lKTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbE9wVG9TcWwob3ApIHtcbiAgICAgICAgc3dpdGNoIChvcCkge1xuICAgICAgICAgICAgY2FzZSAnPSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuICc9JztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbE9wVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7ICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgIGxldCBsZWZ0LCByaWdodDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAob29sLmxlZnQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wubGVmdCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gb29sLmxlZnQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5yaWdodC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wucmlnaHQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBvb2wucmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgJyAnICsgTXlTUUxNb2RlbGVyLm9vbE9wVG9TcWwob29sLm9wZXJhdG9yKSArICcgJyArIHJpZ2h0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdPYmplY3RSZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgIGlmICghT29sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IE9vbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9XG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVsYXRpb24ucmlnaHQgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9ICcnO1xuXG4gICAgICAgIGlmICh0aGlzLl9yZWxhdGlvbkVudGl0aWVzW2VudGl0eU5hbWVdKSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBDQVNDQURFIE9OIFVQREFURSBDQVNDQURFJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIE5PIEFDVElPTiBPTiBVUERBVEUgTk8gQUNUSU9OJztcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==