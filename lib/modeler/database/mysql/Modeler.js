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

        this._addReference(entity.name, localField, destEntityName, destKeyField.name, assoc.type === 'belongsTo');

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

  _addReference(left, leftField, right, rightField, needCasade) {
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
      rightField,
      cascadeChange: needCasade
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

    if (this._relationEntities[entityName] || relation.cascadeChange) {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJrZXlzIiwiZW50aXRpZXMiLCJsZW5ndGgiLCJlbnRpdHlOYW1lIiwic2hpZnQiLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVhY2giLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJjb25zb2xlIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lIiwiZGVzdFNjaGVtYU5hbWUiLCJhY3R1YWxEZXN0RW50aXR5TmFtZSIsImRlc3RTY2hlbWEiLCJzY2hlbWFzIiwibGlua2VkIiwiZW5zdXJlR2V0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjYiIsInNwbGl0IiwicmVtb3RlRmllbGRzIiwiaXNOaWwiLCJpbmRleE9mIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwiaGFzIiwiY29ubmVjdGVkQnlQYXJ0czIiLCJjb25uZWN0ZWRCeUZpZWxkMiIsImNvbm5FbnRpdHkiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJfdXBkYXRlUmVsYXRpb25FbnRpdHkiLCJsb2NhbEZpZWxkTmFtZSIsImFkZEFzc29jaWF0aW9uIiwib24iLCJmaWVsZCIsImxpc3QiLCJyZW1vdGVGaWVsZE5hbWUiLCJhZGQiLCJwcmVmaXhOYW1pbmciLCJjb25uQmFja1JlZjEiLCJjb25uQmFja1JlZjIiLCJzcmMiLCJkZXN0IiwidGFnIiwiYWRkQXNzb2NGaWVsZCIsImZpZWxkUHJvcHMiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFyZyIsImFyZ3VtZW50IiwiJG9yIiwiYXNLZXkiLCJiYXNlIiwib3RoZXIiLCJ0cmFuc2xhdGVkIiwicmVmTmFtZSIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJuZWVkQ2FzYWRlIiwibGYiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiY2FzY2FkZUNoYW5nZSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJkZXBsb3ltZW50U2V0dGluZ3MiLCJjaGFuZ2VMb2dTZXR0aW5ncyIsImdldFZhbHVlQnlQYXRoIiwiZGF0YVNvdXJjZSIsImZpbGVQYXRoIiwiY29udGVudCIsImVuc3VyZUZpbGVTeW5jIiwid3JpdGVGaWxlU3luYyIsInJlbGF0aW9uRW50aXR5TmFtZSIsImVudGl0eTFOYW1lIiwiZW50aXR5Mk5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwiaW5kZXhlcyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4IiwidW5pcXVlIiwibGluZXMiLCJzdWJzdHIiLCJleHRyYVByb3BzIiwicHJvcHMiLCJyZWxhdGlvbiIsInJlZlRhYmxlIiwic2NoZW1hTmFtZSIsInRhcmdldENvbm5lY3RvciIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwicGFzY2FsQ2FzZSIsImVuZHNXaXRoIiwicXVvdGVTdHJpbmciLCJzdHIiLCJyZXBsYWNlIiwib2JqIiwiaXNQcm9jIiwiaW50Q29sdW1uRGVmaW5pdGlvbiIsImZsb2F0Q29sdW1uRGVmaW5pdGlvbiIsInRleHRDb2x1bW5EZWZpbml0aW9uIiwiYm9vbENvbHVtbkRlZmluaXRpb24iLCJiaW5hcnlDb2x1bW5EZWZpbml0aW9uIiwiZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uIiwiZW51bUNvbHVtbkRlZmluaXRpb24iLCJjb2x1bW5OdWxsYWJsZSIsImRlZmF1bHRWYWx1ZSIsImRpZ2l0cyIsInVuc2lnbmVkIiwiZXhhY3QiLCJ0b3RhbERpZ2l0cyIsImRlY2ltYWxEaWdpdHMiLCJmaXhlZExlbmd0aCIsIm1heExlbmd0aCIsInJhbmdlIiwidmFsdWVzIiwiaGFzT3duUHJvcGVydHkiLCJvcHRpb25hbCIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsSUFBSSxHQUFHRCxPQUFPLENBQUMsTUFBRCxDQUFwQjs7QUFFQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxVQUFELENBQXBCOztBQUNBLE1BQU07QUFBRUcsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxFQUFMO0FBQVNDLEVBQUFBO0FBQVQsSUFBbUJILElBQXpCOztBQUVBLE1BQU1JLFFBQVEsR0FBR04sT0FBTyxDQUFDLHdCQUFELENBQXhCOztBQUNBLE1BQU07QUFBRU8sRUFBQUEsU0FBRjtBQUFhQyxFQUFBQSxpQkFBYjtBQUFnQ0MsRUFBQUE7QUFBaEMsSUFBMkRILFFBQWpFOztBQUNBLE1BQU1J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Q0FBQzBULFVBQUYsQ0FBYS9RLFVBQWIsRUFBeUIyUSxpQkFBekIsQ0FBSixFQUFpRDtBQUM3QzNRLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDZ08sTUFBWCxDQUFrQjJDLGlCQUFpQixDQUFDNVEsTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBT3ZDLFFBQVEsQ0FBQ2lKLFlBQVQsQ0FBc0J6RyxVQUF0QixDQUFQO0FBQ0g7O0FBdDdDYzs7QUF5N0NuQmdSLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmpULFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCB7IHBsdXJhbGl6ZSwgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUgfSA9IE9vbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEsIHNjaGVtYVRvQ29ubmVjdG9yKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IHBlbmRpbmdFbnRpdGllcyA9IE9iamVjdC5rZXlzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICB3aGlsZSAocGVuZGluZ0VudGl0aWVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGxldCBlbnRpdHlOYW1lID0gcGVuZGluZ0VudGl0aWVzLnNoaWZ0KCk7XG4gICAgICAgICAgICBsZXQgZW50aXR5ID0gbW9kZWxpbmdTY2hlbWEuZW50aXRpZXNbZW50aXR5TmFtZV07XG5cbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHsgIFxuICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgUHJvY2Vzc2luZyBhc3NvY2lhdGlvbnMgb2YgZW50aXR5IFwiJHtlbnRpdHlOYW1lfVwiLi4uYCk7ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIobW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coZW50aXR5LmluZm8uZGF0YSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmLCBzY2hlbWFUb0Nvbm5lY3RvcikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfdG9Db2x1bW5SZWZlcmVuY2UobmFtZSkge1xuICAgICAgICByZXR1cm4geyBvb3JUeXBlOiAnQ29sdW1uUmVmZXJlbmNlJywgbmFtZSB9OyAgXG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZW1vdGVGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbihjb250ZXh0LCBsb2NhbEZpZWxkLCBhbmNob3IsIHJmKSk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHJlbW90ZUZpZWxkKSkge1xuICAgICAgICAgICAgbGV0IHJldCA9IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShhbmNob3IgKyAnLicgKyByZW1vdGVGaWVsZC5ieSkgfTtcbiAgICAgICAgICAgIGxldCB3aXRoRXh0cmEgPSB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIHJlbW90ZUZpZWxkLndpdGgpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAobG9jYWxGaWVsZCBpbiB3aXRoRXh0cmEpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHJldCwgd2l0aEV4dHJhIF0gfTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHsgLi4ucmV0LCAuLi53aXRoRXh0cmEgfTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQpIH07XG4gICAgfVxuXG4gICAgX2dldEFsbFJlbGF0ZWRGaWVsZHMocmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKCFyZW1vdGVGaWVsZCkgcmV0dXJuIHVuZGVmaW5lZDtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5tYXAocmYgPT4gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhyZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIHJldHVybiByZW1vdGVGaWVsZC5ieTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZW1vdGVGaWVsZDtcbiAgICB9XG5cbiAgICBfcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpIHtcbiAgICAgICAgcmV0dXJuIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5tYXAoYXNzb2MgPT4ge1xuICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSByZXR1cm4gYXNzb2Muc3JjRmllbGQ7XG5cbiAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnaGFzTWFueScpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcGx1cmFsaXplKGFzc29jLmRlc3RFbnRpdHkpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBiZWxvbmdzVG8gICAgICBcbiAgICAgKiBoYXNNYW55L2hhc09uZSAtIGhhc01hbnkvaGFzT25lIFtieV0gW3dpdGhdXG4gICAgICogaGFzTWFueSAtIHNlbWkgY29ubmVjdGlvbiAgICAgICBcbiAgICAgKiByZWZlcnNUbyAtIHNlbWkgY29ubmVjdGlvblxuICAgICAqICAgICAgXG4gICAgICogcmVtb3RlRmllbGQ6XG4gICAgICogICAxLiBmaWVsZE5hbWVcbiAgICAgKiAgIDIuIGFycmF5IG9mIGZpZWxkTmFtZVxuICAgICAqICAgMy4geyBieSAsIHdpdGggfVxuICAgICAqICAgNC4gYXJyYXkgb2YgZmllbGROYW1lIGFuZCB7IGJ5ICwgd2l0aCB9IG1peGVkXG4gICAgICogIFxuICAgICAqIEBwYXJhbSB7Kn0gc2NoZW1hIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5IFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2MgXG4gICAgICovXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MsIGFzc29jTmFtZXMsIHBlbmRpbmdFbnRpdGllcykge1xuICAgICAgICBsZXQgZW50aXR5S2V5RmllbGQgPSBlbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiAhQXJyYXkuaXNBcnJheShlbnRpdHlLZXlGaWVsZCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBQcm9jZXNzaW5nIFwiJHtlbnRpdHkubmFtZX1cIiAke0pTT04uc3RyaW5naWZ5KGFzc29jKX1gKTsgXG5cbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eSwgZGVzdEVudGl0eSwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcbiAgICAgICAgXG4gICAgICAgIGlmIChpc0RvdFNlcGFyYXRlTmFtZShkZXN0RW50aXR5TmFtZSkpIHtcbiAgICAgICAgICAgIC8vY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgICAgICBsZXQgWyBkZXN0U2NoZW1hTmFtZSwgYWN0dWFsRGVzdEVudGl0eU5hbWUgXSA9IGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICBsZXQgZGVzdFNjaGVtYSA9IHNjaGVtYS5saW5rZXIuc2NoZW1hc1tkZXN0U2NoZW1hTmFtZV07XG4gICAgICAgICAgICBpZiAoIWRlc3RTY2hlbWEubGlua2VkKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBUaGUgZGVzdGluYXRpb24gc2NoZW1hICR7ZGVzdFNjaGVtYU5hbWV9IGhhcyBub3QgYmVlbiBsaW5rZWQgeWV0LiBDdXJyZW50bHkgb25seSBzdXBwb3J0IG9uZS13YXkgcmVmZXJlbmNlIGZvciBjcm9zcyBkYiByZWxhdGlvbi5gKVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBkZXN0RW50aXR5ID0gZGVzdFNjaGVtYS5lbnRpdGllc1thY3R1YWxEZXN0RW50aXR5TmFtZV07IFxuICAgICAgICAgICAgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSA9IGFjdHVhbERlc3RFbnRpdHlOYW1lO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgZGVzdEVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICBhc3NlcnQ6IGRlc3RFbnRpdHk7XG5cbiAgICAgICAgICAgIGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUgPSBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgfSAgIFxuICAgICAgICAgXG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgYXNzZXJ0OiBkZXN0S2V5RmllbGQsIGBFbXB0eSBrZXkgZmllbGQuIEVudGl0eTogJHtkZXN0RW50aXR5TmFtZX1gOyBcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLndpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLndpdGggPSBhc3NvYy53aXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiYnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvbmUvbWFueSB0byBvbmUvbWFueSByZWxhdGlvblxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCBgTmV3IGVudGl0eSBcIiR7Y29ubkVudGl0eS5uYW1lfVwiIGFkZGVkIGJ5IGFzc29jaWF0aW9uLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eTogY29ubkVudGl0eU5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZDJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYzogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIDItd2F5IHJlZmVyZW5jZTogJHt0YWcxfWApOyAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAyLXdheSByZWZlcmVuY2U6ICR7dGFnMn1gKTsgICAgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGJhY2tSZWYudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYmVsb25nc1RvIGJ5LiBlbnRpdHk6ICcgKyBlbnRpdHkubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vbGVhdmUgaXQgdG8gdGhlIHJlZmVyZW5jZWQgZW50aXR5ICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYW5jaG9yID0gYXNzb2Muc3JjRmllbGQgfHwgKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKSA6IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NvYy53aXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogcmVtb3RlRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLndpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogcmVtb3RlRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKHR5cGVvZiByZW1vdGVGaWVsZCA9PT0gJ3N0cmluZycgPyB7IGZpZWxkOiByZW1vdGVGaWVsZCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgbGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGguIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJywgYXNzb2NpYXRpb246ICcgKyBKU09OLnN0cmluZ2lmeShhc3NvYywgbnVsbCwgMikpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgIFxuICAgICAgICAgICAgICAgICAgICAvLyBzZW1pIGFzc29jaWF0aW9uIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuYnkgPyBhc3NvYy5ieS5zcGxpdCgnLicpIDogWyBPb2xVdGlscy5wcmVmaXhOYW1pbmcoZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lKSBdO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uRW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnN1cmVHZXRFbnRpdHkoZW50aXR5Lm9vbE1vZHVsZSwgY29ubkVudGl0eU5hbWUsIHBlbmRpbmdFbnRpdGllcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgLy9jcmVhdGUgYVxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwZW5kaW5nRW50aXRpZXMucHVzaChjb25uRW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsIGBOZXcgZW50aXR5IFwiJHtjb25uRW50aXR5Lm5hbWV9XCIgYWRkZWQgYnkgYXNzb2NpYXRpb24uYCk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWVBc0ZpZWxkTmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuIERldGFpbDogJyArIEpTT04uc3RyaW5naWZ5KHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmM6IGVudGl0eS5uYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3Q6IGRlc3RFbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiBhc3NvYy5zcmNGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgfSkpO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZUFzRmllbGROYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCAxLXdheSByZWZlcmVuY2U6ICR7dGFnMX1gKTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lQXNGaWVsZE5hbWU7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnID0gYCR7ZW50aXR5Lm5hbWV9OjEtJHtkZXN0RW50aXR5TmFtZX06KiAke2xvY2FsRmllbGR9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAvL2FscmVhZHkgcHJvY2Vzc2VkIGJ5IGNvbm5lY3Rpb24sIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnKTsgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCB3ZWVrIHJlZmVyZW5jZTogJHt0YWd9YCk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgZGVzdEtleUZpZWxkLCBhc3NvYy5maWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGRlc3RFbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgb246IHsgW2xvY2FsRmllbGRdOiB0aGlzLl90b0NvbHVtblJlZmVyZW5jZShsb2NhbEZpZWxkICsgJy4nICsgZGVzdEVudGl0eS5rZXkpIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSwgYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24pIHtcbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJyE9Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckbmUnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdVbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBsZXQgYXJnO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKG9vbENvbi5vcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW51bGwnOlxuICAgICAgICAgICAgICAgICAgICBhcmcgPSBvb2xDb24uYXJndW1lbnQ7XG4gICAgICAgICAgICAgICAgICAgIGlmIChhcmcub29sVHlwZSAmJiBhcmcub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFyZyA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBhcmcubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgW2FyZ106IHsgJyRlcSc6IG51bGwgfVxuICAgICAgICAgICAgICAgICAgICB9OyBcblxuICAgICAgICAgICAgICAgIGNhc2UgJ2lzLW5vdC1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckbmUnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgICAgIFxuXG4gICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gVW5hcnlFeHByZXNzaW9uIG9wZXJhdG9yOiAnICsgb29sQ29uLm9wZXJhdG9yKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSBlbHNlIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0xvZ2ljYWxFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdhbmQnOlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkYW5kOiBbIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLmxlZnQpLCB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbi5yaWdodCkgXSB9O1xuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBjYXNlICdvcic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4geyAkb3I6IFsgdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCBvb2xDb24ubGVmdCksIHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uLnJpZ2h0KSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZk5hbWUgPSBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuXG4gICAgICAgIGlmIChhc0tleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZk5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UocmVmTmFtZSk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkLCBuZWVkQ2FzYWRlKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgbGVmdEZpZWxkID09PSAnc3RyaW5nJztcblxuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkLCBjYXNjYWRlQ2hhbmdlOiBuZWVkQ2FzYWRlIH0pO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihzY2hlbWEsIGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY2hhbmdlTG9nJzpcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhzY2hlbWEuZGVwbG95bWVudFNldHRpbmdzKTtcblxuICAgICAgICAgICAgICAgIGxldCBjaGFuZ2VMb2dTZXR0aW5ncyA9IFV0aWwuZ2V0VmFsdWVCeVBhdGgoc2NoZW1hLmRlcGxveW1lbnRTZXR0aW5ncywgJ2ZlYXR1cmVzLmNoYW5nZUxvZycpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFjaGFuZ2VMb2dTZXR0aW5ncykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYE1pc3NpbmcgXCJjaGFuZ2VMb2dcIiBmZWF0dXJlIHNldHRpbmdzIGluIGRlcGxveW1lbnQgY29uZmlnIGZvciBzY2hlbWEgWyR7c2NoZW1hLm5hbWV9XS5gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIWNoYW5nZUxvZ1NldHRpbmdzLmRhdGFTb3VyY2UpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNoYW5nZUxvZy5kYXRhU291cmNlXCIgaXMgcmVxdWlyZWQuIFNjaGVtYTogJHtzY2hlbWEubmFtZX1gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBPYmplY3QuYXNzaWduKGZlYXR1cmUsIGNoYW5nZUxvZ1NldHRpbmdzKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2F1dG9JZCcsICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBpbmRleGVzOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcImZpZWxkc1wiOiBbIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkIF0sXG4gICAgICAgICAgICAgICAgICAgIFwidW5pcXVlXCI6IHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdLFxuICAgICAgICAgICAgYXNzb2NpYXRpb25zOiBbXG4gICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICBcInR5cGVcIjogXCJyZWZlcnNUb1wiLFxuICAgICAgICAgICAgICAgICAgICBcImRlc3RFbnRpdHlcIjogZW50aXR5MU5hbWUsXG4gICAgICAgICAgICAgICAgICAgIFwic3JjRmllbGRcIjogZW50aXR5MVJlZkZpZWxkXG4gICAgICAgICAgICAgICAgfSxcbiAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgIFwidHlwZVwiOiBcInJlZmVyc1RvXCIsXG4gICAgICAgICAgICAgICAgICAgIFwiZGVzdEVudGl0eVwiOiBlbnRpdHkyTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgXCJzcmNGaWVsZFwiOiBlbnRpdHkyUmVmRmllbGRcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSByZWxhdGlvbkVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTEgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MU5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkyTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbm5lY3RlZEJ5RmllbGQgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkMiBcbiAgICAgKi9cbiAgICBfdXBkYXRlUmVsYXRpb25FbnRpdHkocmVsYXRpb25FbnRpdHksIGVudGl0eTEsIGVudGl0eTIsIGVudGl0eTFOYW1lLyogZm9yIGNyb3NzIGRiICovLCBlbnRpdHkyTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICBcbiAgICAgICAgICAgIC8vIGNoZWNrIGlmIHRoZSByZWxhdGlvbiBlbnRpdHkgaGFzIHRoZSByZWZlcnNUbyBib3RoIHNpZGUgb2YgYXNzb2NpYXRpb25zICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgXy5lYWNoKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zLCBhc3NvYyA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5MU5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTFOYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5Mk5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIC8veWVzLCBkb24ndCBuZWVkIHRvIGFkZCByZWZlcnNUbyB0byB0aGUgcmVsYXRpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRhZzEgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkxTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGR9YDtcbiAgICAgICAgbGV0IHRhZzIgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkyTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGQyfWA7XG5cbiAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkpIHtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKTtcblxuICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgIFxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIGJyaWRnaW5nIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgYnJpZGdpbmcgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxTmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MU5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyTmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lKTsgICAgICAgIFxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICAvKlxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfSovXG5cbiAgICBfY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBzcWwgPSAnQ1JFQVRFIFRBQkxFIElGIE5PVCBFWElTVFMgYCcgKyBlbnRpdHlOYW1lICsgJ2AgKFxcbic7XG5cbiAgICAgICAgLy9jb2x1bW4gZGVmaW5pdGlvbnNcbiAgICAgICAgXy5lYWNoKGVudGl0eS5maWVsZHMsIChmaWVsZCwgbmFtZSkgPT4ge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKG5hbWUpICsgJyAnICsgTXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24oZmllbGQpICsgJyxcXG4nO1xuICAgICAgICB9KTtcblxuICAgICAgICAvL3ByaW1hcnkga2V5XG4gICAgICAgIHNxbCArPSAnICBQUklNQVJZIEtFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGVudGl0eS5rZXkpICsgJyksXFxuJztcblxuICAgICAgICAvL290aGVyIGtleXNcbiAgICAgICAgaWYgKGVudGl0eS5pbmRleGVzICYmIGVudGl0eS5pbmRleGVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIGVudGl0eS5pbmRleGVzLmZvckVhY2goaW5kZXggPT4ge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnICAnO1xuICAgICAgICAgICAgICAgIGlmIChpbmRleC51bmlxdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICdVTklRVUUgJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3FsICs9ICdLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShpbmRleC5maWVsZHMpICsgJyksXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGxpbmVzID0gW107XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdiZWZvcmVFbmRDb2x1bW5EZWZpbml0aW9uOicgKyBlbnRpdHlOYW1lLCBsaW5lcyk7XG4gICAgICAgIGlmIChsaW5lcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIGxpbmVzLmpvaW4oJyxcXG4gICcpO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsID0gc3FsLnN1YnN0cigwLCBzcWwubGVuZ3RoLTIpO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICdcXG4pJztcblxuICAgICAgICAvL3RhYmxlIG9wdGlvbnNcbiAgICAgICAgbGV0IGV4dHJhUHJvcHMgPSB7fTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5TmFtZSwgZXh0cmFQcm9wcyk7XG4gICAgICAgIGxldCBwcm9wcyA9IE9iamVjdC5hc3NpZ24oe30sIHRoaXMuX2RiT3B0aW9ucy50YWJsZSwgZXh0cmFQcm9wcyk7XG5cbiAgICAgICAgc3FsID0gXy5yZWR1Y2UocHJvcHMsIGZ1bmN0aW9uKHJlc3VsdCwgdmFsdWUsIGtleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdCArICcgJyArIGtleSArICc9JyArIHZhbHVlO1xuICAgICAgICB9LCBzcWwpO1xuXG4gICAgICAgIHNxbCArPSAnO1xcbic7XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG4gICAgXG4gICAgX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoZW50aXR5TmFtZSwgcmVsYXRpb24sIHNjaGVtYVRvQ29ubmVjdG9yKSB7XG4gICAgICAgIGxldCByZWZUYWJsZSA9IHJlbGF0aW9uLnJpZ2h0O1xuXG4gICAgICAgIGlmIChyZWZUYWJsZS5pbmRleE9mKCcuJykgPiAwKSB7XG4gICAgICAgICAgICBsZXQgWyBzY2hlbWFOYW1lLCBlbnRpdHlOYW1lIF0gPSByZWZUYWJsZS5zcGxpdCgnLicpOyAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgdGFyZ2V0Q29ubmVjdG9yID0gc2NoZW1hVG9Db25uZWN0b3Jbc2NoZW1hTmFtZV07XG4gICAgICAgICAgICBhc3NlcnQ6IHRhcmdldENvbm5lY3RvcjtcblxuICAgICAgICAgICAgcmVmVGFibGUgPSB0YXJnZXRDb25uZWN0b3IuZGF0YWJhc2UgKyAnYC5gJyArIGVudGl0eU5hbWU7XG4gICAgICAgIH0gICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdBTFRFUiBUQUJMRSBgJyArIGVudGl0eU5hbWUgK1xuICAgICAgICAgICAgJ2AgQUREIEZPUkVJR04gS0VZIChgJyArIHJlbGF0aW9uLmxlZnRGaWVsZCArICdgKSAnICtcbiAgICAgICAgICAgICdSRUZFUkVOQ0VTIGAnICsgcmVmVGFibGUgKyAnYCAoYCcgKyByZWxhdGlvbi5yaWdodEZpZWxkICsgJ2ApICc7XG5cbiAgICAgICAgc3FsICs9ICcnO1xuXG4gICAgICAgIGlmICh0aGlzLl9yZWxhdGlvbkVudGl0aWVzW2VudGl0eU5hbWVdIHx8IHJlbGF0aW9uLmNhc2NhZGVDaGFuZ2UpIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19