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
        throw new Error("Assertion failed: destEntity");
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

          this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, destEntityNameAsFieldName);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJjb25zb2xlIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lIiwiZGVzdFNjaGVtYU5hbWUiLCJhY3R1YWxEZXN0RW50aXR5TmFtZSIsImRlc3RTY2hlbWEiLCJzY2hlbWFzIiwibGlua2VkIiwiZW5zdXJlR2V0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjYiIsInNwbGl0IiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsImxpc3QiLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwidGFnIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFyZyIsImFyZ3VtZW50IiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJsZiIsInJlZnM0TGVmdEVudGl0eSIsImZvdW5kIiwiZmluZCIsIml0ZW0iLCJfZ2V0UmVmZXJlbmNlT2ZGaWVsZCIsInJlZmVyZW5jZSIsIl9oYXNSZWZlcmVuY2VPZkZpZWxkIiwiX2dldFJlZmVyZW5jZUJldHdlZW4iLCJfaGFzUmVmZXJlbmNlQmV0d2VlbiIsImZlYXR1cmUiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZGVwbG95bWVudFNldHRpbmdzIiwiY2hhbmdlTG9nU2V0dGluZ3MiLCJnZXRWYWx1ZUJ5UGF0aCIsImRhdGFTb3VyY2UiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxTmFtZSIsImVudGl0eTJOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImluZGV4ZXMiLCJsaW5rIiwiYWRkRW50aXR5IiwicmVsYXRpb25FbnRpdHkiLCJlbnRpdHkxIiwiZW50aXR5MiIsImhhc1JlZlRvRW50aXR5MSIsImhhc1JlZlRvRW50aXR5MiIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0IiwiY29sdW1uRGVmaW5pdGlvbiIsInF1b3RlTGlzdE9yVmFsdWUiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJ0YXJnZXRDb25uZWN0b3IiLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsInZhbHVlcyIsImhhc093blByb3BlcnR5Iiwib3B0aW9uYWwiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxZQUFZLEdBQUdDLE9BQU8sQ0FBQyxRQUFELENBQTVCOztBQUNBLE1BQU1DLElBQUksR0FBR0QsT0FBTyxDQUFDLE1BQUQsQ0FBcEI7O0FBRUEsTUFBTUUsSUFBSSxHQUFHRixPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVHLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQTtBQUFULElBQW1CSCxJQUF6Qjs7QUFFQSxNQUFNSSxRQUFRLEdBQUdOLE9BQU8sQ0FBQyx3QkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLFNBQUY7QUFBYUMsRUFBQUEsaUJBQWI7QUFBZ0NDLEVBQUFBO0FBQWhDLElBQTJESCxRQUFqRTs7QUFDQSxNQUFNSSxNQUFNLEdBQUdWLE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7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QVA7QUFDSDs7QUFFRCxTQUFPNEQscUJBQVAsQ0FBNkJ2USxVQUE3QixFQUF5Q3dRLGlCQUF6QyxFQUE0RDtBQUN4RCxRQUFJQSxpQkFBSixFQUF1QjtBQUNuQnhRLE1BQUFBLFVBQVUsR0FBRzNDLENBQUMsQ0FBQ29ULElBQUYsQ0FBT3BULENBQUMsQ0FBQ3FULFNBQUYsQ0FBWTFRLFVBQVosQ0FBUCxDQUFiO0FBRUF3USxNQUFBQSxpQkFBaUIsR0FBR25ULENBQUMsQ0FBQ3NULE9BQUYsQ0FBVXRULENBQUMsQ0FBQ3FULFNBQUYsQ0FBWUYsaUJBQVosQ0FBVixFQUEwQyxHQUExQyxJQUFpRCxHQUFyRTs7QUFFQSxVQUFJblQsQ0FBQyxDQUFDdVQsVUFBRixDQUFhNVEsVUFBYixFQUF5QndRLGlCQUF6QixDQUFKLEVBQWlEO0FBQzdDeFEsUUFBQUEsVUFBVSxHQUFHQSxVQUFVLENBQUM2TixNQUFYLENBQWtCMkMsaUJBQWlCLENBQUN6USxNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPdkMsUUFBUSxDQUFDaUosWUFBVCxDQUFzQnpHLFVBQXRCLENBQVA7QUFDSDs7QUE5NkNjOztBQWk3Q25CNlEsTUFBTSxDQUFDQyxPQUFQLEdBQWlCOVMsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IHsgcGx1cmFsaXplLCBpc0RvdFNlcGFyYXRlTmFtZSwgZXh0cmFjdERvdFNlcGFyYXRlTmFtZSB9ID0gT29sVXRpbHM7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgcGVuZGluZ0VudGl0aWVzID0gT2JqZWN0LmtleXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eU5hbWUgPSBwZW5kaW5nRW50aXRpZXMuc2hpZnQoKTtcbiAgICAgICAgICAgIGxldCBlbnRpdHkgPSBtb2RlbGluZ1NjaGVtYS5lbnRpdGllc1tlbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkgeyAgXG4gICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIGFzc29jaWF0aW9ucyBvZiBlbnRpdHkgXCIke2VudGl0eU5hbWV9XCIuLi5gKTsgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhlbnRpdHkuaW5mby5kYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYsIHNjaGVtYVRvQ29ubmVjdG9yKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF90b0NvbHVtblJlZmVyZW5jZShuYW1lKSB7XG4gICAgICAgIHJldHVybiB7IG9vclR5cGU6ICdDb2x1bW5SZWZlcmVuY2UnLCBuYW1lIH07ICBcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICBsZXQgcmV0ID0geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkLmJ5KSB9O1xuICAgICAgICAgICAgbGV0IHdpdGhFeHRyYSA9IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgcmVtb3RlRmllbGQud2l0aCk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChsb2NhbEZpZWxkIGluIHdpdGhFeHRyYSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB7ICRhbmQ6IFsgcmV0LCB3aXRoRXh0cmEgXSB9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4geyAuLi5yZXQsIC4uLndpdGhFeHRyYSB9O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZCkgfTtcbiAgICB9XG5cbiAgICBfZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoIXJlbW90ZUZpZWxkKSByZXR1cm4gdW5kZWZpbmVkO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLm1hcChyZiA9PiB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkLmJ5O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlbW90ZUZpZWxkO1xuICAgIH1cblxuICAgIF9wcmVQcm9jZXNzQXNzb2NpYXRpb25zKGVudGl0eSkge1xuICAgICAgICByZXR1cm4gZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLm1hcChhc3NvYyA9PiB7XG4gICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHJldHVybiBhc3NvYy5zcmNGaWVsZDtcblxuICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55Jykge1xuICAgICAgICAgICAgICAgIHJldHVybiBwbHVyYWxpemUoYXNzb2MuZGVzdEVudGl0eSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGJlbG9uZ3NUbyAgICAgIFxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gaGFzTWFueS9oYXNPbmUgW2J5XSBbd2l0aF1cbiAgICAgKiBoYXNNYW55IC0gc2VtaSBjb25uZWN0aW9uICAgICAgIFxuICAgICAqIHJlZmVyc1RvIC0gc2VtaSBjb25uZWN0aW9uXG4gICAgICogICAgICBcbiAgICAgKiByZW1vdGVGaWVsZDpcbiAgICAgKiAgIDEuIGZpZWxkTmFtZVxuICAgICAqICAgMi4gYXJyYXkgb2YgZmllbGROYW1lXG4gICAgICogICAzLiB7IGJ5ICwgd2l0aCB9XG4gICAgICogICA0LiBhcnJheSBvZiBmaWVsZE5hbWUgYW5kIHsgYnkgLCB3aXRoIH0gbWl4ZWRcbiAgICAgKiAgXG4gICAgICogQHBhcmFtIHsqfSBzY2hlbWEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBhc3NvYyBcbiAgICAgKi9cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgXCIke2VudGl0eS5uYW1lfVwiICR7SlNPTi5zdHJpbmdpZnkoYXNzb2MpfWApOyBcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5LCBkZXN0RW50aXR5LCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuICAgICAgICBcbiAgICAgICAgaWYgKGlzRG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKSkge1xuICAgICAgICAgICAgLy9jcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgICAgIGxldCBbIGRlc3RTY2hlbWFOYW1lLCBhY3R1YWxEZXN0RW50aXR5TmFtZSBdID0gZXh0cmFjdERvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgIGxldCBkZXN0U2NoZW1hID0gc2NoZW1hLmxpbmtlci5zY2hlbWFzW2Rlc3RTY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGlmICghZGVzdFNjaGVtYS5saW5rZWQpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFRoZSBkZXN0aW5hdGlvbiBzY2hlbWEgJHtkZXN0U2NoZW1hTmFtZX0gaGFzIG5vdCBiZWVuIGxpbmtlZCB5ZXQuIEN1cnJlbnRseSBvbmx5IHN1cHBvcnQgb25lLXdheSByZWZlcmVuY2UgZm9yIGNyb3NzIGRiIHJlbGF0aW9uLmApXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBkZXN0U2NoZW1hLmVudGl0aWVzW2FjdHVhbERlc3RFbnRpdHlOYW1lXTsgXG4gICAgICAgICAgICBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lID0gYWN0dWFsRGVzdEVudGl0eU5hbWU7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBkZXN0RW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgIGFzc2VydDogZGVzdEVudGl0eTtcblxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZCwgYEVtcHR5IGtleSBmaWVsZC4gRW50aXR5OiAke2Rlc3RFbnRpdHlOYW1lfWA7IFxuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgIHR5cGVzOiBbICdyZWZlcnNUbycgXSwgXG4gICAgICAgICAgICAgICAgICAgIGFzc29jaWF0aW9uOiBhc3NvYyBcbiAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBieTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuYnkuc3BsaXQoJy4nKVswXSBcbiAgICAgICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Mud2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMud2l0aCA9IGFzc29jLndpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKGFzc29jLnJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogcmVtb3RlRmllbGQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkIHx8IChyZW1vdGVGaWVsZCA9IGVudGl0eS5uYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBfLmlzTmlsKHJlbW90ZUZpZWxkcykgfHwgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGRzKSA/IHJlbW90ZUZpZWxkcy5pbmRleE9mKHJlbW90ZUZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSByZW1vdGVGaWVsZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICB9OyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIGluY2x1ZGVzLCBleGNsdWRlcyk7XG4gICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknIHx8IGJhY2tSZWYudHlwZSA9PT0gJ2hhc09uZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wibTJuXCIgYXNzb2NpYXRpb24gcmVxdWlyZXMgXCJieVwiIHByb3BlcnR5LiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcgZGVzdGluYXRpb246ICcgKyBkZXN0RW50aXR5TmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9uZS9tYW55IHRvIG9uZS9tYW55IHJlbGF0aW9uXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gY29ubmVjdGVkIGJ5IGZpZWxkIGlzIHVzdWFsbHkgYSByZWZlcnNUbyBhc3NvY1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lOyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGJhY2tSZWYuc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcyICs9ICcgJyArIGJhY2tSZWYuc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpIHx8IHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzMiA9IGJhY2tSZWYuYnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IChjb25uZWN0ZWRCeVBhcnRzMi5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHMyWzFdKSB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGROYW1lID0gYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpOyAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IHJlbW90ZUZpZWxkTmFtZSB9LCBkZXN0RW50aXR5LmtleSwgcmVtb3RlRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBiYWNrUmVmLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgMi13YXkgcmVmZXJlbmNlOiAke3RhZzF9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcyfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gYnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBhbmNob3IgPSBhc3NvYy5zcmNGaWVsZCB8fCAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpIDogZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZCA9IGFzc29jLnJlbW90ZUZpZWxkIHx8IGJhY2tSZWYuc3JjRmllbGQgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhbmNob3IsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBkZXN0RW50aXR5LmtleSwgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgeyAuLi5hc3NvY05hbWVzLCBbZGVzdEVudGl0eU5hbWVdOiBhbmNob3IgfSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmtleSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLndpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiByZW1vdGVGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2NyZWF0ZSBhXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHBlbmRpbmdFbnRpdGllcy5wdXNoKGNvbm5FbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYE5ldyBlbnRpdHkgXCIke2Nvbm5FbnRpdHkubmFtZX1cIiBhZGRlZCBieSBhc3NvY2lhdGlvbi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIC8vdG9kbzogZ2V0IGJhY2sgcmVmIGZyb20gY29ubmVjdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMSA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJywgc3JjRmllbGQ6IChmKSA9PiBfLmlzTmlsKGYpIHx8IGYgPT0gY29ubmVjdGVkQnlGaWVsZCB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZW50aXR5Lm5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5CYWNrUmVmMiA9IGNvbm5FbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZGVzdEVudGl0eU5hbWUsIHsgdHlwZTogJ3JlZmVyc1RvJyB9LCB7IGFzc29jaWF0aW9uOiBjb25uQmFja1JlZjEgIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkJhY2tSZWYyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENhbm5vdCBmaW5kIGJhY2sgcmVmZXJlbmNlIHRvIFwiJHtkZXN0RW50aXR5TmFtZX1cIiBmcm9tIHJlbGF0aW9uIGVudGl0eSBcIiR7Y29ubkVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGNvbm5CYWNrUmVmMi5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4gRGV0YWlsOiAnICsgSlNPTi5zdHJpbmdpZnkoe1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyYzogZW50aXR5Lm5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVzdDogZGVzdEVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IGFzc29jLnNyY0ZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9KSk7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgKSAsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDEtd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZykpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQgYnkgY29ubmVjdGlvbiwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcpOyAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIHdlZWsgcmVmZXJlbmNlOiAke3RhZ31gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBkZXN0S2V5RmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RW50aXR5LmtleSkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICchPScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJG5lJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZztcblxuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckZXEnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgXG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJG5lJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07ICAgICBcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogJyArIG9vbENvbi5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZk5hbWUgPSBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuXG4gICAgICAgIGlmIChhc0tleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZk5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UocmVmTmFtZSk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgbGVmdEZpZWxkID09PSAnc3RyaW5nJztcblxuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKHNjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZmVhdHVyZSkge1xuICAgICAgICBsZXQgZmllbGQ7XG5cbiAgICAgICAgc3dpdGNoIChmZWF0dXJlTmFtZSkge1xuICAgICAgICAgICAgY2FzZSAnYXV0b0lkJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG5cbiAgICAgICAgICAgICAgICBpZiAoZmllbGQudHlwZSA9PT0gJ2ludGVnZXInICYmICFmaWVsZC5nZW5lcmF0b3IpIHtcbiAgICAgICAgICAgICAgICAgICAgZmllbGQuYXV0b0luY3JlbWVudElkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCdzdGFydEZyb20nIGluIGZlYXR1cmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmZWF0dXJlLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdjaGFuZ2VMb2cnOlxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKHNjaGVtYS5kZXBsb3ltZW50U2V0dGluZ3MpO1xuXG4gICAgICAgICAgICAgICAgbGV0IGNoYW5nZUxvZ1NldHRpbmdzID0gVXRpbC5nZXRWYWx1ZUJ5UGF0aChzY2hlbWEuZGVwbG95bWVudFNldHRpbmdzLCAnZmVhdHVyZXMuY2hhbmdlTG9nJyk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzKSB7XG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyBcImNoYW5nZUxvZ1wiIGZlYXR1cmUgc2V0dGluZ3MgaW4gZGVwbG95bWVudCBjb25maWcgZm9yIHNjaGVtYSBbJHtzY2hlbWEubmFtZX1dLmApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghY2hhbmdlTG9nU2V0dGluZ3MuZGF0YVNvdXJjZSkge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY2hhbmdlTG9nLmRhdGFTb3VyY2VcIiBpcyByZXF1aXJlZC4gU2NoZW1hOiAke3NjaGVtYS5uYW1lfWApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIE9iamVjdC5hc3NpZ24oZmVhdHVyZSwgY2hhbmdlTG9nU2V0dGluZ3MpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQpIHtcbiAgICAgICAgbGV0IGVudGl0eUluZm8gPSB7XG4gICAgICAgICAgICBmZWF0dXJlczogWyAnYXV0b0lkJywgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGluZGV4ZXM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwiZmllbGRzXCI6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXSxcbiAgICAgICAgICAgICAgICAgICAgXCJ1bmlxdWVcIjogdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF0sXG4gICAgICAgICAgICBhc3NvY2lhdGlvbnM6IFtcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkxTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkxUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9LFxuICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgXCJ0eXBlXCI6IFwicmVmZXJzVG9cIixcbiAgICAgICAgICAgICAgICAgICAgXCJkZXN0RW50aXR5XCI6IGVudGl0eTJOYW1lLFxuICAgICAgICAgICAgICAgICAgICBcInNyY0ZpZWxkXCI6IGVudGl0eTJSZWZGaWVsZFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIF1cbiAgICAgICAgfTtcblxuICAgICAgICBsZXQgZW50aXR5ID0gbmV3IEVudGl0eSh0aGlzLmxpbmtlciwgcmVsYXRpb25FbnRpdHlOYW1lLCBzY2hlbWEub29sTW9kdWxlLCBlbnRpdHlJbmZvKTtcbiAgICAgICAgZW50aXR5LmxpbmsoKTtcblxuICAgICAgICBzY2hlbWEuYWRkRW50aXR5KGVudGl0eSk7XG5cbiAgICAgICAgcmV0dXJuIGVudGl0eTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IHJlbGF0aW9uRW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTIgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTJOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQyIFxuICAgICAqL1xuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgZW50aXR5MU5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTJOYW1lLyogZm9yIGNyb3NzIGRiICovLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgIFxuICAgICAgICAgICAgLy8gY2hlY2sgaWYgdGhlIHJlbGF0aW9uIGVudGl0eSBoYXMgdGhlIHJlZmVyc1RvIGJvdGggc2lkZSBvZiBhc3NvY2lhdGlvbnMgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MU5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgLy95ZXMsIGRvbid0IG5lZWQgdG8gYWRkIHJlZmVyc1RvIHRvIHRoZSByZWxhdGlvbiBlbnRpdHlcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgdGFnMSA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTFOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZH1gO1xuICAgICAgICBsZXQgdGFnMiA9IGAke3JlbGF0aW9uRW50aXR5TmFtZX06MS0ke2VudGl0eTJOYW1lfToqICR7Y29ubmVjdGVkQnlGaWVsZDJ9YDtcblxuICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSkge1xuICAgICAgICAgICAgYXNzZXJ0OiB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpO1xuXG4gICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkLCBza2lwXG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH0gICAgICAgICBcbiAgICAgICAgXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG5cbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICBcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCBicmlkZ2luZyByZWZlcmVuY2U6ICR7dGFnMn1gKTtcblxuICAgICAgICBsZXQga2V5RW50aXR5MSA9IGVudGl0eTEuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTFOYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTJOYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBrZXlFbnRpdHkxKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Miwga2V5RW50aXR5Mik7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkxTmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTJOYW1lIH1cbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxTmFtZSwga2V5RW50aXR5MS5uYW1lKTtcbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTJOYW1lLCBrZXlFbnRpdHkyLm5hbWUpOyAgICAgICAgXG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIC8qXG4gICAgX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCkge1xuICAgICAgICBsZXQgZW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2RvYy5lbnRpdHldO1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SW5kZXgrKyk7XG4gICAgICAgIGRvYy5hbGlhcyA9IGFsaWFzO1xuXG4gICAgICAgIGxldCBjb2xMaXN0ID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcykubWFwKGsgPT4gYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGspKTtcbiAgICAgICAgbGV0IGpvaW5zID0gW107XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZG9jLnN1YkRvY3VtZW50cykpIHtcbiAgICAgICAgICAgIF8uZm9yT3duKGRvYy5zdWJEb2N1bWVudHMsIChkb2MsIGZpZWxkTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgIGxldCBbIHN1YkNvbExpc3QsIHN1YkFsaWFzLCBzdWJKb2lucywgc3RhcnRJbmRleDIgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChzY2hlbWEsIGRvYywgc3RhcnRJbmRleCk7XG4gICAgICAgICAgICAgICAgc3RhcnRJbmRleCA9IHN0YXJ0SW5kZXgyO1xuICAgICAgICAgICAgICAgIGNvbExpc3QgPSBjb2xMaXN0LmNvbmNhdChzdWJDb2xMaXN0KTtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2lucy5wdXNoKCdMRUZUIEpPSU4gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBzdWJBbGlhc1xuICAgICAgICAgICAgICAgICAgICArICcgT04gJyArIGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZE5hbWUpICsgJyA9ICcgK1xuICAgICAgICAgICAgICAgICAgICBzdWJBbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmxpbmtXaXRoRmllbGQpKTtcblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHN1YkpvaW5zKSkge1xuICAgICAgICAgICAgICAgICAgICBqb2lucyA9IGpvaW5zLmNvbmNhdChzdWJKb2lucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyBjb2xMaXN0LCBhbGlhcywgam9pbnMsIHN0YXJ0SW5kZXggXTtcbiAgICB9Ki9cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbiwgc2NoZW1hVG9Db25uZWN0b3IpIHtcbiAgICAgICAgbGV0IHJlZlRhYmxlID0gcmVsYXRpb24ucmlnaHQ7XG5cbiAgICAgICAgaWYgKHJlZlRhYmxlLmluZGV4T2YoJy4nKSA+IDApIHtcbiAgICAgICAgICAgIGxldCBbIHNjaGVtYU5hbWUsIGVudGl0eU5hbWUgXSA9IHJlZlRhYmxlLnNwbGl0KCcuJyk7ICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCB0YXJnZXRDb25uZWN0b3IgPSBzY2hlbWFUb0Nvbm5lY3RvcltzY2hlbWFOYW1lXTtcbiAgICAgICAgICAgIGFzc2VydDogdGFyZ2V0Q29ubmVjdG9yO1xuXG4gICAgICAgICAgICByZWZUYWJsZSA9IHRhcmdldENvbm5lY3Rvci5kYXRhYmFzZSArICdgLmAnICsgZW50aXR5TmFtZTtcbiAgICAgICAgfSAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWZUYWJsZSArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19