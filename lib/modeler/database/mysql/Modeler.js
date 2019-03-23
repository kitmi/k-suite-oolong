"use strict";

require("source-map-support/register");

const EventEmitter = require('events');

const path = require('path');

const Util = require('rk-utils');

const {
  _,
  fs,
  quote
} = Util;

const OolUtils = require('../../../lang/OolUtils');

const {
  pluralize,
  isDotSeparateName,
  extractDotSeparateName
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

  modeling(schema, schemaToConnector) {
    this.logger.log('info', 'Generating mysql scripts for schema "' + schema.name + '"...');
    let modelingSchema = schema.clone();
    this.logger.log('debug', 'Building relations...');
    let pendingEntities = Object.keys(modelingSchema.entities);

    while (pendingEntities.length > 0) {
      let entityName = pendingEntities.shift();
      let entity = modelingSchema.entities[entityName];

      if (!_.isEmpty(entity.info.associations)) {
        this.logger.log('debug', `Processing associations of entity "${entityName}"...`);

        let assocs = this._preProcessAssociations(entity);

        let assocNames = assocs.reduce((result, v) => {
          result[v] = v;
          return result;
        }, {});
        entity.info.associations.forEach(assoc => this._processAssociation(modelingSchema, entity, assoc, assocNames, pendingEntities));
      }
    }

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
                console.log(entity.info.data);
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
        relationSQL += this._addForeignKeyStatement(srcEntityName, ref, schemaToConnector) + '\n';
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

  _processAssociation(schema, entity, assoc, assocNames, pendingEntities) {
    let entityKeyField = entity.getKeyField();

    if (!!Array.isArray(entityKeyField)) {
      throw new Error("Assertion failed: !Array.isArray(entityKeyField)");
    }

    let destEntityName = assoc.destEntity,
        destEntity,
        destEntityNameAsFieldName;

    if (isDotSeparateName(destEntityName)) {
      let [destSchemaName, actualDestEntityName] = extractDotSeparateName(destEntityName);
      let destSchema = schema.linker.schemas[destSchemaName];

      if (!destSchema.linked) {
        throw new Error(`The destination schema ${destSchemaName} has not been linked yet. Currently only support one-way reference for cross db relation.`);
      }

      destEntity = destSchema.entities[actualDestEntityName];
      destEntityNameAsFieldName = actualDestEntityName;
    } else {
      destEntity = schema.ensureGetEntity(entity.oolModule, destEntityName, pendingEntities);
      destEntityNameAsFieldName = destEntityName;
    }

    if (!destEntity) {
      throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
    }

    let destKeyField = destEntity.getKeyField();

    if (!destKeyField) {
      throw new Error("Assertion failed: destKeyField");
    }

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

        if (assoc.by) {
          excludes.types.push('belongsTo');
          includes = {
            by: cb => cb && cb.split('.')[0] === assoc.by.split('.')[0]
          };

          if (assoc.with) {
            includes.with = assoc.with;
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
            if (!assoc.by) {
              throw new Error('"m2n" association requires "by" property. Entity: ' + entity.name + ' destination: ' + destEntityName);
            }

            let connectedByParts = assoc.by.split('.');

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

            let connectedByParts2 = backRef.by.split('.');
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntity.name;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "by" field in a relation entity.');
            }

            let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

            if (!connEntity) {
              throw new Error(`Interconnection entity "${connEntityName}" not found in schema.`);
            }

            this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

            let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
            entity.addAssociation(localFieldName, {
              entity: connEntityName,
              key: connEntity.key,
              on: this._translateJoinCondition({ ...assocNames,
                [connEntityName]: localFieldName
              }, entity.key, localFieldName, assoc.with ? {
                by: connectedByField,
                with: assoc.with
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
              }, destEntity.key, remoteFieldName, backRef.with ? {
                by: connectedByField2,
                with: backRef.with
              } : connectedByField),
              field: connectedByField2,
              ...(backRef.type === 'hasMany' ? {
                list: true
              } : {}),
              assoc: connectedByField
            });

            this._processedRef.add(tag1);

            this.logger.log('verbose', `Processed 2-way reference: ${tag1}`);

            this._processedRef.add(tag2);

            this.logger.log('verbose', `Processed 2-way reference: ${tag2}`);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.by) {
              throw new Error('todo: belongsTo by. entity: ' + entity.name);
            } else {
              let anchor = assoc.srcField || (assoc.type === 'hasMany' ? pluralize(destEntityNameAsFieldName) : destEntityNameAsFieldName);
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
          let connectedByParts = assoc.by ? assoc.by.split('.') : [OolUtils.prefixNaming(entity.name, destEntityName)];

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

          let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

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

          let connectedByField2 = connBackRef2.srcField || destEntityNameAsFieldName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "by" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              by: connectedByField
            }));
          }

          this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityNameAsFieldName);
          entity.addAssociation(localFieldName, {
            entity: connEntityName,
            key: connEntity.key,
            on: this._translateJoinCondition({ ...assocNames,
              [connEntityName]: localFieldName
            }, entity.key, localFieldName, assoc.with ? {
              by: connectedByField,
              with: assoc.with
            } : connectedByField),
            field: connectedByField,
            ...(assoc.type === 'hasMany' ? {
              list: true
            } : {}),
            assoc: connectedByField2
          });

          this._processedRef.add(tag1);

          this.logger.log('verbose', `Processed 1-way reference: ${tag1}`);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityNameAsFieldName;

        if (assoc.type === 'refersTo') {
          let tag = `${entity.name}:1-${destEntityName}:* ${localField}`;

          if (this._processedRef.has(tag)) {
            return;
          }

          this._processedRef.add(tag);

          this.logger.log('verbose', `Processed week reference: ${tag}`);
        }

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

  _updateRelationEntity(relationEntity, entity1, entity2, entity1Name, entity2Name, connectedByField, connectedByField2) {
    let relationEntityName = relationEntity.name;
    this._relationEntities[relationEntityName] = true;

    if (relationEntity.info.associations) {
      let hasRefToEntity1 = false,
          hasRefToEntity2 = false;

      _.each(relationEntity.info.associations, assoc => {
        if (assoc.type === 'refersTo' && assoc.destEntity === entity1Name && (assoc.srcField || entity1Name) === connectedByField) {
          hasRefToEntity1 = true;
        }

        if (assoc.type === 'refersTo' && assoc.destEntity === entity2Name && (assoc.srcField || entity2Name) === connectedByField2) {
          hasRefToEntity2 = true;
        }
      });

      if (hasRefToEntity1 && hasRefToEntity2) {
        return;
      }
    }

    let tag1 = `${relationEntityName}:1-${entity1Name}:* ${connectedByField}`;
    let tag2 = `${relationEntityName}:1-${entity2Name}:* ${connectedByField2}`;

    if (this._processedRef.has(tag1)) {
      if (!this._processedRef.has(tag2)) {
        throw new Error("Assertion failed: this._processedRef.has(tag2)");
      }

      return;
    }

    this._processedRef.add(tag1);

    this.logger.log('verbose', `Processed bridging reference: ${tag1}`);

    this._processedRef.add(tag2);

    this.logger.log('verbose', `Processed bridging reference: ${tag2}`);
    let keyEntity1 = entity1.getKeyField();

    if (Array.isArray(keyEntity1)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity1Name}`);
    }

    let keyEntity2 = entity2.getKeyField();

    if (Array.isArray(keyEntity2)) {
      throw new Error(`Combination primary key is not supported. Entity: ${entity2Name}`);
    }

    relationEntity.addAssocField(connectedByField, entity1, keyEntity1);
    relationEntity.addAssocField(connectedByField2, entity2, keyEntity2);
    relationEntity.addAssociation(connectedByField, {
      entity: entity1Name
    });
    relationEntity.addAssociation(connectedByField2, {
      entity: entity2Name
    });

    this._addReference(relationEntityName, connectedByField, entity1Name, keyEntity1.name);

    this._addReference(relationEntityName, connectedByField2, entity2Name, keyEntity2.name);
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

  _addForeignKeyStatement(entityName, relation, schemaToConnector) {
    let refTable = relation.right;

    if (refTable.indexOf('.') > 0) {
      let [schemaName, entityName] = refTable.split('.');
      let targetConnector = schemaToConnector[schemaName];

      if (!targetConnector) {
        throw new Error("Assertion failed: targetConnector");
      }

      refTable = targetConnector.database + '`.`' + entityName;
    }

    let sql = 'ALTER TABLE `' + entityName + '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' + 'REFERENCES `' + refTable + '` (`' + relation.rightField + '`) ';
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJjb25zb2xlIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lIiwiZGVzdFNjaGVtYU5hbWUiLCJhY3R1YWxEZXN0RW50aXR5TmFtZSIsImRlc3RTY2hlbWEiLCJzY2hlbWFzIiwibGlua2VkIiwiZW5zdXJlR2V0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjYiIsInNwbGl0IiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsImxpc3QiLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwidGFnIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFyZyIsImFyZ3VtZW50IiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwiX2FkZFJlbGF0aW9uRW50aXR5IiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiZW50aXR5MU5hbWUiLCJlbnRpdHkyTmFtZSIsImhhc1JlZlRvRW50aXR5MSIsImhhc1JlZlRvRW50aXR5MiIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleGVzIiwiaW5kZXgiLCJ1bmlxdWUiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwicmVmVGFibGUiLCJzY2hlbWFOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsIm9wdGlvbmFsIiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUVBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFRyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHTixPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFTyxFQUFBQSxTQUFGO0FBQWFDLEVBQUFBLGlCQUFiO0FBQWdDQyxFQUFBQTtBQUFoQyxJQUEyREgsUUFBakU7O0FBQ0EsTUFBTUksTUFBTSxHQUFHVixPQUFPLENBQUMsc0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTVcsS0FBSyxHQUFHWCxPQUFPLENBQUMsd0JBQUQsQ0FBckI7O0FBRUEsTUFBTVkseUJBQXlCLEdBQUcsSUFB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QUFHL1MsQ0FBQyxDQUFDa1QsT0FBRixDQUFVbFQsQ0FBQyxDQUFDaVQsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUkvUyxDQUFDLENBQUNtVCxVQUFGLENBQWF4USxVQUFiLEVBQXlCb1EsaUJBQXpCLENBQUosRUFBaUQ7QUFDN0NwUSxRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ3lOLE1BQVgsQ0FBa0IyQyxpQkFBaUIsQ0FBQ3JRLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU92QyxRQUFRLENBQUNpSixZQUFULENBQXNCekcsVUFBdEIsQ0FBUDtBQUNIOztBQWozQ2M7O0FBbzNDbkJ5USxNQUFNLENBQUNDLE9BQVAsR0FBaUIxUyxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hLCBzY2hlbWFUb0Nvbm5lY3Rvcikge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBwZW5kaW5nRW50aXRpZXMgPSBPYmplY3Qua2V5cyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgd2hpbGUgKHBlbmRpbmdFbnRpdGllcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBsZXQgZW50aXR5TmFtZSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzW2VudGl0eU5hbWVdO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5TmFtZX1cIi4uLmApOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGxldCBhc3NvY3MgPSB0aGlzLl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSk7ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NOYW1lcyA9IGFzc29jcy5yZWR1Y2UoKHJlc3VsdCwgdikgPT4ge1xuICAgICAgICAgICAgICAgICAgICByZXN1bHRbdl0gPSB2O1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhlbnRpdHkuaW5mby5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYsIHNjaGVtYVRvQ29ubmVjdG9yKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5LCBkZXN0RW50aXR5LCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgLy9jcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgICAgIGxldCBbIGRlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZSBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXN0U2NoZW1hID0gc2NoZW1hLmxpbmtlci5zY2hlbWFzW2Rlc3RTY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGlmICghZGVzdFNjaGVtYS5saW5rZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBkZXN0U2NoZW1hLmVudGl0aWVzW2FjdHVhbERlc3RFbnRpdHlOYW1lXTsgXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBkZXN0RW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQ7IFxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHR5cGVzOiBbICdyZWZlcnNUbycgXSwgXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBieTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuYnkuc3BsaXQoJy4nKVswXSBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMud2l0aCA9IGFzc29jLndpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKGFzc29jLnJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogcmVtb3RlRmllbGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmlzTmlsKHJlbW90ZUZpZWxkcykgfHwgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGRzKSA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSByZW1vdGVGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJieVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcgZGVzdGluYXRpb246ICcgKyBkZXN0RW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGVkIGJ5IGZpZWxkIGlzIHVzdWFsbHkgYSByZWZlcnNUbyBhc3NvY1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lOyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5Lm5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW50ZXJjb25uZWN0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIgbm90IGZvdW5kIGluIHNjaGVtYS5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIiBub3QgZm91bmQgaW4gc2NoZW1hLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuIERldGFpbDogJyArIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmM6IGVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3Q6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiBhc3NvYy5zcmNGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMS13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZyA9IGAke2VudGl0eS5uYW1lfToxLSR7ZGVzdEVudGl0eU5hbWV9OiogJHtsb2NhbEZpZWxkfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnKSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCBieSBjb25uZWN0aW9uLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZyk7ICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgd2VlayByZWZlcmVuY2U6ICR7dGFnfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGRlc3RLZXlGaWVsZCwgYXNzb2MuZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UobG9jYWxGaWVsZCArICcuJyArIGRlc3RFbnRpdHkua2V5KSB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmTmFtZSA9IFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG5cbiAgICAgICAgaWYgKGFzS2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShyZWZOYW1lKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCkpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLmJ5LCByaWdodC4gcmlnaHRGaWVsZCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGR9KTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZlYXR1cmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmZWF0dXJlLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSByZWxhdGlvbkVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MU5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkMiBcbiAgICAgKi9cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICBcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIHRoZSByZWxhdGlvbiBlbnRpdHkgaGFzIHRoZSByZWZlcnNUbyBib3RoIHNpZGUgb2YgYXNzb2NpYXRpb25zICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5lYWNoKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCBhc3NvYyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MU5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTFOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5Mk5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIC8veWVzLCBkb24ndCBuZWVkIHRvIGFkZCByZWZlcnNUbyB0byB0aGUgcmVsYXRpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRhZzEgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkxTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGR9YDtcbiAgICAgICAgbGV0IHRhZzIgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkyTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGQyfWA7XG5cbiAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkpIHtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKTtcblxuICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgIFxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxTmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MU5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyTmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lKTsgICAgICAgIFxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICAvKlxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfSovXG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCBlbnRpdHlOYW1lIF0gPSByZWZUYWJsZS5zcGxpdCgnLicpOyAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Q29ubmVjdG9yID0gc2NoZW1hVG9Db25uZWN0b3Jbc2NoZW1hTmFtZV07XG4gICAgICAgICAgICBhc3NlcnQ6IHRhcmdldENvbm5lY3RvcjtcblxuICAgICAgICAgICAgcmVmVGFibGUgPSB0YXJnZXRDb25uZWN0b3IuZGF0YWJhc2UgKyAnYC5gJyArIGVudGl0eU5hbWU7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVmVGFibGUgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9ICcnO1xuXG4gICAgICAgIGlmICh0aGlzLl9yZWxhdGlvbkVudGl0aWVzW2VudGl0eU5hbWVdKSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBDQVNDQURFIE9OIFVQREFURSBDQVNDQURFJztcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIE5PIEFDVElPTiBPTiBVUERBVEUgTk8gQUNUSU9OJztcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgZm9yZWlnbktleUZpZWxkTmFtaW5nKGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgbGVmdFBhcnQgPSBVdGlsLl8uY2FtZWxDYXNlKGVudGl0eU5hbWUpO1xuICAgICAgICBsZXQgcmlnaHRQYXJ0ID0gVXRpbC5wYXNjYWxDYXNlKGVudGl0eS5rZXkpO1xuXG4gICAgICAgIGlmIChfLmVuZHNXaXRoKGxlZnRQYXJ0LCByaWdodFBhcnQpKSB7XG4gICAgICAgICAgICByZXR1cm4gbGVmdFBhcnQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbGVmdFBhcnQgKyByaWdodFBhcnQ7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlU3RyaW5nKHN0cikge1xuICAgICAgICByZXR1cm4gXCInXCIgKyBzdHIucmVwbGFjZSgvJy9nLCBcIlxcXFwnXCIpICsgXCInXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlSWRlbnRpZmllcihzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiYFwiICsgc3RyICsgXCJgXCI7XG4gICAgfVxuXG4gICAgc3RhdGljIHF1b3RlTGlzdE9yVmFsdWUob2JqKSB7XG4gICAgICAgIHJldHVybiBfLmlzQXJyYXkob2JqKSA/XG4gICAgICAgICAgICBvYmoubWFwKHYgPT4gTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcih2KSkuam9pbignLCAnKSA6XG4gICAgICAgICAgICBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG9iaik7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbXBsaWFuY2VDaGVjayhlbnRpdHkpIHtcbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgZXJyb3JzOiBbXSwgd2FybmluZ3M6IFtdIH07XG5cbiAgICAgICAgaWYgKCFlbnRpdHkua2V5KSB7XG4gICAgICAgICAgICByZXN1bHQuZXJyb3JzLnB1c2goJ1ByaW1hcnkga2V5IGlzIG5vdCBzcGVjaWZpZWQuJyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5EZWZpbml0aW9uKGZpZWxkLCBpc1Byb2MpIHtcbiAgICAgICAgbGV0IGNvbDtcbiAgICAgICAgXG4gICAgICAgIHN3aXRjaCAoZmllbGQudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaW50ZWdlcic6XG4gICAgICAgICAgICBjb2wgPSBNeVNRTE1vZGVsZXIuaW50Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ251bWJlcic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmZsb2F0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3RleHQnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2Jvb2xlYW4nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5ib29sQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2JpbmFyeSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJpbmFyeUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdkYXRldGltZSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ29iamVjdCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhazsgICAgICAgICAgICBcblxuICAgICAgICAgICAgY2FzZSAnZW51bSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmVudW1Db2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXJyYXknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCB0eXBlIFwiJyArIGZpZWxkLnR5cGUgKyAnXCIuJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgeyBzcWwsIHR5cGUgfSA9IGNvbDsgICAgICAgIFxuXG4gICAgICAgIGlmICghaXNQcm9jKSB7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5jb2x1bW5OdWxsYWJsZShmaWVsZCk7XG4gICAgICAgICAgICBzcWwgKz0gdGhpcy5kZWZhdWx0VmFsdWUoZmllbGQsIHR5cGUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgaW50Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZGlnaXRzKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5kaWdpdHMgPiAxMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQklHSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA3KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDQpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUlOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gMikge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnU01BTExJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RJTllJTlQnO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBzcWwgKz0gYCgke2luZm8uZGlnaXRzfSlgXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby51bnNpZ25lZCkge1xuICAgICAgICAgICAgc3FsICs9ICcgVU5TSUdORUQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGZsb2F0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby50eXBlID09ICdudW1iZXInICYmIGluZm8uZXhhY3QpIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnREVDSU1BTCc7XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNjUpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RPVUJMRSc7XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDUzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdGTE9BVCc7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJ3RvdGFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby50b3RhbERpZ2l0cztcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnLCAnICtpbmZvLmRlY2ltYWxEaWdpdHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzcWwgKz0gJyknO1xuXG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5kZWNpbWFsRGlnaXRzID4gMjMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoNTMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoMjMsICcgK2luZm8uZGVjaW1hbERpZ2l0cyArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgdGV4dENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggJiYgaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdDSEFSKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdDSEFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gMjAwMCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQ0hBUic7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVEVYVCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCA8PSAyNTUpIHtcbiAgICAgICAgICAgIHNxbCA9ICdCSU5BUlkoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0JJTkFSWSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HQkxPQic7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTUJMT0InO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkJJTkFSWSc7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8ubWF4TGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnQkxPQic7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgYm9vbENvbHVtbkRlZmluaXRpb24oKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ1RJTllJTlQoMSknLCB0eXBlOiAnVElOWUlOVCcgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbDtcblxuICAgICAgICBpZiAoIWluZm8ucmFuZ2UgfHwgaW5mby5yYW5nZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEVUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAnZGF0ZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAneWVhcicpIHtcbiAgICAgICAgICAgIHNxbCA9ICdZRUFSJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLnJhbmdlID09PSAndGltZXN0YW1wJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGU6IHNxbCB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBlbnVtQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIHJldHVybiB7IHNxbDogJ0VOVU0oJyArIF8ubWFwKGluZm8udmFsdWVzLCAodikgPT4gTXlTUUxNb2RlbGVyLnF1b3RlU3RyaW5nKHYpKS5qb2luKCcsICcpICsgJyknLCB0eXBlOiAnRU5VTScgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uTnVsbGFibGUoaW5mbykge1xuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnb3B0aW9uYWwnKSAmJiBpbmZvLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICByZXR1cm4gJyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnIE5PVCBOVUxMJztcbiAgICB9XG5cbiAgICBzdGF0aWMgZGVmYXVsdFZhbHVlKGluZm8sIHR5cGUpIHtcbiAgICAgICAgaWYgKGluZm8uaXNDcmVhdGVUaW1lc3RhbXApIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLmF1dG9JbmNyZW1lbnRJZCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIEFVVE9fSU5DUkVNRU5UJztcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgaWYgKGluZm8uaXNVcGRhdGVUaW1lc3RhbXApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGluZm8udXBkYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBPTiBVUERBVEUgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICcnO1xuXG4gICAgICAgIGlmICghaW5mby5vcHRpb25hbCkgeyAgICAgIFxuICAgICAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSkge1xuICAgICAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvWydkZWZhdWx0J107XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFR5cGVzLkJPT0xFQU4uc2FuaXRpemUoZGVmYXVsdFZhbHVlKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIC8vdG9kbzogb3RoZXIgdHlwZXNcblxuICAgICAgICAgICAgfSBlbHNlIGlmICghaW5mby5oYXNPd25Qcm9wZXJ0eSgnYXV0bycpKSB7XG4gICAgICAgICAgICAgICAgaWYgKFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUuaGFzKHR5cGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbGVhbicgfHwgaW5mby50eXBlID09PSAnaW50ZWdlcicgfHwgaW5mby50eXBlID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIDAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZW51bScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgIHF1b3RlKGluZm8udmFsdWVzWzBdKTtcbiAgICAgICAgICAgICAgICB9ICBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBcIlwiJztcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSAgICAgICAgXG4gICAgXG4gICAgICAgIC8qXG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykgJiYgdHlwZW9mIGluZm8uZGVmYXVsdCA9PT0gJ29iamVjdCcgJiYgaW5mby5kZWZhdWx0Lm9vbFR5cGUgPT09ICdTeW1ib2xUb2tlbicpIHtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0VmFsdWUgPSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdEJ5RGIgPSBmYWxzZTtcblxuICAgICAgICAgICAgc3dpdGNoIChkZWZhdWx0VmFsdWUubmFtZSkge1xuICAgICAgICAgICAgICAgIGNhc2UgJ25vdyc6XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBOT1cnXG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChkZWZhdWx0QnlEYikge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBpbmZvLmRlZmF1bHQ7XG4gICAgICAgICAgICAgICAgaW5mby5kZWZhdWx0QnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzU3RyaW5nKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKFMoZGVmYXVsdFZhbHVlKS50b0Jvb2xlYW4oKSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgKGRlZmF1bHRWYWx1ZSA/ICcxJyA6ICcwJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdpbnQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VJbnQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAndGV4dCcpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2Zsb2F0Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzTnVtYmVyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgcGFyc2VGbG9hdChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdiaW5hcnknKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5iaW4ySGV4KGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2pzb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKHR5cGVvZiBkZWZhdWx0VmFsdWUgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKEpTT04uc3RyaW5naWZ5KGRlZmF1bHRWYWx1ZSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAneG1sJyB8fCBpbmZvLnR5cGUgPT09ICdlbnVtJyB8fCBpbmZvLnR5cGUgPT09ICdjc3YnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aCcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuICAgICAgICAqLyAgICBcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIHJlbW92ZVRhYmxlTmFtZVByZWZpeChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICBpZiAocmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgICAgIGVudGl0eU5hbWUgPSBfLnRyaW0oXy5zbmFrZUNhc2UoZW50aXR5TmFtZSkpO1xuXG4gICAgICAgICAgICByZW1vdmVUYWJsZVByZWZpeCA9IF8udHJpbUVuZChfLnNuYWtlQ2FzZShyZW1vdmVUYWJsZVByZWZpeCksICdfJykgKyAnXyc7XG5cbiAgICAgICAgICAgIGlmIChfLnN0YXJ0c1dpdGgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpKSB7XG4gICAgICAgICAgICAgICAgZW50aXR5TmFtZSA9IGVudGl0eU5hbWUuc3Vic3RyKHJlbW92ZVRhYmxlUHJlZml4Lmxlbmd0aCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gT29sVXRpbHMuZW50aXR5TmFtaW5nKGVudGl0eU5hbWUpO1xuICAgIH07XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxNb2RlbGVyOyJdfQ==