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

    const zeroInitFile = '0-init.json';
    let sqlFilesDir = path.join('mysql', this.connector.database);
    let dbFilePath = path.join(sqlFilesDir, 'entities.sql');
    let fkFilePath = path.join(sqlFilesDir, 'relations.sql');
    let initIdxFilePath = path.join(sqlFilesDir, 'data', '_init', 'index.list');
    let initFilePath = path.join(sqlFilesDir, 'data', '_init', zeroInitFile);
    let tableSQL = '',
        relationSQL = '',
        data = {};

    _.each(modelingSchema.entities, (entity, entityName) => {
      if (!(entityName === entity.name)) {
        throw new Error("Assertion failed: entityName === entity.name");
      }

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
            f.forEach(ff => this._featureReducer(modelingSchema, entity, featureName, ff));
          } else {
            this._featureReducer(modelingSchema, entity, featureName, f);
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
        relationSQL += this._addForeignKeyStatement(srcEntityName, ref, schemaToConnector) + '\n';
      });
    });

    this._writeFile(path.join(this.outputPath, dbFilePath), tableSQL);

    this._writeFile(path.join(this.outputPath, fkFilePath), relationSQL);

    let initIdxFileContent;

    if (!_.isEmpty(data)) {
      this._writeFile(path.join(this.outputPath, initFilePath), JSON.stringify(data, null, 4));

      initIdxFileContent = zeroInitFile + '\n';
    } else {
      initIdxFileContent = '';
    }

    if (!fs.existsSync(path.join(this.outputPath, initIdxFilePath))) {
      this._writeFile(path.join(this.outputPath, initIdxFilePath), initIdxFileContent);
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

    this.logger.log('debug', `Processing "${entity.name}" ${JSON.stringify(assoc)}`);
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

      if (!destEntity) {
        throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
      }

      destEntityNameAsFieldName = destEntityName;
    }

    if (!destEntity) {
      throw new Error(`Entity "${entity.name}" references to an unexisting entity "${destEntityName}".`);
    }

    let destKeyField = destEntity.getKeyField();

    if (!destKeyField) {
      throw new Error(`Empty key field. Entity: ${destEntityName}`);
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
            let connectedByField2 = connectedByParts2.length > 1 && connectedByParts2[1] || destEntityNameAsFieldName;

            if (connectedByField === connectedByField2) {
              throw new Error('Cannot use the same "by" field in a relation entity.');
            }

            let connEntity = schema.ensureGetEntity(entity.oolModule, connEntityName, pendingEntities);

            if (!connEntity) {
              connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, connectedByField2);
              pendingEntities.push(connEntity.name);
              this.logger.log('debug', `New entity "${connEntity.name}" added by association.`);
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
              } : connectedByField2),
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
                }, entity.key, anchor, assoc.with ? {
                  by: remoteField,
                  with: assoc.with
                } : remoteField),
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
            connEntity = this._addRelationEntity(schema, connEntityName, entity.name, destEntityName, connectedByField, destEntityNameAsFieldName);
            pendingEntities.push(connEntity.name);
            this.logger.log('debug', `New entity "${connEntity.name}" added by association.`);
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
        let localFieldObj = entity.fields[localField];
        let constraints = {};

        if (localFieldObj.constraintOnUpdate) {
          constraints.onUpdate = localFieldObj.constraintOnUpdate;
        }

        if (localFieldObj.constraintOnDelete) {
          constraints.onDelete = localFieldObj.constraintOnDelete;
        }

        if (assoc.type === 'belongsTo') {
          constraints.onUpdate || (constraints.onUpdate = 'RESTRICT');
          constraints.onDelete || (constraints.onDelete = 'RESTRICT');
        } else if (localFieldObj.optional) {
          constraints.onUpdate || (constraints.onUpdate = 'SET NULL');
          constraints.onDelete || (constraints.onDelete = 'SET NULL');
        }

        constraints.onUpdate || (constraints.onUpdate = 'NO ACTION');
        constraints.onDelete || (constraints.onDelete = 'NO ACTION');

        this._addReference(entity.name, localField, destEntityName, destKeyField.name, constraints);

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
      } else if (oolCon.operator === '!=') {
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
            '$ne': right
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
    } else if (oolCon.oolType === 'LogicalExpression') {
      switch (oolCon.operator) {
        case 'and':
          return {
            $and: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };

        case 'or':
          return {
            $or: [this._oolConditionToQueryCondition(context, oolCon.left), this._oolConditionToQueryCondition(context, oolCon.right)]
          };
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

  _addReference(left, leftField, right, rightField, constraints) {
    if (Array.isArray(leftField)) {
      leftField.forEach(lf => this._addReference(left, lf, right, rightField, constraints));
      return;
    }

    if (_.isPlainObject(leftField)) {
      this._addReference(left, leftField.by, right.rightField, constraints);

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
      rightField,
      constraints
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

  _featureReducer(schema, entity, featureName, feature) {
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

      case 'changeLog':
        let changeLogSettings = Util.getValueByPath(schema.deploymentSettings, 'features.changeLog');

        if (!changeLogSettings) {
          throw new Error(`Missing "changeLog" feature settings in deployment config for schema [${schema.name}].`);
        }

        if (!changeLogSettings.dataSource) {
          throw new Error(`"changeLog.dataSource" is required. Schema: ${schema.name}`);
        }

        Object.assign(feature, changeLogSettings);
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

  _addRelationEntity(schema, relationEntityName, entity1Name, entity2Name, entity1RefField, entity2RefField) {
    let entityInfo = {
      features: ['autoId', 'createTimestamp'],
      indexes: [{
        "fields": [entity1RefField, entity2RefField],
        "unique": true
      }],
      associations: [{
        "type": "refersTo",
        "destEntity": entity1Name,
        "srcField": entity1RefField
      }, {
        "type": "refersTo",
        "destEntity": entity2Name,
        "srcField": entity2RefField
      }]
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
    let allCascade = {
      onUpdate: 'RESTRICT',
      onDelete: 'RESTRICT'
    };

    this._addReference(relationEntityName, connectedByField, entity1Name, keyEntity1.name, allCascade);

    this._addReference(relationEntityName, connectedByField2, entity2Name, keyEntity2.name, allCascade);
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
      let [schemaName, refEntityName] = refTable.split('.');
      let targetConnector = schemaToConnector[schemaName];

      if (!targetConnector) {
        throw new Error("Assertion failed: targetConnector");
      }

      refTable = targetConnector.database + '`.`' + refEntityName;
    }

    let sql = 'ALTER TABLE `' + entityName + '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' + 'REFERENCES `' + refTable + '` (`' + relation.rightField + '`) ';
    sql += `ON UPDATE ${relation.constraints.onUpdate} ON DELETE ${relation.constraints.onDelete};\n`;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInplcm9Jbml0RmlsZSIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJ0cmFuc2xhdGVPb2xWYWx1ZSIsIm9vbE1vZHVsZSIsInB1c2giLCJhc3NpZ24iLCJyZWZzIiwic3JjRW50aXR5TmFtZSIsInJlZiIsIl9hZGRGb3JlaWduS2V5U3RhdGVtZW50IiwiX3dyaXRlRmlsZSIsImluaXRJZHhGaWxlQ29udGVudCIsIkpTT04iLCJzdHJpbmdpZnkiLCJleGlzdHNTeW5jIiwiZnVuY1NRTCIsInNwRmlsZVBhdGgiLCJfdG9Db2x1bW5SZWZlcmVuY2UiLCJvb3JUeXBlIiwiX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24iLCJsb2NhbEZpZWxkIiwiYW5jaG9yIiwicmVtb3RlRmllbGQiLCJtYXAiLCJyZiIsInJldCIsImJ5Iiwid2l0aEV4dHJhIiwiX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24iLCJ3aXRoIiwiJGFuZCIsIl9nZXRBbGxSZWxhdGVkRmllbGRzIiwidW5kZWZpbmVkIiwic3JjRmllbGQiLCJ0eXBlIiwiZGVzdEVudGl0eSIsImVudGl0eUtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJkZXN0RW50aXR5TmFtZSIsImRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwic3BsaXQiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwibGlzdCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsInByZWZpeE5hbWluZyIsImNvbm5CYWNrUmVmMSIsImNvbm5CYWNrUmVmMiIsInNyYyIsImRlc3QiLCJ0YWciLCJhZGRBc3NvY0ZpZWxkIiwiZmllbGRQcm9wcyIsImxvY2FsRmllbGRPYmoiLCJjb25zdHJhaW50cyIsImNvbnN0cmFpbnRPblVwZGF0ZSIsIm9uVXBkYXRlIiwiY29uc3RyYWludE9uRGVsZXRlIiwib25EZWxldGUiLCJvcHRpb25hbCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYXJnIiwiYXJndW1lbnQiLCIkb3IiLCJhc0tleSIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJjaGFuZ2VMb2dTZXR0aW5ncyIsImdldFZhbHVlQnlQYXRoIiwiZGVwbG95bWVudFNldHRpbmdzIiwiZGF0YVNvdXJjZSIsImZpbGVQYXRoIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsInJlbGF0aW9uRW50aXR5TmFtZSIsImVudGl0eTFOYW1lIiwiZW50aXR5Mk5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwiaW5kZXhlcyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJhbGxDYXNjYWRlIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJyZWZFbnRpdHlOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFFQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUcsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBO0FBQVQsSUFBbUJILElBQXpCOztBQUVBLE1BQU1JLFFB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QWtSLE1BQUFBLGlCQUFpQixHQUFHN1QsQ0FBQyxDQUFDZ1UsT0FBRixDQUFVaFUsQ0FBQyxDQUFDK1QsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUk3VCxDQUFDLENBQUNpVSxVQUFGLENBQWF0UixVQUFiLEVBQXlCa1IsaUJBQXpCLENBQUosRUFBaUQ7QUFDN0NsUixRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ3VPLE1BQVgsQ0FBa0IyQyxpQkFBaUIsQ0FBQ25SLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU92QyxRQUFRLENBQUNrSixZQUFULENBQXNCMUcsVUFBdEIsQ0FBUDtBQUNIOztBQXI5Q2M7O0FBdzlDbkJ1UixNQUFNLENBQUNDLE9BQVAsR0FBaUJ4VCxZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUsIGlzRG90U2VwYXJhdGVOYW1lLCBleHRyYWN0RG90U2VwYXJhdGVOYW1lIH0gPSBPb2xVdGlscztcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGNvbnN0IHplcm9Jbml0RmlsZSA9ICcwLWluaXQuanNvbic7XG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgemVyb0luaXRGaWxlKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICAvL2xldCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGVudGl0eU5hbWUgPT09IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgLy9tYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lW2VudGl0eU5hbWVdID0gZW50aXR5LmNvZGU7XG5cbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eS8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGxldCBpbml0SWR4RmlsZUNvbnRlbnQ7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGluaXRJZHhGaWxlQ29udGVudCA9IHplcm9Jbml0RmlsZSArICdcXG4nOyAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgLy9ubyBkYXRhIGVudHJ5XG4gICAgICAgICAgICBpbml0SWR4RmlsZUNvbnRlbnQgPSAnJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksIGluaXRJZHhGaWxlQ29udGVudCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogJ0NvbHVtblJlZmVyZW5jZScsIG5hbWUgfTsgIFxuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQuYnkpIH07XG4gICAgICAgICAgICBsZXQgd2l0aEV4dHJhID0gdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCByZW1vdGVGaWVsZC53aXRoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGxvY2FsRmllbGQgaW4gd2l0aEV4dHJhKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyByZXQsIHdpdGhFeHRyYSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnJldCwgLi4ud2l0aEV4dHJhIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkKSB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkgcmV0dXJuIGFzc29jLnNyY0ZpZWxkO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBsdXJhbGl6ZShhc3NvYy5kZXN0RW50aXR5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gYmVsb25nc1RvICAgICAgXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBoYXNNYW55L2hhc09uZSBbYnldIFt3aXRoXVxuICAgICAqIGhhc01hbnkgLSBzZW1pIGNvbm5lY3Rpb24gICAgICAgXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKiAgICAgIFxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqICBcbiAgICAgKiBAcGFyYW0geyp9IHNjaGVtYSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIFxuICAgICAqL1xuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpIHtcbiAgICAgICAgbGV0IGVudGl0eUtleUZpZWxkID0gZW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoZW50aXR5S2V5RmllbGQpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgUHJvY2Vzc2luZyBcIiR7ZW50aXR5Lm5hbWV9XCIgJHtKU09OLnN0cmluZ2lmeShhc3NvYyl9YCk7IFxuXG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHksIGRlc3RFbnRpdHksIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG4gICAgICAgIFxuICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICAvL2Nyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICAgICAgbGV0IFsgZGVzdFNjaGVtYU5hbWUsIGFjdHVhbERlc3RFbnRpdHlOYW1lIF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlc3RTY2hlbWEgPSBzY2hlbWEubGlua2VyLnNjaGVtYXNbZGVzdFNjaGVtYU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFkZXN0U2NoZW1hLmxpbmtlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIGRlc3RpbmF0aW9uIHNjaGVtYSAke2Rlc3RTY2hlbWFOYW1lfSBoYXMgbm90IGJlZW4gbGlua2VkIHlldC4gQ3VycmVudGx5IG9ubHkgc3VwcG9ydCBvbmUtd2F5IHJlZmVyZW5jZSBmb3IgY3Jvc3MgZGIgcmVsYXRpb24uYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eSA9IGRlc3RTY2hlbWEuZW50aXRpZXNbYWN0dWFsRGVzdEVudGl0eU5hbWVdOyBcbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBhY3R1YWxEZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGRlc3RFbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsIGBFbXB0eSBrZXkgZmllbGQuIEVudGl0eTogJHtkZXN0RW50aXR5TmFtZX1gOyBcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiYnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUvbWFueSB0byBvbmUvbWFueSByZWxhdGlvblxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogcmVtb3RlRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogcmVtb3RlRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHR5cGVvZiByZW1vdGVGaWVsZCA9PT0gJ3N0cmluZycgPyB7IGZpZWxkOiByZW1vdGVGaWVsZCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgIFxuICAgICAgICAgICAgICAgICAgICAvLyBzZW1pIGFzc29jaWF0aW9uIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkgPyBhc3NvYy5ieS5zcGxpdCgnLicpIDogWyBPb2xVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuIERldGFpbDogJyArIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmM6IGVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3Q6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiBhc3NvYy5zcmNGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDEtd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZykpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQgYnkgY29ubmVjdGlvbiwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcpOyAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIHdlZWsgcmVmZXJlbmNlOiAke3RhZ31gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBkZXN0S2V5RmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RW50aXR5LmtleSkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8vZm9yZWlnbiBrZXkgY29uc3RyYWl0c1xuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkT2JqID0gZW50aXR5LmZpZWxkc1tsb2NhbEZpZWxkXTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBjb25zdHJhaW50cyA9IHt9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25VcGRhdGU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gbG9jYWxGaWVsZE9iai5jb25zdHJhaW50T25EZWxldGU7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdSRVNUUklDVCcpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnUkVTVFJJQ1QnKTtcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAobG9jYWxGaWVsZE9iai5vcHRpb25hbCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnU0VUIE5VTEwnKTtcbiAgICAgICAgICAgICAgICAgICAgY29uc3RyYWludHMub25EZWxldGUgfHwgKGNvbnN0cmFpbnRzLm9uRGVsZXRlID0gJ1NFVCBOVUxMJyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgY29uc3RyYWludHMub25VcGRhdGUgfHwgKGNvbnN0cmFpbnRzLm9uVXBkYXRlID0gJ05PIEFDVElPTicpO1xuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdOTyBBQ1RJT04nKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnIT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRuZSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ1VuYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGxldCBhcmc7XG5cbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJGVxJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07IFxuXG4gICAgICAgICAgICAgICAgY2FzZSAnaXMtbm90LW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRuZSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgXG5cbiAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBVbmFyeUV4cHJlc3Npb24gb3BlcmF0b3I6ICcgKyBvb2xDb24ub3BlcmF0b3IpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnTG9naWNhbEV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2FuZCc6XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGNhc2UgJ29yJzpcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB7ICRvcjogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmTmFtZSA9IFsgdHJhbnNsYXRlZCwgLi4ub3RoZXIgXS5qb2luKCcuJyk7XG5cbiAgICAgICAgaWYgKGFzS2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVmTmFtZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShyZWZOYW1lKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkLCBjb25zdHJhaW50cyk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBsZWZ0RmllbGQgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmVmczRMZWZ0RW50aXR5ID0gW107XG4gICAgICAgICAgICB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdID0gcmVmczRMZWZ0RW50aXR5O1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgbGV0IGZvdW5kID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkICYmIGl0ZW0ucmlnaHQgPT09IHJpZ2h0ICYmIGl0ZW0ucmlnaHRGaWVsZCA9PT0gcmlnaHRGaWVsZClcbiAgICAgICAgICAgICk7XG4gICAgXG4gICAgICAgICAgICBpZiAoZm91bmQpIHJldHVybjtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgcmVmczRMZWZ0RW50aXR5LnB1c2goe2xlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzIH0pOyBcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlT2ZGaWVsZChsZWZ0LCBsZWZ0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLmxlZnRGaWVsZCA9PT0gbGVmdEZpZWxkKVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZ2V0UmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApO1xuXG4gICAgICAgIGlmICghcmVmZXJlbmNlKSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlZmVyZW5jZTtcbiAgICB9XG5cbiAgICBfaGFzUmVmZXJlbmNlQmV0d2VlbihsZWZ0LCByaWdodCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ucmlnaHQgPT09IHJpZ2h0KVxuICAgICAgICApKTtcbiAgICB9XG5cbiAgICBfZmVhdHVyZVJlZHVjZXIoc2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmVhdHVyZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZlYXR1cmUuc3RhcnRGcm9tO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjcmVhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc0NyZWF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3VwZGF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzVXBkYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbG9naWNhbERlbGV0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYXRMZWFzdE9uZU5vdE51bGwnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd2YWxpZGF0ZUFsbEZpZWxkc09uQ3JlYXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdzdGF0ZVRyYWNraW5nJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnaTE4bic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NoYW5nZUxvZyc6XG4gICAgICAgICAgICAgICAgbGV0IGNoYW5nZUxvZ1NldHRpbmdzID0gVXRpbC5nZXRWYWx1ZUJ5UGF0aChzY2hlbWEuZGVwbG95bWVudFNldHRpbmdzLCAnZmVhdHVyZXMuY2hhbmdlTG9nJyk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBcImNoYW5nZUxvZ1wiIGZlYXR1cmUgc2V0dGluZ3MgaW4gZGVwbG95bWVudCBjb25maWcgZm9yIHNjaGVtYSBbJHtzY2hlbWEubmFtZX1dLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MuZGF0YVNvdXJjZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY2hhbmdlTG9nLmRhdGFTb3VyY2VcIiBpcyByZXF1aXJlZC4gU2NoZW1hOiAke3NjaGVtYS5uYW1lfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oZmVhdHVyZSwgY2hhbmdlTG9nU2V0dGluZ3MpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnYXV0b0lkJywgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGluZGV4ZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwiZmllbGRzXCI6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXSxcbiAgICAgICAgICAgICAgICAgICAgXCJ1bmlxdWVcIjogdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBhc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkxTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkxUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTJOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTJSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IHJlbGF0aW9uRW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTIgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTJOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQyIFxuICAgICAqL1xuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgIFxuICAgICAgICAgICAgLy8gY2hlY2sgaWYgdGhlIHJlbGF0aW9uIGVudGl0eSBoYXMgdGhlIHJlZmVyc1RvIGJvdGggc2lkZSBvZiBhc3NvY2lhdGlvbnMgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MU5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgLy95ZXMsIGRvbid0IG5lZWQgdG8gYWRkIHJlZmVyc1RvIHRvIHRoZSByZWxhdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFnMSA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTFOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZH1gO1xuICAgICAgICBsZXQgdGFnMiA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTJOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZDJ9YDtcblxuICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSkge1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpO1xuXG4gICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICBcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMn1gKTtcblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTFOYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTJOYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBrZXlFbnRpdHkxKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Miwga2V5RW50aXR5Mik7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkxTmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTJOYW1lIH1cbiAgICAgICAgKTtcblxuICAgICAgICBsZXQgYWxsQ2FzY2FkZSA9IHsgb25VcGRhdGU6ICdSRVNUUklDVCcsIG9uRGVsZXRlOiAnUkVTVFJJQ1QnIH07XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSwgYWxsQ2FzY2FkZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lLCBhbGxDYXNjYWRlKTsgICAgICAgIFxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICAvKlxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfSovXG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5LyosIG1hcE9mRW50aXR5TmFtZVRvQ29kZU5hbWUqLykge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uLCBzY2hlbWFUb0Nvbm5lY3Rvci8qLCBtYXBPZkVudGl0eU5hbWVUb0NvZGVOYW1lKi8pIHtcbiAgICAgICAgbGV0IHJlZlRhYmxlID0gcmVsYXRpb24ucmlnaHQ7XG5cbiAgICAgICAgaWYgKHJlZlRhYmxlLmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIHJlZkVudGl0eU5hbWUgXSA9IHJlZlRhYmxlLnNwbGl0KCcuJyk7ICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRDb25uZWN0b3IgPSBzY2hlbWFUb0Nvbm5lY3RvcltzY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGFzc2VydDogdGFyZ2V0Q29ubmVjdG9yO1xuXG4gICAgICAgICAgICByZWZUYWJsZSA9IHRhcmdldENvbm5lY3Rvci5kYXRhYmFzZSArICdgLmAnICsgcmVmRW50aXR5TmFtZTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWZUYWJsZSArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gYE9OIFVQREFURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uVXBkYXRlfSBPTiBERUxFVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vbkRlbGV0ZX07XFxuYDtcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19