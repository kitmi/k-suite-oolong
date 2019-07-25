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
          constraints.onUpdate || (constraints.onUpdate = 'CASCADE');
          constraints.onDelete || (constraints.onDelete = 'CASCADE');
        } else if (localFieldObj.optional) {
          constraints.onUpdate || (constraints.onUpdate = 'CASCADE');
          constraints.onDelete || (constraints.onDelete = 'SET NULL');
        }

        constraints.onUpdate || (constraints.onUpdate = 'RESTRICT');
        constraints.onDelete || (constraints.onDelete = 'RESTRICT');

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
        console.log(schema.deploymentSettings);
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
      onUpdate: 'CASCADE',
      onDelete: 'CASCADE'
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
      let [schemaName, entityName] = refTable.split('.');
      let targetConnector = schemaToConnector[schemaName];

      if (!targetConnector) {
        throw new Error("Assertion failed: targetConnector");
      }

      refTable = targetConnector.database + '`.`' + entityName;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInplcm9Jbml0RmlsZSIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJjb25zb2xlIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJpbml0SWR4RmlsZUNvbnRlbnQiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lIiwiZGVzdFNjaGVtYU5hbWUiLCJhY3R1YWxEZXN0RW50aXR5TmFtZSIsImRlc3RTY2hlbWEiLCJzY2hlbWFzIiwibGlua2VkIiwiZW5zdXJlR2V0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjYiIsInNwbGl0IiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsImxpc3QiLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwidGFnIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJsb2NhbEZpZWxkT2JqIiwiY29uc3RyYWludHMiLCJjb25zdHJhaW50T25VcGRhdGUiLCJvblVwZGF0ZSIsImNvbnN0cmFpbnRPbkRlbGV0ZSIsIm9uRGVsZXRlIiwib3B0aW9uYWwiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZGVwbG95bWVudFNldHRpbmdzIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRhdGFTb3VyY2UiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxTmFtZSIsImVudGl0eTJOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImluZGV4ZXMiLCJsaW5rIiwiYWRkRW50aXR5IiwicmVsYXRpb25FbnRpdHkiLCJlbnRpdHkxIiwiZW50aXR5MiIsImhhc1JlZlRvRW50aXR5MSIsImhhc1JlZlRvRW50aXR5MiIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwiYWxsQ2FzY2FkZSIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXgiLCJ1bmlxdWUiLCJsaW5lcyIsInN1YnN0ciIsImV4dHJhUHJvcHMiLCJwcm9wcyIsInJlbGF0aW9uIiwicmVmVGFibGUiLCJzY2hlbWFOYW1lIiwidGFyZ2V0Q29ubmVjdG9yIiwiZm9yZWlnbktleUZpZWxkTmFtaW5nIiwibGVmdFBhcnQiLCJjYW1lbENhc2UiLCJyaWdodFBhcnQiLCJwYXNjYWxDYXNlIiwiZW5kc1dpdGgiLCJxdW90ZVN0cmluZyIsInN0ciIsInJlcGxhY2UiLCJvYmoiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJ2YWx1ZXMiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFFQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUcsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBO0FBQVQsSUFBbUJILElBQXpCOztBQUVBLE1BQU1JLFFBQVEsR0FB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LENBQUMsQ0FBQzhULElBQUYsQ0FBTzlULENBQUMsQ0FBQytULFNBQUYsQ0FBWXBSLFVBQVosQ0FBUCxDQUFiO0FBRUFrUixNQUFBQSxpQkFBaUIsR0FBRzdULENBQUMsQ0FBQ2dVLE9BQUYsQ0FBVWhVLENBQUMsQ0FBQytULFNBQUYsQ0FBWUYsaUJBQVosQ0FBVixFQUEwQyxHQUExQyxJQUFpRCxHQUFyRTs7QUFFQSxVQUFJN1QsQ0FBQyxDQUFDaVUsVUFBRixDQUFhdFIsVUFBYixFQUF5QmtSLGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDbFIsUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUN3TyxNQUFYLENBQWtCMEMsaUJBQWlCLENBQUNuUixNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPdkMsUUFBUSxDQUFDbUosWUFBVCxDQUFzQjNHLFVBQXRCLENBQVA7QUFDSDs7QUFuOUNjOztBQXM5Q25CdVIsTUFBTSxDQUFDQyxPQUFQLEdBQWlCeFQsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplLCBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSB9ID0gT29sVXRpbHM7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEsIHNjaGVtYVRvQ29ubmVjdG9yKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IHBlbmRpbmdFbnRpdGllcyA9IE9iamVjdC5rZXlzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICB3aGlsZSAocGVuZGluZ0VudGl0aWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxldCBlbnRpdHlOYW1lID0gcGVuZGluZ0VudGl0aWVzLnNoaWZ0KCk7XG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gbW9kZWxpbmdTY2hlbWEuZW50aXRpZXNbZW50aXR5TmFtZV07XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHsgIFxuICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgUHJvY2Vzc2luZyBhc3NvY2lhdGlvbnMgb2YgZW50aXR5IFwiJHtlbnRpdHlOYW1lfVwiLi4uYCk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBjb25zdCB6ZXJvSW5pdEZpbGUgPSAnMC1pbml0Lmpzb24nO1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsIHplcm9Jbml0RmlsZSk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhlbnRpdHkuaW5mby5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYsIHNjaGVtYVRvQ29ubmVjdG9yKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBsZXQgaW5pdElkeEZpbGVDb250ZW50O1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpbml0SWR4RmlsZUNvbnRlbnQgPSB6ZXJvSW5pdEZpbGUgKyAnXFxuJzsgICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIC8vbm8gZGF0YSBlbnRyeVxuICAgICAgICAgICAgaW5pdElkeEZpbGVDb250ZW50ID0gJyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCBpbml0SWR4RmlsZUNvbnRlbnQpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgXCIke2VudGl0eS5uYW1lfVwiICR7SlNPTi5zdHJpbmdpZnkoYXNzb2MpfWApOyBcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5LCBkZXN0RW50aXR5LCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgLy9jcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgICAgIGxldCBbIGRlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZSBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXN0U2NoZW1hID0gc2NoZW1hLmxpbmtlci5zY2hlbWFzW2Rlc3RTY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGlmICghZGVzdFNjaGVtYS5saW5rZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBkZXN0U2NoZW1hLmVudGl0aWVzW2FjdHVhbERlc3RFbnRpdHlOYW1lXTsgXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBkZXN0RW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gZGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gICBcbiAgICAgICAgIFxuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogZGVzdEtleUZpZWxkLCBgRW1wdHkga2V5IGZpZWxkLiBFbnRpdHk6ICR7ZGVzdEVudGl0eU5hbWV9YDsgXG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5ieS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy53aXRoID0gYXNzb2Mud2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb25lL21hbnkgdG8gb25lL21hbnkgcmVsYXRpb25cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogcmVtb3RlRmllbGROYW1lIH0sIGRlc3RFbnRpdHkua2V5LCByZW1vdGVGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBiYWNrUmVmLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQyLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGJhY2tSZWYud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzJ9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSkgOiBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkID0gYXNzb2MucmVtb3RlRmllbGQgfHwgYmFja1JlZi5zcmNGaWVsZCB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvciwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LCAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IC4uLmFzc29jTmFtZXMsIFtkZXN0RW50aXR5TmFtZV06IGFuY2hvciB9LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkua2V5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IHJlbW90ZUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IHJlbW90ZUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLih0eXBlb2YgcmVtb3RlRmllbGQgPT09ICdzdHJpbmcnID8geyBmaWVsZDogcmVtb3RlRmllbGQgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICBcbiAgICAgICAgICAgICAgICAgICAgLy8gc2VtaSBhc3NvY2lhdGlvbiBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5ID8gYXNzb2MuYnkuc3BsaXQoJy4nKSA6IFsgT29sVXRpbHMucHJlZml4TmFtaW5nKGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSkgXTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vY3JlYXRlIGFcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcGVuZGluZ0VudGl0aWVzLnB1c2goY29ubkVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgLy90b2RvOiBnZXQgYmFjayByZWYgZnJvbSBjb25uZWN0aW9uIGVudGl0eVxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYxID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nLCBzcmNGaWVsZDogKGYpID0+IF8uaXNOaWwoZikgfHwgZiA9PSBjb25uZWN0ZWRCeUZpZWxkIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYxKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtlbnRpdHkubmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkJhY2tSZWYyID0gY29ubkVudGl0eS5nZXRSZWZlcmVuY2VUbyhkZXN0RW50aXR5TmFtZSwgeyB0eXBlOiAncmVmZXJzVG8nIH0sIHsgYXNzb2NpYXRpb246IGNvbm5CYWNrUmVmMSAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2Rlc3RFbnRpdHlOYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gY29ubkJhY2tSZWYyLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAxLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnID0gYCR7ZW50aXR5Lm5hbWV9OjEtJHtkZXN0RW50aXR5TmFtZX06KiAke2xvY2FsRmllbGR9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkIGJ5IGNvbm5lY3Rpb24sIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnKTsgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCB3ZWVrIHJlZmVyZW5jZTogJHt0YWd9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgZGVzdEtleUZpZWxkLCBhc3NvYy5maWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgb246IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShsb2NhbEZpZWxkICsgJy4nICsgZGVzdEVudGl0eS5rZXkpIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAvL2ZvcmVpZ24ga2V5IGNvbnN0cmFpdHNcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE9iaiA9IGVudGl0eS5maWVsZHNbbG9jYWxGaWVsZF07ICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgY29uc3RyYWludHMgPSB7fTtcblxuICAgICAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPblVwZGF0ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSA9IGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uVXBkYXRlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkT2JqLmNvbnN0cmFpbnRPbkRlbGV0ZSkge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSA9IGxvY2FsRmllbGRPYmouY29uc3RyYWludE9uRGVsZXRlO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vblVwZGF0ZSB8fCAoY29uc3RyYWludHMub25VcGRhdGUgPSAnQ0FTQ0FERScpO1xuICAgICAgICAgICAgICAgICAgICBjb25zdHJhaW50cy5vbkRlbGV0ZSB8fCAoY29uc3RyYWludHMub25EZWxldGUgPSAnQ0FTQ0FERScpO1xuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChsb2NhbEZpZWxkT2JqLm9wdGlvbmFsKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdDQVNDQURFJyk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdTRVQgTlVMTCcpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uVXBkYXRlIHx8IChjb25zdHJhaW50cy5vblVwZGF0ZSA9ICdSRVNUUklDVCcpO1xuICAgICAgICAgICAgICAgIGNvbnN0cmFpbnRzLm9uRGVsZXRlIHx8IChjb25zdHJhaW50cy5vbkRlbGV0ZSA9ICdSRVNUUklDVCcpO1xuXG4gICAgICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGVudGl0eS5uYW1lLCBsb2NhbEZpZWxkLCBkZXN0RW50aXR5TmFtZSwgZGVzdEtleUZpZWxkLm5hbWUsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICchPScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJG5lJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZztcblxuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckZXEnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgXG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJG5lJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07ICAgICBcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogJyArIG9vbENvbi5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdMb2dpY2FsRXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIHN3aXRjaCAob29sQ29uLm9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnYW5kJzpcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5sZWZ0KSwgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ucmlnaHQpIF0gfTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgY2FzZSAnb3InOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHsgJG9yOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIHN5bnRheDogJyArIEpTT04uc3RyaW5naWZ5KG9vbENvbikpO1xuICAgIH1cblxuICAgIF90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmVmLCBhc0tleSkge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgbGVmdEZpZWxkLmZvckVhY2gobGYgPT4gdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxmLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQsIGNvbnN0cmFpbnRzKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCwgY29uc3RyYWludHMgfSk7IFxuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhzY2hlbWEuZGVwbG95bWVudFNldHRpbmdzKTtcblxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgJ2ZlYXR1cmVzLmNoYW5nZUxvZycpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgXCJjaGFuZ2VMb2dcIiBmZWF0dXJlIHNldHRpbmdzIGluIGRlcGxveW1lbnQgY29uZmlnIGZvciBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzLmRhdGFTb3VyY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNoYW5nZUxvZy5kYXRhU291cmNlXCIgaXMgcmVxdWlyZWQuIFNjaGVtYTogJHtzY2hlbWEubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGZlYXR1cmUsIGNoYW5nZUxvZ1NldHRpbmdzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2F1dG9JZCcsICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBpbmRleGVzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcImZpZWxkc1wiOiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF0sXG4gICAgICAgICAgICAgICAgICAgIFwidW5pcXVlXCI6IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5MU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MVJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkyUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSByZWxhdGlvbkVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MU5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkMiBcbiAgICAgKi9cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICBcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIHRoZSByZWxhdGlvbiBlbnRpdHkgaGFzIHRoZSByZWZlcnNUbyBib3RoIHNpZGUgb2YgYXNzb2NpYXRpb25zICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5lYWNoKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCBhc3NvYyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MU5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTFOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5Mk5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIC8veWVzLCBkb24ndCBuZWVkIHRvIGFkZCByZWZlcnNUbyB0byB0aGUgcmVsYXRpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRhZzEgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkxTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGR9YDtcbiAgICAgICAgbGV0IHRhZzIgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkyTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGQyfWA7XG5cbiAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkpIHtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKTtcblxuICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgIFxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxTmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MU5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyTmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgbGV0IGFsbENhc2NhZGUgPSB7IG9uVXBkYXRlOiAnQ0FTQ0FERScsIG9uRGVsZXRlOiAnQ0FTQ0FERScgfTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lLCBhbGxDYXNjYWRlKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUsIGFsbENhc2NhZGUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbiwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgbGV0IHJlZlRhYmxlID0gcmVsYXRpb24ucmlnaHQ7XG5cbiAgICAgICAgaWYgKHJlZlRhYmxlLmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IHJlZlRhYmxlLnNwbGl0KCcuJyk7ICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRDb25uZWN0b3IgPSBzY2hlbWFUb0Nvbm5lY3RvcltzY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGFzc2VydDogdGFyZ2V0Q29ubmVjdG9yO1xuXG4gICAgICAgICAgICByZWZUYWJsZSA9IHRhcmdldENvbm5lY3Rvci5kYXRhYmFzZSArICdgLmAnICsgZW50aXR5TmFtZTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWZUYWJsZSArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gYE9OIFVQREFURSAke3JlbGF0aW9uLmNvbnN0cmFpbnRzLm9uVXBkYXRlfSBPTiBERUxFVEUgJHtyZWxhdGlvbi5jb25zdHJhaW50cy5vbkRlbGV0ZX07XFxuYDtcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19