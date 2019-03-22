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
    let pendingEntities = Object.values(modelingSchema.entities);

    while (pendingEntities.length > 0) {
      let entity = pendingEntities.shift();

      if (!_.isEmpty(entity.info.associations)) {
        this.logger.log('debug', `Processing associations of entity "${entity.name}"...`);
        console.log(`Processing associations of entity "${entity.name}"...`);

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
        destEntity;

    if (isDotSeparateName(destEntityName)) {
      let [destSchemaName, actualDestEntityName] = extractDotSeparateName(destEntityName);
      let destSchema = schema.linker.schemas[destSchemaName];

      if (!destSchema.linked) {
        throw new Error(`The destination schema ${destSchemaName} has not been linked yet. Currently only support one-way reference for cross db relation.`);
      }

      destEntity = destSchema.entities[actualDestEntityName];
    } else {
      destEntity = schema.ensureGetEntity(entity.oolModule, destEntityName, pendingEntities);
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

            let localFieldName = assoc.srcField || pluralize(destEntityName);
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

            this.logger.log('verbose', `Processed reference: ${tag1}`);
            console.log(`Processed reference: ${tag1}`);

            this._processedRef.add(tag2);

            this.logger.log('verbose', `Processed reference: ${tag2}`);
            console.log(`Processed reference: ${tag2}`);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.by) {
              throw new Error('todo: belongsTo by. entity: ' + entity.name);
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

          let connectedByField2 = connBackRef2.srcField || destEntityName;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "by" field in a relation entity. Detail: ' + JSON.stringify({
              src: entity.name,
              dest: destEntityName,
              srcField: assoc.srcField,
              by: connectedByField
            }));
          }

          this._updateRelationEntity(connEntity, entity, destEntity, entity.name, destEntityName, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityName);
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

          this.logger.log('verbose', `Processed reference: ${tag1}`);
          console.log(`Processed reference: ${tag1}`);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityName;

        if (assoc.type === 'refersTo') {
          let tag = `${entity.name}:1-${destEntityName}:* ${localField}`;

          if (this._processedRef.has(tag)) {
            return;
          }

          this._processedRef.add(tag);

          this.logger.log('verbose', `Processed reference: ${tag}`);
          console.log(`Processed reference: ${tag}`);
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
        this._relationEntities[relationEntityName] = true;
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

    this.logger.log('verbose', `Processed reference: ${tag1}`);
    console.log(`Processed reference: ${tag1}`);

    this._processedRef.add(tag2);

    this.logger.log('verbose', `Processed reference: ${tag2}`);
    console.log(`Processed reference: ${tag2}`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJVdGlsIiwiXyIsImZzIiwicXVvdGUiLCJPb2xVdGlscyIsInBsdXJhbGl6ZSIsImlzRG90U2VwYXJhdGVOYW1lIiwiZXh0cmFjdERvdFNlcGFyYXRlTmFtZSIsIkVudGl0eSIsIlR5cGVzIiwiVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSIsIlNldCIsIk15U1FMTW9kZWxlciIsImNvbnN0cnVjdG9yIiwiY29udGV4dCIsImNvbm5lY3RvciIsImRiT3B0aW9ucyIsImxvZ2dlciIsImxpbmtlciIsIm91dHB1dFBhdGgiLCJzY3JpcHRPdXRwdXRQYXRoIiwiX2V2ZW50cyIsIl9kYk9wdGlvbnMiLCJkYiIsIm1hcEtleXMiLCJ2YWx1ZSIsImtleSIsInVwcGVyQ2FzZSIsInRhYmxlIiwiX3JlZmVyZW5jZXMiLCJfcmVsYXRpb25FbnRpdGllcyIsIl9wcm9jZXNzZWRSZWYiLCJtb2RlbGluZyIsInNjaGVtYSIsInNjaGVtYVRvQ29ubmVjdG9yIiwibG9nIiwibmFtZSIsIm1vZGVsaW5nU2NoZW1hIiwiY2xvbmUiLCJwZW5kaW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImxlbmd0aCIsImVudGl0eSIsInNoaWZ0IiwiaXNFbXB0eSIsImluZm8iLCJhc3NvY2lhdGlvbnMiLCJjb25zb2xlIiwiYXNzb2NzIiwiX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMiLCJhc3NvY05hbWVzIiwicmVkdWNlIiwicmVzdWx0IiwidiIsImZvckVhY2giLCJhc3NvYyIsIl9wcm9jZXNzQXNzb2NpYXRpb24iLCJlbWl0Iiwic3FsRmlsZXNEaXIiLCJqb2luIiwiZGF0YWJhc2UiLCJkYkZpbGVQYXRoIiwiZmtGaWxlUGF0aCIsImluaXRJZHhGaWxlUGF0aCIsImluaXRGaWxlUGF0aCIsInRhYmxlU1FMIiwicmVsYXRpb25TUUwiLCJkYXRhIiwiZWFjaCIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0U2NoZW1hTmFtZSIsImFjdHVhbERlc3RFbnRpdHlOYW1lIiwiZGVzdFNjaGVtYSIsInNjaGVtYXMiLCJsaW5rZWQiLCJlbnN1cmVHZXRFbnRpdHkiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNiIiwic3BsaXQiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwibGlzdCIsInJlbW90ZUZpZWxkTmFtZSIsImFkZCIsInByZWZpeE5hbWluZyIsImNvbm5CYWNrUmVmMSIsImNvbm5CYWNrUmVmMiIsInNyYyIsImRlc3QiLCJ0YWciLCJhZGRBc3NvY0ZpZWxkIiwiZmllbGRQcm9wcyIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYXJnIiwiYXJndW1lbnQiLCJhc0tleSIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJlbnRpdHkxTmFtZSIsImVudGl0eTJOYW1lIiwiaGFzUmVmVG9FbnRpdHkxIiwiaGFzUmVmVG9FbnRpdHkyIiwia2V5RW50aXR5MSIsImtleUVudGl0eTIiLCJvb2xPcFRvU3FsIiwib3AiLCJvb2xUb1NxbCIsImRvYyIsIm9vbCIsInBhcmFtcyIsImlzTWVtYmVyQWNjZXNzIiwicCIsInVwcGVyRmlyc3QiLCJlbnRpdHlOb2RlIiwicGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50IiwiYWxpYXMiLCJxdW90ZUlkZW50aWZpZXIiLCJfb3JkZXJCeVRvU3FsIiwiYXNjZW5kIiwiX3ZpZXdEb2N1bWVudFRvU1FMIiwidmlldyIsInNxbCIsImNsb25lRGVlcCIsImdldERvY3VtZW50SGllcmFyY2h5IiwiY29sTGlzdCIsImpvaW5zIiwiX2J1aWxkVmlld1NlbGVjdCIsInNlbGVjdEJ5Iiwic2VsZWN0IiwiZ3JvdXBCeSIsImNvbCIsIm9yZGVyQnkiLCJza2lwIiwibGltaXQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJyZWZUYWJsZSIsInNjaGVtYU5hbWUiLCJ0YXJnZXRDb25uZWN0b3IiLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsImhhc093blByb3BlcnR5Iiwib3B0aW9uYWwiLCJjcmVhdGVCeURiIiwidXBkYXRlQnlEYiIsIkJPT0xFQU4iLCJzYW5pdGl6ZSIsInJlbW92ZVRhYmxlTmFtZVByZWZpeCIsInJlbW92ZVRhYmxlUHJlZml4IiwidHJpbSIsInNuYWtlQ2FzZSIsInRyaW1FbmQiLCJzdGFydHNXaXRoIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNQSxZQUFZLEdBQUdDLE9BQU8sQ0FBQyxRQUFELENBQTVCOztBQUNBLE1BQU1DLElBQUksR0FBR0QsT0FBTyxDQUFDLE1BQUQsQ0FBcEI7O0FBRUEsTUFBTUUsSUFBSSxHQUFHRixPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVHLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQTtBQUFULElBQW1CSCxJQUF6Qjs7QUFFQSxNQUFNSSxRQUFRLEdBQUdOLE9BQU8sQ0FBQyx3QkFBRCxDQUF4Qjs7QUFDQSxNQUFNO0FBQUVPLEVBQUFBLFNBQUY7QUFBYUMsRUFBQUEsaUJBQWI7QUFBZ0NDLEVBQUFBO0FBQWhDLElBQTJESCxRQUFqRTs7QUFDQSxNQUFNSSxNQUFNLEdBQUdWLE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7QUFDQSxNQUFNVyxLQUFLLEdBQUdYLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFFQSxNQUFNWSx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMs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UDtBQUNIOztBQUVEbk0sUUFBQUEsSUFBSSxDQUFDMlAsVUFBTCxHQUFrQixJQUFsQjtBQUNIO0FBQ0o7O0FBNERELFdBQU94RCxHQUFQO0FBQ0g7O0FBRUQsU0FBTzRELHFCQUFQLENBQTZCdk8sVUFBN0IsRUFBeUN3TyxpQkFBekMsRUFBNEQ7QUFDeEQsUUFBSUEsaUJBQUosRUFBdUI7QUFDbkJ4TyxNQUFBQSxVQUFVLEdBQUd0RSxDQUFDLENBQUMrUyxJQUFGLENBQU8vUyxDQUFDLENBQUNnVCxTQUFGLENBQVkxTyxVQUFaLENBQVAsQ0FBYjtBQUVBd08sTUFBQUEsaUJBQWlCLEdBQUc5UyxDQUFDLENBQUNpVCxPQUFGLENBQVVqVCxDQUFDLENBQUNnVCxTQUFGLENBQVlGLGlCQUFaLENBQVYsRUFBMEMsR0FBMUMsSUFBaUQsR0FBckU7O0FBRUEsVUFBSTlTLENBQUMsQ0FBQ2tULFVBQUYsQ0FBYTVPLFVBQWIsRUFBeUJ3TyxpQkFBekIsQ0FBSixFQUFpRDtBQUM3Q3hPLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDOEwsTUFBWCxDQUFrQjBDLGlCQUFpQixDQUFDcFEsTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBT3ZDLFFBQVEsQ0FBQ2lKLFlBQVQsQ0FBc0I5RSxVQUF0QixDQUFQO0FBQ0g7O0FBbjNDYzs7QUFzM0NuQjZPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnpTLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCB7IHBsdXJhbGl6ZSwgaXNEb3RTZXBhcmF0ZU5hbWUsIGV4dHJhY3REb3RTZXBhcmF0ZU5hbWUgfSA9IE9vbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEsIHNjaGVtYVRvQ29ubmVjdG9yKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IHBlbmRpbmdFbnRpdGllcyA9IE9iamVjdC52YWx1ZXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIHdoaWxlIChwZW5kaW5nRW50aXRpZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgbGV0IGVudGl0eSA9IHBlbmRpbmdFbnRpdGllcy5zaGlmdCgpO1xuXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgYFByb2Nlc3NpbmcgYXNzb2NpYXRpb25zIG9mIGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIuLi5gKTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgUHJvY2Vzc2luZyBhc3NvY2lhdGlvbnMgb2YgZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIi4uLmApO1xuXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jcyA9IHRoaXMuX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KTsgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBhc3NvY05hbWVzID0gYXNzb2NzLnJlZHVjZSgocmVzdWx0LCB2KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHJlc3VsdFt2XSA9IHY7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYywgYXNzb2NOYW1lcywgcGVuZGluZ0VudGl0aWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGVudGl0eS5pbmZvLmRhdGEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZiwgc2NoZW1hVG9Db25uZWN0b3IpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogJ0NvbHVtblJlZmVyZW5jZScsIG5hbWUgfTsgIFxuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQuYnkpIH07XG4gICAgICAgICAgICBsZXQgd2l0aEV4dHJhID0gdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCByZW1vdGVGaWVsZC53aXRoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGxvY2FsRmllbGQgaW4gd2l0aEV4dHJhKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyByZXQsIHdpdGhFeHRyYSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnJldCwgLi4ud2l0aEV4dHJhIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkKSB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkgcmV0dXJuIGFzc29jLnNyY0ZpZWxkO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBsdXJhbGl6ZShhc3NvYy5kZXN0RW50aXR5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gYmVsb25nc1RvICAgICAgXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBoYXNNYW55L2hhc09uZSBbYnldIFt3aXRoXVxuICAgICAqIGhhc01hbnkgLSBzZW1pIGNvbm5lY3Rpb24gICAgICAgXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKiAgICAgIFxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqICBcbiAgICAgKiBAcGFyYW0geyp9IHNjaGVtYSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIFxuICAgICAqL1xuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzLCBwZW5kaW5nRW50aXRpZXMpIHtcbiAgICAgICAgbGV0IGVudGl0eUtleUZpZWxkID0gZW50aXR5LmdldEtleUZpZWxkKCk7XG4gICAgICAgIGFzc2VydDogIUFycmF5LmlzQXJyYXkoZW50aXR5S2V5RmllbGQpO1xuXG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHksIGRlc3RFbnRpdHk7XG4gICAgICAgIFxuICAgICAgICBpZiAoaXNEb3RTZXBhcmF0ZU5hbWUoZGVzdEVudGl0eU5hbWUpKSB7XG4gICAgICAgICAgICAvL2Nyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICAgICAgbGV0IFsgZGVzdFNjaGVtYU5hbWUsIGFjdHVhbERlc3RFbnRpdHlOYW1lIF0gPSBleHRyYWN0RG90U2VwYXJhdGVOYW1lKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgbGV0IGRlc3RTY2hlbWEgPSBzY2hlbWEubGlua2VyLnNjaGVtYXNbZGVzdFNjaGVtYU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFkZXN0U2NoZW1hLmxpbmtlZCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVGhlIGRlc3RpbmF0aW9uIHNjaGVtYSAke2Rlc3RTY2hlbWFOYW1lfSBoYXMgbm90IGJlZW4gbGlua2VkIHlldC4gQ3VycmVudGx5IG9ubHkgc3VwcG9ydCBvbmUtd2F5IHJlZmVyZW5jZSBmb3IgY3Jvc3MgZGIgcmVsYXRpb24uYClcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZGVzdEVudGl0eSA9IGRlc3RTY2hlbWEuZW50aXRpZXNbYWN0dWFsRGVzdEVudGl0eU5hbWVdOyBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGRlc3RFbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGRlc3RFbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICB9ICAgXG4gICAgICAgICBcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6IGRlc3RLZXlGaWVsZDsgXG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBcbiAgICAgICAgICAgICAgICAgICAgYXNzb2NpYXRpb246IGFzc29jIFxuICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5ieS5zcGxpdCgnLicpWzBdIFxuICAgICAgICAgICAgICAgICAgICB9O1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy53aXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy53aXRoID0gYXNzb2Mud2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkcyA9IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMoYXNzb2MucmVtb3RlRmllbGQpO1xuXG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBcbiAgICAgICAgICAgICAgICAgICAgICAgIHNyY0ZpZWxkOiByZW1vdGVGaWVsZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQgfHwgKHJlbW90ZUZpZWxkID0gZW50aXR5Lm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIF8uaXNOaWwocmVtb3RlRmllbGRzKSB8fCAoQXJyYXkuaXNBcnJheShyZW1vdGVGaWVsZHMpID8gcmVtb3RlRmllbGRzLmluZGV4T2YocmVtb3RlRmllbGQpID4gLTEgOiByZW1vdGVGaWVsZHMgPT09IHJlbW90ZUZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIH07ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5ieSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignXCJtMm5cIiBhc3NvY2lhdGlvbiByZXF1aXJlcyBcImJ5XCIgcHJvcGVydHkuIEVudGl0eTogJyArIGVudGl0eS5uYW1lICsgJyBkZXN0aW5hdGlvbjogJyArIGRlc3RFbnRpdHlOYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBjb25uZWN0ZWQgYnkgZmllbGQgaXMgdXN1YWxseSBhIHJlZmVyc1RvIGFzc29jXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7IFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICduJyA6ICcxJyB9IGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcyID0gYCR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5ieS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiYnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW5zdXJlR2V0RW50aXR5KGVudGl0eS5vb2xNb2R1bGUsIGNvbm5FbnRpdHlOYW1lLCBwZW5kaW5nRW50aXRpZXMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnRlcmNvbm5lY3Rpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIiBub3QgZm91bmQgaW4gc2NoZW1hLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkMlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBjb25uRW50aXR5LmtleSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiByZW1vdGVGaWVsZE5hbWUgfSwgZGVzdEVudGl0eS5rZXksIHJlbW90ZUZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYmFja1JlZi53aXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZzF9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhgUHJvY2Vzc2VkIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzIpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCByZWZlcmVuY2U6ICR7dGFnMn1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuYnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBieS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpIDogZGVzdEVudGl0eU5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBhc3NvYy5yZW1vdGVGaWVsZCB8fCBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5ieSA/IGFzc29jLmJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVuc3VyZUdldEVudGl0eShlbnRpdHkub29sTW9kdWxlLCBjb25uRW50aXR5TmFtZSwgcGVuZGluZ0VudGl0aWVzKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIiBub3QgZm91bmQgaW4gc2NoZW1hLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJieVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgZW50aXR5Lm5hbWUsIGRlc3RFbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogY29ubkVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb246IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oeyAuLi5hc3NvY05hbWVzLCBbY29ubkVudGl0eU5hbWVdOiBsb2NhbEZpZWxkTmFtZSB9LCBlbnRpdHkua2V5LCBsb2NhbEZpZWxkTmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Mud2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgd2l0aDogYXNzb2Mud2l0aFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2dnZXIubG9nKCd2ZXJib3NlJywgYFByb2Nlc3NlZCByZWZlcmVuY2U6ICR7dGFnMX1gKTsgXG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZzF9YCk7ICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcgPSBgJHtlbnRpdHkubmFtZX06MS0ke2Rlc3RFbnRpdHlOYW1lfToqICR7bG9jYWxGaWVsZH1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICh0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZykpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQgYnkgY29ubmVjdGlvbiwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcpOyAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIHJlZmVyZW5jZTogJHt0YWd9YCk7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZ31gKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBkZXN0S2V5RmllbGQsIGFzc29jLmZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RW50aXR5LmtleSkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oY29udGV4dCwgb29sQ29uKSB7XG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2UgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnVW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgbGV0IGFyZztcblxuICAgICAgICAgICAgc3dpdGNoIChvb2xDb24ub3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdpcy1udWxsJzpcbiAgICAgICAgICAgICAgICAgICAgYXJnID0gb29sQ29uLmFyZ3VtZW50O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXJnLm9vbFR5cGUgJiYgYXJnLm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcmcgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgYXJnLm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIFthcmddOiB7ICckZXEnOiBudWxsIH1cbiAgICAgICAgICAgICAgICAgICAgfTsgXG5cbiAgICAgICAgICAgICAgICBjYXNlICdpcy1ub3QtbnVsbCc6XG4gICAgICAgICAgICAgICAgICAgIGFyZyA9IG9vbENvbi5hcmd1bWVudDtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFyZy5vb2xUeXBlICYmIGFyZy5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJnID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGFyZy5uYW1lLCB0cnVlKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBbYXJnXTogeyAnJG5lJzogbnVsbCB9XG4gICAgICAgICAgICAgICAgICAgIH07ICAgICBcblxuICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmtub3duIFVuYXJ5RXhwcmVzc2lvbiBvcGVyYXRvcjogJyArIG9vbENvbi5vcGVyYXRvcik7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vua25vd24gc3ludGF4OiAnICsgSlNPTi5zdHJpbmdpZnkob29sQ29uKSk7XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYsIGFzS2V5KSB7XG4gICAgICAgIGxldCBbIGJhc2UsIC4uLm90aGVyIF0gPSByZWYuc3BsaXQoJy4nKTtcblxuICAgICAgICBsZXQgdHJhbnNsYXRlZCA9IGNvbnRleHRbYmFzZV07XG4gICAgICAgIGlmICghdHJhbnNsYXRlZCkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2VkIG9iamVjdCBcIiR7cmVmfVwiIG5vdCBmb3VuZCBpbiBjb250ZXh0LmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZk5hbWUgPSBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuXG4gICAgICAgIGlmIChhc0tleSkge1xuICAgICAgICAgICAgcmV0dXJuIHJlZk5hbWU7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UocmVmTmFtZSk7XG4gICAgfVxuXG4gICAgX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIGxlZnRGaWVsZC5mb3JFYWNoKGxmID0+IHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZiwgcmlnaHQsIHJpZ2h0RmllbGQpKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QobGVmdEZpZWxkKSkge1xuICAgICAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZC5ieSwgcmlnaHQuIHJpZ2h0RmllbGQpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgbGVmdEZpZWxkID09PSAnc3RyaW5nJztcblxuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSByZXR1cm47XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmZWF0dXJlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9ldmVudHMub24oJ3NldFRhYmxlT3B0aW9uczonICsgZW50aXR5Lm5hbWUsIGV4dHJhT3B0cyA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZXh0cmFPcHRzWydBVVRPX0lOQ1JFTUVOVCddID0gZmVhdHVyZS5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gcmVsYXRpb25FbnRpdHkgXG4gICAgICogQHBhcmFtIHsqfSBlbnRpdHkxIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5MiBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eTFOYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gZW50aXR5Mk5hbWUgXG4gICAgICogQHBhcmFtIHsqfSBjb25uZWN0ZWRCeUZpZWxkIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubmVjdGVkQnlGaWVsZDIgXG4gICAgICovXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBlbnRpdHkxTmFtZS8qIGZvciBjcm9zcyBkYiAqLywgZW50aXR5Mk5hbWUvKiBmb3IgY3Jvc3MgZGIgKi8sIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgIGxldCByZWxhdGlvbkVudGl0eU5hbWUgPSByZWxhdGlvbkVudGl0eS5uYW1lO1xuXG4gICAgICAgIGlmIChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykgeyAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGhhc1JlZlRvRW50aXR5MSA9IGZhbHNlLCBoYXNSZWZUb0VudGl0eTIgPSBmYWxzZTsgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxTmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MU5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MSA9IHRydWU7IFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTJOYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyTmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHRhZzEgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkxTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGR9YDtcbiAgICAgICAgbGV0IHRhZzIgPSBgJHtyZWxhdGlvbkVudGl0eU5hbWV9OjEtJHtlbnRpdHkyTmFtZX06KiAke2Nvbm5lY3RlZEJ5RmllbGQyfWA7XG5cbiAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkpIHtcbiAgICAgICAgICAgIGFzc2VydDogdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKTtcblxuICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgIFxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ3ZlcmJvc2UnLCBgUHJvY2Vzc2VkIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuICAgICAgICBjb25zb2xlLmxvZyhgUHJvY2Vzc2VkIHJlZmVyZW5jZTogJHt0YWcxfWApO1xuXG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygndmVyYm9zZScsIGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG4gICAgICAgIGNvbnNvbGUubG9nKGBQcm9jZXNzZWQgcmVmZXJlbmNlOiAke3RhZzJ9YCk7XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxTmFtZX1gKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGtleUVudGl0eTIgPSBlbnRpdHkyLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTIpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkyTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwga2V5RW50aXR5MSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIGtleUVudGl0eTIpO1xuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZCwgXG4gICAgICAgICAgICB7IGVudGl0eTogZW50aXR5MU5hbWUgfVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIHsgZW50aXR5OiBlbnRpdHkyTmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MU5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyTmFtZSwga2V5RW50aXR5Mi5uYW1lKTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTtcbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbE9wVG9TcWwob3ApIHtcbiAgICAgICAgc3dpdGNoIChvcCkge1xuICAgICAgICAgICAgY2FzZSAnPSc6XG4gICAgICAgICAgICAgICAgcmV0dXJuICc9JztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbE9wVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7ICAgICAgICAgICAgICAgIFxuICAgICAgICB9XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLCBwYXJhbXMpIHtcbiAgICAgICAgaWYgKCFvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgcmV0dXJuIG9vbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAob29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgIGxldCBsZWZ0LCByaWdodDtcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBpZiAob29sLmxlZnQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wubGVmdCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gb29sLmxlZnQ7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5yaWdodC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wucmlnaHQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBvb2wucmlnaHQ7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybiBsZWZ0ICsgJyAnICsgTXlTUUxNb2RlbGVyLm9vbE9wVG9TcWwob29sLm9wZXJhdG9yKSArICcgJyArIHJpZ2h0O1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBjYXNlICdPYmplY3RSZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgIGlmICghT29sVXRpbHMuaXNNZW1iZXJBY2Nlc3Mob29sLm5hbWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwYXJhbXMgJiYgXy5maW5kKHBhcmFtcywgcCA9PiBwLm5hbWUgPT09IG9vbC5uYW1lKSAhPT0gLTEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAncCcgKyBfLnVwcGVyRmlyc3Qob29sLm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jaW5nIHRvIGEgbm9uLWV4aXN0aW5nIHBhcmFtIFwiJHtvb2wubmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCB7IGVudGl0eU5vZGUsIGVudGl0eSwgZmllbGQgfSA9IE9vbFV0aWxzLnBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudChzY2hlbWEsIGRvYywgb29sLm5hbWUpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGVudGl0eU5vZGUuYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkLm5hbWUpO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sVG9TcWwgdG8gYmUgaW1wbGVtZW50ZWQuJyk7IFxuICAgICAgICB9XG4gICAgfVxuXG4gICAgc3RhdGljIF9vcmRlckJ5VG9TcWwoc2NoZW1hLCBkb2MsIG9vbCkge1xuICAgICAgICByZXR1cm4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKHNjaGVtYSwgZG9jLCB7IG9vbFR5cGU6ICdPYmplY3RSZWZlcmVuY2UnLCBuYW1lOiBvb2wuZmllbGQgfSkgKyAob29sLmFzY2VuZCA/ICcnIDogJyBERVNDJyk7XG4gICAgfVxuXG4gICAgX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSB7XG4gICAgICAgIGxldCBzcWwgPSAnICAnO1xuICAgICAgICAvL2NvbnNvbGUubG9nKCd2aWV3OiAnICsgdmlldy5uYW1lKTtcbiAgICAgICAgbGV0IGRvYyA9IF8uY2xvbmVEZWVwKHZpZXcuZ2V0RG9jdW1lbnRIaWVyYXJjaHkobW9kZWxpbmdTY2hlbWEpKTtcbiAgICAgICAgLy9jb25zb2xlLmRpcihkb2MsIHtkZXB0aDogOCwgY29sb3JzOiB0cnVlfSk7XG5cbiAgICAgICAgLy9sZXQgYWxpYXNNYXBwaW5nID0ge307XG4gICAgICAgIGxldCBbIGNvbExpc3QsIGFsaWFzLCBqb2lucyBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KG1vZGVsaW5nU2NoZW1hLCBkb2MsIDApO1xuICAgICAgICBcbiAgICAgICAgc3FsICs9ICdTRUxFQ1QgJyArIGNvbExpc3Quam9pbignLCAnKSArICcgRlJPTSAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIGFsaWFzO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGpvaW5zKSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIGpvaW5zLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5zZWxlY3RCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB2aWV3LnNlbGVjdEJ5Lm1hcChzZWxlY3QgPT4gTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNlbGVjdCwgdmlldy5wYXJhbXMpKS5qb2luKCcgQU5EICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lmdyb3VwQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBHUk9VUCBCWSAnICsgdmlldy5ncm91cEJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcub3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9SREVSIEJZICcgKyB2aWV3Lm9yZGVyQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNraXAgPSB2aWV3LnNraXAgfHwgMDtcbiAgICAgICAgaWYgKHZpZXcubGltaXQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2tpcCwgdmlldy5wYXJhbXMpICsgJywgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LmxpbWl0LCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH0gZWxzZSBpZiAodmlldy5za2lwKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPRkZTRVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCB2aWV3LnNraXAsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgLypcbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH0qL1xuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uLCBzY2hlbWFUb0Nvbm5lY3Rvcikge1xuICAgICAgICBsZXQgcmVmVGFibGUgPSByZWxhdGlvbi5yaWdodDtcblxuICAgICAgICBpZiAocmVmVGFibGUuaW5kZXhPZignLicpID4gMCkge1xuICAgICAgICAgICAgbGV0IFsgc2NoZW1hTmFtZSwgZW50aXR5TmFtZSBdID0gcmVmVGFibGUuc3BsaXQoJy4nKTtcblxuICAgICAgICAgICAgbGV0IHRhcmdldENvbm5lY3RvciA9IHNjaGVtYVRvQ29ubmVjdG9yW3NjaGVtYU5hbWVdO1xuICAgICAgICAgICAgYXNzZXJ0OiB0YXJnZXRDb25uZWN0b3I7XG5cbiAgICAgICAgICAgIHJlZlRhYmxlID0gdGFyZ2V0Q29ubmVjdG9yLmRhdGFiYXNlICsgJ2AuYCcgKyBlbnRpdHlOYW1lO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlZlRhYmxlICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=