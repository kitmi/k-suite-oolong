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
        this.logger.log('debug', `Processing associations of entity "${entity.name}"...`);

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
              throw new Error(`Interconnection entity "${connEntityName}" not found in schema.`);
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
              let remoteField = assoc.remoteField || backRef.srcField || entity.name;
              entity.addAssociation(anchor, {
                entity: destEntityName,
                key: destEntity.key,
                on: this._translateJoinCondition({ ...assocNames,
                  [destEntityName]: anchor
                }, entity.key, anchor, remoteField),
                ...(typeof remoteField === 'string' ? {
                  field: remoteField
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

          let connEntity = schema.entities[connEntityName];

          if (!connEntity) {
            throw new Error(`Relation entity "${connEntityName}" not found in schema.`);
          }

          let connBackRef1 = connEntity.getReferenceTo(entity.name, {
            type: 'refersTo',
            srcField: f => _.isNil(f) || f == connectedByField
          });

          if (!connBackRef1) {
            throw new Error(`Cannot find back reference to "${entity.name}" from relation entity "${connEntityName}".`);
          }

          let connBackRef2 = connEntity.getReferenceTo(destEntityName, {
            type: 'refersTo'
          }, {
            association: connBackRef1
          });

          if (!connBackRef2) {
            throw new Error(`Cannot find back reference to "${destEntityName}" from relation entity "${connEntityName}".`);
          }

          let connectedByField2 = connBackRef2.srcField || destEntityName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "connectedBy" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              connectedBy: connectedByField
            }));
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
        console.log(assoc);
        entity.addAssocField(localField, destEntity, destKeyField, assoc.fieldProps);
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
    } else if (oolCon.oolType === 'UnaryExpression') {
      let arg;

      switch (oolCon.operator) {
        case 'is-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$eq': null
            }
          };

        case 'is-not-null':
          arg = oolCon.argument;

          if (arg.oolType && arg.oolType === 'ObjectReference') {
            arg = this._translateReference(context, arg.name, true);
          }

          return {
            [arg]: {
              '$ne': null
            }
          };

        default:
          throw new Error('Unknown UnaryExpression operator: ' + oolCon.operator);
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

          if ('startFrom' in feature) {
            this._events.on('setTableOptions:' + entity.name, extraOpts => {
              extraOpts['AUTO_INCREMENT'] = feature.startFrom;
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

    relationEntity.addAssocField(connectedByField, entity1, keyEntity1);
    relationEntity.addAssocField(connectedByField2, entity2, keyEntity2);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwibGlzdCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsInByZWZpeE5hbWluZyIsImNvbm5CYWNrUmVmMSIsImNvbm5CYWNrUmVmMiIsInNyYyIsImRlc3QiLCJjb25zb2xlIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFyZyIsImFyZ3VtZW50IiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2FkZFJlbGF0aW9uRW50aXR5IiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJzdGFydEluZGV4IiwiayIsInN1YkRvY3VtZW50cyIsImZpZWxkTmFtZSIsInN1YkNvbExpc3QiLCJzdWJBbGlhcyIsInN1YkpvaW5zIiwic3RhcnRJbmRleDIiLCJjb25jYXQiLCJsaW5rV2l0aEZpZWxkIiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleGVzIiwiaW5kZXgiLCJ1bmlxdWUiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsIm9wdGlvbmFsIiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHUCxPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFUSxFQUFBQTtBQUFGLElBQWdCRCxRQUF0Qjs7QUFDQSxNQUFNRSxNQUFNLEdBQUdULE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7QUFDQSxNQUFNVSxLQUFLLEdBQUdWLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFFQSxNQUFNVyx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQXVDQSxNQUFNQyxZQUFOLENBQW1CO0FBVWZDLEVBQUFB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QyxDQUFDNFMsU0FBRixDQUFZNU8sVUFBWixDQUFQLENBQWI7QUFFQTBPLE1BQUFBLGlCQUFpQixHQUFHMVMsQ0FBQyxDQUFDNlMsT0FBRixDQUFVN1MsQ0FBQyxDQUFDNFMsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUkxUyxDQUFDLENBQUM4UyxVQUFGLENBQWE5TyxVQUFiLEVBQXlCME8saUJBQXpCLENBQUosRUFBaUQ7QUFDN0MxTyxRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ21NLE1BQVgsQ0FBa0J1QyxpQkFBaUIsQ0FBQ3RPLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU9qRSxRQUFRLENBQUN3SSxZQUFULENBQXNCM0UsVUFBdEIsQ0FBUDtBQUNIOztBQXR5Q2M7O0FBeXlDbkIrTyxNQUFNLENBQUNDLE9BQVAsR0FBaUJ2UyxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiLi4uYCk7XG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogJ0NvbHVtblJlZmVyZW5jZScsIG5hbWUgfTsgIFxuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQuYnkpIH07XG4gICAgICAgICAgICBsZXQgd2l0aEV4dHJhID0gdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCByZW1vdGVGaWVsZC53aXRoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGxvY2FsRmllbGQgaW4gd2l0aEV4dHJhKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyByZXQsIHdpdGhFeHRyYSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnJldCwgLi4ud2l0aEV4dHJhIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkKSB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkgcmV0dXJuIGFzc29jLnNyY0ZpZWxkO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBsdXJhbGl6ZShhc3NvYy5kZXN0RW50aXR5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gYmVsb25nc1RvICAgICAgXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBoYXNNYW55L2hhc09uZSBbY29ubmVjdGVkQnldIFtjb25uZWN0ZWRXaXRoXVxuICAgICAqIGhhc01hbnkgLSBzZW1pIGNvbm5lY3Rpb24gICAgICAgXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKiAgICAgIFxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqICBcbiAgICAgKiBAcGFyYW0geyp9IHNjaGVtYSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIFxuICAgICAqL1xuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLmNvbm5lY3RlZFdpdGggPSBhc3NvYy5jb25uZWN0ZWRXaXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiY29ubmVjdGVkQnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludGVyY29ubmVjdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiIG5vdCBmb3VuZCBpbiBzY2hlbWEuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuY29ubmVjdGVkV2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYuY29ubmVjdGVkV2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gY29ubmVjdGVkQnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhbmNob3IgPSBhc3NvYy5zcmNGaWVsZCB8fCAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKSA6IGRlc3RFbnRpdHlOYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGFuY2hvciB9LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHR5cGVvZiByZW1vdGVGaWVsZCA9PT0gJ3N0cmluZycgPyB7IGZpZWxkOiByZW1vdGVGaWVsZCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgIFxuICAgICAgICAgICAgICAgICAgICAvLyBzZW1pIGFzc29jaWF0aW9uIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuY29ubmVjdGVkQnkgPyBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpIDogWyBPb2xVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIgbm90IGZvdW5kIGluIHNjaGVtYS5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBnZXQgYmFjayByZWYgZnJvbSBjb25uZWN0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYxID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBzcmNGaWVsZDogKGYpID0+IF8uaXNOaWwoZikgfHwgZiA9PSBjb25uZWN0ZWRCeUZpZWxkIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYyID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhkZXN0RW50aXR5TmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nIH0sIHsgYXNzb2NpYXRpb246IGNvbm5CYWNrUmVmMSAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2Rlc3RFbnRpdHlOYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gY29ubkJhY2tSZWYyLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy5jb25uZWN0ZWRXaXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGFzc29jKTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGRlc3RLZXlGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RFbnRpdHkua2V5KSB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICBsZWZ0RmllbGQuZm9yRWFjaChsZiA9PiB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGYsIHJpZ2h0LCByaWdodEZpZWxkKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmVhdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZlYXR1cmUuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBmZWF0dXJlIFwiJyArIGZlYXR1cmVOYW1lICsgJ1wiLicpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3dyaXRlRmlsZShmaWxlUGF0aCwgY29udGVudCkge1xuICAgICAgICBmcy5lbnN1cmVGaWxlU3luYyhmaWxlUGF0aCk7XG4gICAgICAgIGZzLndyaXRlRmlsZVN5bmMoZmlsZVBhdGgsIGNvbnRlbnQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0ZWQgZGIgc2NyaXB0OiAnICsgZmlsZVBhdGgpO1xuICAgIH1cblxuICAgIF9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIHJlbGF0aW9uRW50aXR5TmFtZSwgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnY3JlYXRlVGltZXN0YW1wJyBdLFxuICAgICAgICAgICAga2V5OiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MS5uYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTIubmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MS5uYW1lIH1cbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5Mi5uYW1lIH1cbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=