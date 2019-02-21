"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const path = require('path');

const ntol = require('number-to-letter');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote
} = Util;

const OolUtils = require('../../../lang/OolUtils');

const {
  pluralize
} = OolUtils;

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
        let assocs = this._preProcessAssociations(entity);

        let assocNames = assocs.reduce((result, v) => {
          result[v] = v;
          return result;
        }, {});
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc, assocNames));
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

  _toColumnReference(name) {
    return {
      oorType: 'ColumnReference',
      name
    };
  }

  _translateJoinCondition(context, localField, anchor, remoteField) {
    if (Array.isArray(remoteField)) {
      return remoteField.map(rf => this._translateJoinCondition(context, localField, anchor, rf));
    }

    if (_.isPlainObject(remoteField)) {
      let ret = {
        [localField]: this._toColumnReference(anchor + '.' + remoteField.by)
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
      [localField]: this._toColumnReference(anchor + '.' + remoteField)
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

  _preProcessAssociations(entity) {
    return entity.info.associations.map(assoc => {
      if (assoc.srcField) return assoc.srcField;

      if (assoc.type === 'hasMany') {
        return pluralize(assoc.destEntity);
      }

      return assoc.destEntity;
    });
  }

  _processAssociation(schema, entity, assoc, assocNames) {
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
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: localFieldName
              }, entity.key, localFieldName, assoc.connectedWith ? {
                by: connectedByField,
                with: assoc.connectedWith
              } : connectedByField),
              field: connectedByField,
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
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: remoteFieldName
              }, destEntity.key, remoteFieldName, backRef.connectedWith ? {
                by: connectedByField2,
                with: backRef.connectedWith
              } : connectedByField),
              field: connectedByField2,
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
              let remoteField = backRef.srcField || entity.name;
              entity.addAssociation(anchor, {
                entity: destEntityName,
                key: destEntity.key,
                on: this._translateJoinCondition({ ...assocNames,
                  [destEntityName]: anchor
                }, entity.key, anchor, remoteField),
                ...(typeof remoteField === 'string' ? {
                  field: remoteField
                } : {}),
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
            on: this._translateJoinCondition({ ...assocNames,
              [connEntityName]: localFieldName
            }, entity.key, localFieldName, assoc.connectedWith ? {
              by: connectedByField,
              with: assoc.connectedWith
            } : connectedByField),
            field: connectedByField,
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
            [localField]: this._toColumnReference(localField + '.' + destEntity.key)
          }
        });

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
          left = this._translateReference(context, left.name, true);
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

  _translateReference(context, ref, asKey) {
    let [base, ...other] = ref.split('.');
    let translated = context[base];

    if (!translated) {
      console.log(context);
      throw new Error(`Referenced object "${ref}" not found in context.`);
    }

    let refName = [translated, ...other].join('.');

    if (asKey) {
      return refName;
    }

    return this._toColumnReference(refName);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwib3B0aW9uYWwiLCJsaXN0IiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwicHJlZml4TmFtaW5nIiwic3JjIiwiZGVzdCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsImhhc093blByb3BlcnR5IiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHUCxPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFUSxFQUFBQTtBQUFGLElBQWdCRCxRQUF0Qjs7QUFDQSxNQUFNRSxNQUFNLEdBQUdULE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7QUFDQSxNQUFNVSxLQUFLLEdBQUdWLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFFQSxNQUFNVyx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQXVDQSxNQUFNQyxZQUFOLENBQW1CO0FBVWZDLEVBQUFBLFdBQVcsQ0FBQ0MsT0FBRCxFQUFVQyxTQUFWLEVBQXFC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bEI7QUFDSDtBQUNKOztBQTRERCxXQUFPOUQsR0FBUDtBQUNIOztBQUVELFNBQU9rRSxxQkFBUCxDQUE2QnZPLFVBQTdCLEVBQXlDd08saUJBQXpDLEVBQTREO0FBQ3hELFFBQUlBLGlCQUFKLEVBQXVCO0FBQ25CeE8sTUFBQUEsVUFBVSxHQUFHaEUsQ0FBQyxDQUFDeVMsSUFBRixDQUFPelMsQ0FBQyxDQUFDMFMsU0FBRixDQUFZMU8sVUFBWixDQUFQLENBQWI7QUFFQXdPLE1BQUFBLGlCQUFpQixHQUFHeFMsQ0FBQyxDQUFDMlMsT0FBRixDQUFVM1MsQ0FBQyxDQUFDMFMsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUl4UyxDQUFDLENBQUM0UyxVQUFGLENBQWE1TyxVQUFiLEVBQXlCd08saUJBQXpCLENBQUosRUFBaUQ7QUFDN0N4TyxRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ2tNLE1BQVgsQ0FBa0JzQyxpQkFBaUIsQ0FBQ3BPLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU9qRSxRQUFRLENBQUN3SSxZQUFULENBQXNCM0UsVUFBdEIsQ0FBUDtBQUNIOztBQXp4Q2M7O0FBNHhDbkI2TyxNQUFNLENBQUNDLE9BQVAsR0FBaUJyUyxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2Nvbm5lY3RlZEJ5XSBbY29ubmVjdGVkV2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRXaXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy5jb25uZWN0ZWRXaXRoID0gYXNzb2MuY29ubmVjdGVkV2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImNvbm5lY3RlZEJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbY29ubkVudGl0eU5hbWVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuY29ubmVjdGVkV2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IHJlbW90ZUZpZWxkTmFtZSB9LCBkZXN0RW50aXR5LmtleSwgcmVtb3RlRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5jb25uZWN0ZWRXaXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBiYWNrUmVmLmNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYub3B0aW9uYWwgPyB7IG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpIDogZGVzdEVudGl0eU5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeSA/IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gZGVzdEVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmNvbm5lY3RlZFdpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLmNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2Mub3B0aW9uYWwgPyB7IG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUHJvcHMgPSB7IC4uLl8ub21pdChkZXN0S2V5RmllbGQsIFsnb3B0aW9uYWwnLCAnZGVmYXVsdCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJywgJ2RlZmF1bHQnXSkgfTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RW50aXR5LmtleSkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3JlbW90ZUZpZWxkJzogKHJlbW90ZUZpZWxkKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihsb2NhbEZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSBsb2NhbEZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9LCAgLy8gaW5jbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgdHlwZXM6IFsgJ3JlZmVyc1RvJywgJ2JlbG9uZ3NUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH0gLy8gZXhjbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGVudGl0eS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBlbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbZGVzdEVudGl0eS5rZXldOiBsb2NhbEZpZWxkIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Q6IHRydWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICBsZWZ0RmllbGQuZm9yRWFjaChsZiA9PiB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGYsIHJpZ2h0LCByaWdodEZpZWxkKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmaWVsZC5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MS5uYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTIubmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwgXy5vbWl0KGtleUVudGl0eTEsIFsnb3B0aW9uYWwnXSkpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBfLm9taXQoa2V5RW50aXR5MiwgWydvcHRpb25hbCddKSk7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkxLm5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyLm5hbWUgfVxuICAgICAgICApO1xuXG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGVudGl0eTEubmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIubmFtZSwga2V5RW50aXR5Mi5uYW1lKTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbE9wVG9TcWwob3ApIHtcbiAgICAgICAgc3dpdGNoIChvcCkge1xuICAgICAgICAgICAgY2FzZSAnPSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuICc9JztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbE9wVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7ICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgIGxldCBsZWZ0LCByaWdodDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAob29sLmxlZnQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wubGVmdCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gb29sLmxlZnQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5yaWdodC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wucmlnaHQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBvb2wucmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgJyAnICsgTXlTUUxNb2RlbGVyLm9vbE9wVG9TcWwob29sLm9wZXJhdG9yKSArICcgJyArIHJpZ2h0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdPYmplY3RSZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgIGlmICghT29sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IE9vbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9XG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24pIHtcbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVsYXRpb24ucmlnaHQgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9ICcnO1xuXG4gICAgICAgIGlmICh0aGlzLl9yZWxhdGlvbkVudGl0aWVzW2VudGl0eU5hbWVdKSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBDQVNDQURFIE9OIFVQREFURSBDQVNDQURFJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIE5PIEFDVElPTiBPTiBVUERBVEUgTk8gQUNUSU9OJztcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==