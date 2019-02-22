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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJwbHVyYWxpemUiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImFzc29jcyIsIl9wcmVQcm9jZXNzQXNzb2NpYXRpb25zIiwiYXNzb2NOYW1lcyIsInJlZHVjZSIsInJlc3VsdCIsInYiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiX3RvQ29sdW1uUmVmZXJlbmNlIiwib29yVHlwZSIsIl90cmFuc2xhdGVKb2luQ29uZGl0aW9uIiwibG9jYWxGaWVsZCIsImFuY2hvciIsInJlbW90ZUZpZWxkIiwibWFwIiwicmYiLCJyZXQiLCJieSIsIndpdGhFeHRyYSIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwid2l0aCIsIiRhbmQiLCJfZ2V0QWxsUmVsYXRlZEZpZWxkcyIsInVuZGVmaW5lZCIsInNyY0ZpZWxkIiwidHlwZSIsImRlc3RFbnRpdHkiLCJlbnRpdHlLZXlGaWVsZCIsImdldEtleUZpZWxkIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0S2V5RmllbGQiLCJpbmNsdWRlcyIsImV4Y2x1ZGVzIiwidHlwZXMiLCJhc3NvY2lhdGlvbiIsImNvbm5lY3RlZEJ5IiwiY2IiLCJzcGxpdCIsImNvbm5lY3RlZFdpdGgiLCJyZW1vdGVGaWVsZHMiLCJpc05pbCIsImluZGV4T2YiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvbiIsImZpZWxkIiwib3B0aW9uYWwiLCJsaXN0IiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwicHJlZml4TmFtaW5nIiwiY29ubkJhY2tSZWYxIiwiY29ubkJhY2tSZWYyIiwic3JjIiwiZGVzdCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImFzS2V5IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImNvbnNvbGUiLCJyZWZOYW1lIiwibGVmdEZpZWxkIiwicmlnaHRGaWVsZCIsImxmIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImdlbmVyYXRvciIsImF1dG9JbmNyZW1lbnRJZCIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJfYWRkUmVsYXRpb25FbnRpdHkiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsImhhc093blByb3BlcnR5IiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxJQUFJLEdBQUdELE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHUCxPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTTtBQUFFUSxFQUFBQTtBQUFGLElBQWdCRCxRQUF0Qjs7QUFDQSxNQUFNRSxNQUFNLEdBQUdULE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7QUFDQSxNQUFNVSxLQUFLLEdBQUdWLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFFQSxNQUFNVyx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQXVDQSxNQUFNQyxZQUFOLENBQW1CO0FBVWZDLEVBQUFBLFdB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RDtBQUM3QzFPLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDb00sTUFBWCxDQUFrQnNDLGlCQUFpQixDQUFDdE8sTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBT2pFLFFBQVEsQ0FBQ3dJLFlBQVQsQ0FBc0IzRSxVQUF0QixDQUFQO0FBQ0g7O0FBdnlDYzs7QUEweUNuQitPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnZTLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgeyBwbHVyYWxpemUgfSA9IE9vbFV0aWxzO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgZXhpc3RpbmdFbnRpdGllcyA9IE9iamVjdC52YWx1ZXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIF8uZWFjaChleGlzdGluZ0VudGl0aWVzLCAoZW50aXR5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7ICBcbiAgICAgICAgICAgICAgICBsZXQgYXNzb2NzID0gdGhpcy5fcHJlUHJvY2Vzc0Fzc29jaWF0aW9ucyhlbnRpdHkpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGFzc29jTmFtZXMgPSBhc3NvY3MucmVkdWNlKChyZXN1bHQsIHYpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcmVzdWx0W3ZdID0gdjtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3RvQ29sdW1uUmVmZXJlbmNlKG5hbWUpIHtcbiAgICAgICAgcmV0dXJuIHsgb29yVHlwZTogJ0NvbHVtblJlZmVyZW5jZScsIG5hbWUgfTsgIFxuICAgIH1cblxuICAgIF90cmFuc2xhdGVKb2luQ29uZGl0aW9uKGNvbnRleHQsIGxvY2FsRmllbGQsIGFuY2hvciwgcmVtb3RlRmllbGQpIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX3RyYW5zbGF0ZUpvaW5Db25kaXRpb24oY29udGV4dCwgbG9jYWxGaWVsZCwgYW5jaG9yLCByZikpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChyZW1vdGVGaWVsZCkpIHtcbiAgICAgICAgICAgIGxldCByZXQgPSB7IFtsb2NhbEZpZWxkXTogdGhpcy5fdG9Db2x1bW5SZWZlcmVuY2UoYW5jaG9yICsgJy4nICsgcmVtb3RlRmllbGQuYnkpIH07XG4gICAgICAgICAgICBsZXQgd2l0aEV4dHJhID0gdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihjb250ZXh0LCByZW1vdGVGaWVsZC53aXRoKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGxvY2FsRmllbGQgaW4gd2l0aEV4dHJhKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHsgJGFuZDogWyByZXQsIHdpdGhFeHRyYSBdIH07XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiB7IC4uLnJldCwgLi4ud2l0aEV4dHJhIH07XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGFuY2hvciArICcuJyArIHJlbW90ZUZpZWxkKSB9O1xuICAgIH1cblxuICAgIF9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKSB7XG4gICAgICAgIGlmICghcmVtb3RlRmllbGQpIHJldHVybiB1bmRlZmluZWQ7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQubWFwKHJmID0+IHRoaXMuX2dldEFsbFJlbGF0ZWRGaWVsZHMocmYpKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QocmVtb3RlRmllbGQpKSB7XG4gICAgICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQuYnk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVtb3RlRmllbGQ7XG4gICAgfVxuXG4gICAgX3ByZVByb2Nlc3NBc3NvY2lhdGlvbnMoZW50aXR5KSB7XG4gICAgICAgIHJldHVybiBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMubWFwKGFzc29jID0+IHtcbiAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkgcmV0dXJuIGFzc29jLnNyY0ZpZWxkO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHBsdXJhbGl6ZShhc3NvYy5kZXN0RW50aXR5KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIGhhc01hbnkvaGFzT25lIC0gYmVsb25nc1RvICAgICAgXG4gICAgICogaGFzTWFueS9oYXNPbmUgLSBoYXNNYW55L2hhc09uZSBbY29ubmVjdGVkQnldIFtjb25uZWN0ZWRXaXRoXVxuICAgICAqIGhhc01hbnkgLSBzZW1pIGNvbm5lY3Rpb24gICAgICAgXG4gICAgICogcmVmZXJzVG8gLSBzZW1pIGNvbm5lY3Rpb25cbiAgICAgKiAgICAgIFxuICAgICAqIHJlbW90ZUZpZWxkOlxuICAgICAqICAgMS4gZmllbGROYW1lXG4gICAgICogICAyLiBhcnJheSBvZiBmaWVsZE5hbWVcbiAgICAgKiAgIDMuIHsgYnkgLCB3aXRoIH1cbiAgICAgKiAgIDQuIGFycmF5IG9mIGZpZWxkTmFtZSBhbmQgeyBieSAsIHdpdGggfSBtaXhlZFxuICAgICAqICBcbiAgICAgKiBAcGFyYW0geyp9IHNjaGVtYSBcbiAgICAgKiBAcGFyYW0geyp9IGVudGl0eSBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jIFxuICAgICAqL1xuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jLCBhc3NvY05hbWVzKSB7XG4gICAgICAgIGxldCBlbnRpdHlLZXlGaWVsZCA9IGVudGl0eS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBhc3NlcnQ6ICFBcnJheS5pc0FycmF5KGVudGl0eUtleUZpZWxkKTtcblxuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICB0eXBlczogWyAncmVmZXJzVG8nIF0sIFxuICAgICAgICAgICAgICAgICAgICBhc3NvY2lhdGlvbjogYXNzb2MgXG4gICAgICAgICAgICAgICAgfTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJylbMF0gXG4gICAgICAgICAgICAgICAgICAgIH07XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLmNvbm5lY3RlZFdpdGggPSBhc3NvYy5jb25uZWN0ZWRXaXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGRzID0gdGhpcy5fZ2V0QWxsUmVsYXRlZEZpZWxkcyhhc3NvYy5yZW1vdGVGaWVsZCk7XG5cbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgc3JjRmllbGQ6IHJlbW90ZUZpZWxkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZCB8fCAocmVtb3RlRmllbGQgPSBlbnRpdHkubmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihyZW1vdGVGaWVsZCkgPiAtMSA6IHJlbW90ZUZpZWxkcyA9PT0gcmVtb3RlRmllbGQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgfTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcIm0yblwiIGFzc29jaWF0aW9uIHJlcXVpcmVzIFwiY29ubmVjdGVkQnlcIiBwcm9wZXJ0eS4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnIGRlc3RpbmF0aW9uOiAnICsgZGVzdEVudGl0eU5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGNvbm5lY3RlZCBieSBmaWVsZCBpcyB1c3VhbGx5IGEgcmVmZXJzVG8gYXNzb2NcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTsgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubkVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludGVyY29ubmVjdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiIG5vdCBmb3VuZCBpbiBzY2hlbWEuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTsgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IGxvY2FsRmllbGROYW1lIH0sIGVudGl0eS5rZXksIGxvY2FsRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2MuY29ubmVjdGVkV2l0aCA/IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBhc3NvYy5jb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IDogY29ubmVjdGVkQnlGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICApLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHJlbW90ZUZpZWxkTmFtZSA9IGJhY2tSZWYuc3JjRmllbGQgfHwgcGx1cmFsaXplKGVudGl0eS5uYW1lKTsgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGNvbm5FbnRpdHlOYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogdGhpcy5fdHJhbnNsYXRlSm9pbkNvbmRpdGlvbih7IC4uLmFzc29jTmFtZXMsIFtjb25uRW50aXR5TmFtZV06IHJlbW90ZUZpZWxkTmFtZSB9LCBkZXN0RW50aXR5LmtleSwgcmVtb3RlRmllbGROYW1lLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5jb25uZWN0ZWRXaXRoID8ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJ5OiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB3aXRoOiBiYWNrUmVmLmNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gOiBjb25uZWN0ZWRCeUZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYub3B0aW9uYWwgPyB7IG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsIH0gOiB7fSksICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyB7IGxpc3Q6IHRydWUgfSA6IHt9KSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGFuY2hvciA9IGFzc29jLnNyY0ZpZWxkIHx8IChhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpIDogZGVzdEVudGl0eU5hbWUpOyAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGQgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYW5jaG9yLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgLi4uYXNzb2NOYW1lcywgW2Rlc3RFbnRpdHlOYW1lXTogYW5jaG9yIH0sIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5rZXksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFuY2hvcixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4odHlwZW9mIHJlbW90ZUZpZWxkID09PSAnc3RyaW5nJyA/IHsgZmllbGQ6IHJlbW90ZUZpZWxkIH0gOiB7fSkgLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLm9wdGlvbmFsID8geyBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfSA6IHt9KSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeSA/IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5FbnRpdHlOYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgIFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIiBub3QgZm91bmQgaW4gc2NoZW1hLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAvL3RvZG86IGdldCBiYWNrIHJlZiBmcm9tIGNvbm5lY3Rpb24gZW50aXR5XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjEgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycsIHNyY0ZpZWxkOiAoZikgPT4gXy5pc05pbChmKSB8fCBmID09IGNvbm5lY3RlZEJ5RmllbGQgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uQmFja1JlZjEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ2Fubm90IGZpbmQgYmFjayByZWZlcmVuY2UgdG8gXCIke2VudGl0eS5uYW1lfVwiIGZyb20gcmVsYXRpb24gZW50aXR5IFwiJHtjb25uRW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uQmFja1JlZjIgPSBjb25uRW50aXR5LmdldFJlZmVyZW5jZVRvKGRlc3RFbnRpdHlOYW1lLCB7IHR5cGU6ICdyZWZlcnNUbycgfSwgeyBhc3NvY2lhdGlvbjogY29ubkJhY2tSZWYxICB9KTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5CYWNrUmVmMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDYW5ub3QgZmluZCBiYWNrIHJlZmVyZW5jZSB0byBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgZnJvbSByZWxhdGlvbiBlbnRpdHkgXCIke2Nvbm5FbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBjb25uQmFja1JlZjIuc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LiBEZXRhaWw6ICcgKyBKU09OLnN0cmluZ2lmeSh7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgc3JjOiBlbnRpdHkubmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0OiBkZXN0RW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBzcmNGaWVsZDogYXNzb2Muc3JjRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pKTtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5OiBjb25uRW50aXR5TmFtZSxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBrZXk6IGNvbm5FbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9uOiB0aGlzLl90cmFuc2xhdGVKb2luQ29uZGl0aW9uKHsgLi4uYXNzb2NOYW1lcywgW2Nvbm5FbnRpdHlOYW1lXTogbG9jYWxGaWVsZE5hbWUgfSwgZW50aXR5LmtleSwgbG9jYWxGaWVsZE5hbWUsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLmNvbm5lY3RlZFdpdGggPyB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBieTogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHdpdGg6IGFzc29jLmNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSA6IGNvbm5lY3RlZEJ5RmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICApICxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBmaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2Mub3B0aW9uYWwgPyB7IG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCB9IDoge30pLCAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBsaXN0OiB0cnVlIH0gOiB7fSksXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2M6IGNvbm5lY3RlZEJ5RmllbGQyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUHJvcHMgPSB7IC4uLl8ub21pdChkZXN0S2V5RmllbGQsIFsnb3B0aW9uYWwnLCAnZGVmYXVsdCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJywgJ2RlZmF1bHQnXSkgfTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGRlc3RFbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGtleTogZGVzdEVudGl0eS5rZXksXG4gICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbbG9jYWxGaWVsZF06IHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKGxvY2FsRmllbGQgKyAnLicgKyBkZXN0RW50aXR5LmtleSkgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIC8qXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3JlbW90ZUZpZWxkJzogKHJlbW90ZUZpZWxkKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZHMgPSB0aGlzLl9nZXRBbGxSZWxhdGVkRmllbGRzKHJlbW90ZUZpZWxkKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gXy5pc05pbChyZW1vdGVGaWVsZHMpIHx8IChBcnJheS5pc0FycmF5KHJlbW90ZUZpZWxkcykgPyByZW1vdGVGaWVsZHMuaW5kZXhPZihsb2NhbEZpZWxkKSA+IC0xIDogcmVtb3RlRmllbGRzID09PSBsb2NhbEZpZWxkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9LCAgLy8gaW5jbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgdHlwZXM6IFsgJ3JlZmVyc1RvJywgJ2JlbG9uZ3NUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH0gLy8gZXhjbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHk6IGVudGl0eS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAga2V5OiBlbnRpdHkua2V5LFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvbjogeyBbZGVzdEVudGl0eS5rZXldOiBsb2NhbEZpZWxkIH0sXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxpc3Q6IHRydWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogdHJ1ZVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgfSovXG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGNvbnRleHQsIG9vbENvbikge1xuICAgICAgICBhc3NlcnQ6IG9vbENvbi5vb2xUeXBlO1xuXG4gICAgICAgIGlmIChvb2xDb24ub29sVHlwZSA9PT0gJ0JpbmFyeUV4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICBpZiAob29sQ29uLm9wZXJhdG9yID09PSAnPT0nKSB7XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQgPSBvb2xDb24ubGVmdDtcbiAgICAgICAgICAgICAgICBpZiAobGVmdC5vb2xUeXBlICYmIGxlZnQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCBsZWZ0Lm5hbWUsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCByaWdodCA9IG9vbENvbi5yaWdodDtcbiAgICAgICAgICAgICAgICBpZiAocmlnaHQub29sVHlwZSAmJiByaWdodC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IHRoaXMuX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByaWdodC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgICAgICAgICBbbGVmdF06IHsgJyRlcSc6IHJpZ2h0IH1cbiAgICAgICAgICAgICAgICB9OyBcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBFcnJvcignVW5rbm93biBzeW50YXg6ICcgKyBKU09OLnN0cmluZ2lmeShvb2xDb24pKTtcbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZiwgYXNLZXkpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZyhjb250ZXh0KTtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZOYW1lID0gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcblxuICAgICAgICBpZiAoYXNLZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZWZOYW1lO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuX3RvQ29sdW1uUmVmZXJlbmNlKHJlZk5hbWUpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShsZWZ0RmllbGQpKSB7XG4gICAgICAgICAgICBsZWZ0RmllbGQuZm9yRWFjaChsZiA9PiB0aGlzLl9hZGRSZWZlcmVuY2UobGVmdCwgbGYsIHJpZ2h0LCByaWdodEZpZWxkKSk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGxlZnRGaWVsZCkpIHtcbiAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShsZWZ0LCBsZWZ0RmllbGQuYnksIHJpZ2h0LiByaWdodEZpZWxkKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGxlZnRGaWVsZCA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkgcmV0dXJuO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmaWVsZC5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTEubmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MS5uYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTIubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTEubmFtZSB9XG4gICAgICAgICk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgY29ubmVjdGVkQnlGaWVsZDIsIFxuICAgICAgICAgICAgeyBlbnRpdHk6IGVudGl0eTIubmFtZSB9XG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MS5uYW1lLCBrZXlFbnRpdHkxLm5hbWUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Mi5uYW1lLCBrZXlFbnRpdHkyLm5hbWUpO1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH1cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWxhdGlvbi5yaWdodCArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19