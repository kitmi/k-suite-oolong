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
        if (entity.name === 'case') {
          console.log(entity.info.associations);
        }

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

  _translateJoinCondition(context, localField, remoteField) {
    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._translateJoinCondition(context, localField, rf));
    }

    if (_.isPlainObject(remoteField)) {
      let ret = {
        [localField]: remoteField.by
      };

      let withExtra = this._oolConditionToQueryCondition(context, remoteField.with);

      if (localField in withExtra) {
        return {
          $and: [ret, withExtra]
        };
      }

      return { ...ret,
        ...withExtra
      };
    }

    return {
      [localField]: remoteField
    };
  }

  _getAllRelatedFields(remoteField) {
    if (!remoteField) return undefined;

    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._getAllRelatedFields(rf));
    }

    if (_.isPlainObject(remoteField)) {
      return remoteField.by;
    }

    return remoteField;
  }

  _processAssociation(schema, entity, assoc) {
    let entityKeyField = entity.getKeyField();

    if (!!Array.isArray(entityKeyField)) {
      throw new Error("Assertion failed: !Array.isArray(entityKeyField)");
    }

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
        } else {
          let remoteFields = this._getAllRelatedFields(assoc.remoteField);

          includes = {
            srcField: remoteField => {
              remoteField || (remoteField = entity.name);
              return _.isNil(remoteFields) || (Array.isArray(remoteFields) ? remoteFields.indexOf(remoteField) > -1 : remoteFields === remoteField);
            }
          };
        }

        let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);

        if (backRef) {
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            if (!assoc.connectedBy) {
              throw new Error('"m2n" association requires "connectedBy" property. Entity: ' + entity.name + ' destination: ' + destEntityName);
            }

            let connectedByParts = assoc.connectedBy.split('.');

            if (!(connectedByParts.length <= 2)) {
              throw new Error("Assertion failed: connectedByParts.length <= 2");
            }

            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

            if (!connEntityName) {
              throw new Error("Assertion failed: connEntityName");
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}:${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

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
            entity.addAssociation(localFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({
                [connEntityName]: localFieldName
              }, entityKeyField, assoc.connectedWith ? {
                by: connectedByField,
                with: assoc.connectedWith
              } : connectedByField),
              ...(assoc.optional ? {
                optional: assoc.optional
              } : {}),
              ...(assoc.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField2
            });
            let remoteFieldName = backRef.srcField || pluralize(entity.name);
            destEntity.addAssociation(remoteFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({
                [connEntityName]: remoteFieldName
              }, destEntity.key, backRef.connectedWith ? {
                by: connectedByField2,
                with: backRef.connectedWith
              } : connectedByField),
              ...(backRef.optional ? {
                optional: backRef.optional
              } : {}),
              ...(backRef.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField
            });

            this._processedRef.add(tag1);

            this._processedRef.add(tag2);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.connectedBy) {
              throw new Error('todo: belongsTo connectedBy. entity: ' + entity.name);
            } else {
              let anchor = assoc.srcField || (assoc.type === 'hasMany' ? pluralize(destEntityName) : destEntityName);
              entity.addAssociation(anchor, {
                entity: destEntityName,
                key: destEntity.key,
                on: {
                  [entity.key]: assoc.remoteField || entity.name
                },
                ...(assoc.optional ? {
                  optional: assoc.optional
                } : {}),
                ...(assoc.type === 'hasMany' ? {
                  list: true
                } : {})
              });
            }
          } else {
            throw new Error('Unexpected path. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));
          }
        } else {
          let connectedByParts = assoc.connectedBy ? assoc.connectedBy.split('.') : [OolUtils.prefixNaming(entity.name, destEntityName)];

          if (!(connectedByParts.length <= 2)) {
            throw new Error("Assertion failed: connectedByParts.length <= 2");
          }

          let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
          let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

          if (!connEntityName) {
            throw new Error("Assertion failed: connEntityName");
          }

          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
          }

          if (!!this._processedRef.has(tag1)) {
            throw new Error("Assertion failed: !this._processedRef.has(tag1)");
          }

          let connectedByField2 = destEntityName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "connectedBy" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              connectedBy: connectedByField
            }));
          }

          let connEntity = schema.entities[connEntityName];

          if (!connEntity) {
            connEntity = this._addRelationEntity(schema, connEntityName, connectedByField, connectedByField2);
          }

          this._updateRelationEntity(connEntity, entity, destEntity, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityName);
          entity.addAssociation(localFieldName, {
            entity: connEntityName,
            key: connEntity.key,
            on: this._translateJoinCondition({
              [connEntityName]: localFieldName
            }, entityKeyField, assoc.connectedWith ? {
              by: connectedByField,
              with: assoc.connectedWith
            } : connectedByField),
            ...(assoc.optional ? {
              optional: assoc.optional
            } : {}),
            ...(assoc.type === 'hasMany' ? {
              list: true
            } : {}),
            assoc: connectedByField2
          });

          this._processedRef.add(tag1);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityName;
        let fieldProps = { ..._.omit(destKeyField, ['optional', 'default']),
          ..._.pick(assoc, ['optional', 'default'])
        };
        entity.addAssocField(localField, destEntity, fieldProps);
        entity.addAssociation(localField, {
          entity: destEntityName,
          key: destEntity.key,
          on: {
            [localField]: destEntity.key
          }
        });

        if (assoc.type === 'belongsTo') {
          let backRef = destEntity.getReferenceTo(entity.name, {
            'remoteField': remoteField => {
              let remoteFields = this._getAllRelatedFields(remoteField);

              return _.isNil(remoteFields) || (Array.isArray(remoteFields) ? remoteFields.indexOf(localField) > -1 : remoteFields === localField);
            }
          }, {
            types: ['refersTo', 'belongsTo'],
            association: assoc
          });

          if (!backRef) {
            destEntity.addAssociation(pluralize(entity.name), {
              entity: entity.name,
              key: entity.key,
              on: {
                [destEntity.key]: localField
              },
              list: true,
              optional: true
            });
          }
        }

        this._addReference(entity.name, localField, destEntityName, destKeyField.name);

        break;
    }
  }

  _oolConditionToQueryCondition(context, oolCon) {
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

    throw new Error('Unknown syntax: ' + JSON.stringify(oolCon));
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
    if (Array.isArray(leftField)) {
      leftField.forEach(lf => this._addReference(left, lf, right, rightField));
      return;
    }

    if (_.isPlainObject(leftField)) {
      this._addReference(left, leftField.by, right.rightField);

      return;
    }

    if (!(typeof leftField === 'string')) {
      throw new Error("Assertion failed: typeof leftField === 'string'");
    }

    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      refs4LeftEntity = [];
      this._references[left] = refs4LeftEntity;
    } else {
      let found = _.find(refs4LeftEntity, item => item.leftField === leftField && item.right === right && item.rightField === rightField);

      if (found) return;
    }

    refs4LeftEntity.push({
      leftField,
      right,
      rightField
    });
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
    relationEntity.addAssociation(connectedByField, {
      entity: entity1.name
    });
    relationEntity.addAssociation(connectedByField2, {
      entity: entity2.name
    });

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImNvbnNvbGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwiZW50aXR5S2V5RmllbGQiLCJnZXRLZXlGaWVsZCIsImRlc3RFbnRpdHlOYW1lIiwiZGVzdEVudGl0eSIsImRlc3RLZXlGaWVsZCIsInR5cGUiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJyZW1vdGVGaWVsZHMiLCJzcmNGaWVsZCIsImlzTmlsIiwiaW5kZXhPZiIsImJhY2tSZWYiLCJnZXRSZWZlcmVuY2VUbyIsImNvbm5lY3RlZEJ5UGFydHMiLCJjb25uZWN0ZWRCeUZpZWxkIiwiY29ubkVudGl0eU5hbWUiLCJlbnRpdHlOYW1pbmciLCJ0YWcxIiwidGFnMiIsImhhcyIsImNvbm5lY3RlZEJ5UGFydHMyIiwiY29ubmVjdGVkQnlGaWVsZDIiLCJjb25uRW50aXR5IiwiX2FkZFJlbGF0aW9uRW50aXR5IiwiX3VwZGF0ZVJlbGF0aW9uRW50aXR5IiwibG9jYWxGaWVsZE5hbWUiLCJhZGRBc3NvY2lhdGlvbiIsIm9uIiwib3B0aW9uYWwiLCJsaXN0IiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwiYW5jaG9yIiwicHJlZml4TmFtaW5nIiwic3JjIiwiZGVzdCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwibGYiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJzdGFydEluZGV4IiwiayIsInN1YkRvY3VtZW50cyIsImZpZWxkTmFtZSIsInN1YkNvbExpc3QiLCJzdWJBbGlhcyIsInN1YkpvaW5zIiwic3RhcnRJbmRleDIiLCJjb25jYXQiLCJsaW5rV2l0aEZpZWxkIiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleGVzIiwiaW5kZXgiLCJ1bmlxdWUiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlZHVjZSIsInJlbGF0aW9uIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJ2IiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwiaGFzT3duUHJvcGVydHkiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxZQUFZLEdBQUdDLE9BQU8sQ0FBQyxRQUFELENBQTVCOztBQUNBLE1BQU1DLFNBQVMsR0FBR0QsT0FBTyxDQUFDLFdBQUQsQ0FBekI7O0FBQ0EsTUFBTUUsSUFBSSxHQUFHRixPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFDQSxNQUFNRyxJQUFJLEdBQUdILE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFFQSxNQUFNSSxJQUFJLEdBQUdKLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUssRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBO0FBQVQsSUFBbUJILElBQXpCOztBQUVBLE1BQU1JLFFBQVEsR0FBR1IsT0FBTyxDQUFDLHdCQUFELENBQXhCOztBQUNBLE1BQU1TLE1BQU0sR0FBR1QsT0FBTyxDQUFDLHNCQUFELENBQXRCOztBQUNBLE1BQU1VLEtBQUssR0FBR1YsT0FBTyxDQUFDLHdCQUFELENBQXJCOztBQUVBLE1BQU1XLHlCQUF5QixHQUFHLElBQUlDLEdBQUosQ0FBUSxDQUFDLE1BQUQsRUFBUyxNQUFULEVBQWlCLE1BQWpCLEVBQXlCLFVBQXpCLENBQVIsQ0FBbEM7O0FBdUNBLE1BQU1DLFlBQU4sQ0FBbUI7QUFVZkMsRUFBQUEsV0FBVyxDQUFDQyxPQUFELEVBQVVDLFNBQVYsRUFBcUJDLFNBQXJCLEVBQWdDO0FBQ3ZDLFNBQUtDLE1BQUwsR0FBY0gsT0FBTyxDQUFDRyxNQUF0QjtBQUNBLFNBQUtDLE1BQUwsR0FBY0osT0FBTyxDQUFDSSxNQUF0QjtB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ID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwbHVyYWxpemUgPSByZXF1aXJlKCdwbHVyYWxpemUnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGlmIChlbnRpdHkubmFtZSA9PT0gJ2Nhc2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiByZW1vdGVGaWVsZC5ieSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiByZW1vdGVGaWVsZCB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtjb25uZWN0ZWRCeV0gW2Nvbm5lY3RlZFdpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGVudGl0eUtleUZpZWxkID0gZW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoZW50aXR5S2V5RmllbGQpO1xuXG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIC8vdG9kbzogY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgIGxldCBkZXN0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Rlc3RFbnRpdHlOYW1lXTtcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHR5cGVzOiBbICdyZWZlcnNUbycgXSwgXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKVswXSBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkV2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMuY29ubmVjdGVkV2l0aCA9IGFzc29jLmNvbm5lY3RlZFdpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKGFzc29jLnJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogcmVtb3RlRmllbGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmlzTmlsKHJlbW90ZUZpZWxkcykgfHwgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGRzKSA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSByZW1vdGVGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJjb25uZWN0ZWRCeVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcgZGVzdGluYXRpb246ICcgKyBkZXN0RW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGVkIGJ5IGZpZWxkIGlzIHVzdWFsbHkgYSByZWZlcnNUbyBhc3NvY1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lOyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuY29ubmVjdGVkQnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5Lm5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImNvbm5lY3RlZEJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5S2V5RmllbGQsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuY29ubmVjdGVkV2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IFtjb25uRW50aXR5TmFtZV06IHJlbW90ZUZpZWxkTmFtZSB9LCBkZXN0RW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLmNvbm5lY3RlZFdpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYuY29ubmVjdGVkV2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLm9wdGlvbmFsID8geyBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gY29ubmVjdGVkQnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhbmNob3IgPSBhc3NvYy5zcmNGaWVsZCB8fCAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKSA6IGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbZW50aXR5LmtleV06IGFzc29jLnJlbW90ZUZpZWxkIHx8IGVudGl0eS5uYW1lIH0sICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeSA/IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gZGVzdEVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5S2V5RmllbGQsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5jb25uZWN0ZWRXaXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgIGxldCBmaWVsZFByb3BzID0geyAuLi5fLm9taXQoZGVzdEtleUZpZWxkLCBbJ29wdGlvbmFsJywgJ2RlZmF1bHQnXSksIC4uLl8ucGljayhhc3NvYywgWydvcHRpb25hbCcsICdkZWZhdWx0J10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgb246IHsgW2xvY2FsRmllbGRdOiAgZGVzdEVudGl0eS5rZXkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICdyZW1vdGVGaWVsZCc6IChyZW1vdGVGaWVsZCkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YobG9jYWxGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gbG9jYWxGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfSwgIC8vIGluY2x1ZGVzXG4gICAgICAgICAgICAgICAgICAgICAgICB7IHR5cGVzOiBbICdyZWZlcnNUbycsICdiZWxvbmdzVG8nIF0sIGFzc29jaWF0aW9uOiBhc3NvYyB9IC8vIGV4Y2x1ZGVzXG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdXJhbGl6ZShlbnRpdHkubmFtZSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBlbnRpdHkubmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHsgW2Rlc3RFbnRpdHkua2V5XTogbG9jYWxGaWVsZCB9LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsaXN0OiB0cnVlLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IHRydWVcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHN5bnRheDogJyArIEpTT04uc3RyaW5naWZ5KG9vbENvbikpO1xuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmKSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgbGVmdEZpZWxkID09PSAnc3RyaW5nJztcblxuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZpZWxkLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTEubmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MS5uYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTIubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTEubmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTIubmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MS5uYW1lLCBrZXlFbnRpdHkxLm5hbWUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Mi5uYW1lLCBrZXlFbnRpdHkyLm5hbWUpO1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH1cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWxhdGlvbi5yaWdodCArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19