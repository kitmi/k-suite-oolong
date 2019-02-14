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

  _processAssociation(schema, entity, assoc) {
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
        } else if (assoc.remoteField) {
          includes = {
            srcField: assoc.remoteField
          };
        } else if (assoc.remoteFields) {
          if (!assoc.srcField) {
            throw new Error('"srcField" is required for multiple remote fields. Entity: ' + entity.name);
          }

          entity.addAssociation(assoc.srcField, destEntity, {
            optional: assoc.optional,
            remoteFields: assoc.remoteFields,
            ...(assoc.type === 'hasMany' ? {
              isList: true
            } : {})
          });
          return;
        }

        let backRef = destEntity.getReferenceTo(entity.name, includes, excludes);

        if (backRef) {
          if (backRef.type === 'hasMany' || backRef.type === 'hasOne') {
            let connectedByParts = assoc.connectedBy.split('.');

            if (!(connectedByParts.length <= 2)) {
              throw new Error("Assertion failed: connectedByParts.length <= 2");
            }

            let connectedByField = connectedByParts.length > 1 && connectedByParts[1] || entity.name;
            let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

            if (!connEntityName) {
              throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
            }

            let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:${backRef.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;
            let tag2 = `${destEntityName}:${backRef.type === 'hasMany' ? 'm' : '1'}-${entity.name}::${assoc.type === 'hasMany' ? 'n' : '1'} by ${connEntityName}`;

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
            entity.addAssociation(localFieldName, destEntity, {
              optional: assoc.optional,
              connectedBy: connEntityName,
              remoteField: connectedByField,
              refersToField: connectedByField2,
              ...(assoc.type === 'hasMany' ? {
                isList: true
              } : {}),
              ...(assoc.connectedWith ? {
                connectedWith: this._oolConditionToQueryCondition(entity, connEntity, destEntity, connectedByField, connectedByField2, assoc.connectedWith, localFieldName)
              } : {})
            });
            let remoteFieldName = backRef.srcField || pluralize(entity.name);
            destEntity.addAssociation(remoteFieldName, entity, {
              optional: backRef.optional,
              connectedBy: connEntityName,
              remoteField: connectedByField2,
              refersToField: connectedByField,
              ...(backRef.type === 'hasMany' ? {
                isList: true
              } : {}),
              ...(backRef.connectedWith ? {
                connectedWith: this._oolConditionToQueryCondition(destEntity, connEntity, entity, connectedByField2, connectedByField, backRef.connectedWith, remoteFieldName)
              } : {})
            });

            this._processedRef.add(tag1);

            this._processedRef.add(tag2);
          } else if (backRef.type === 'belongsTo') {
            if (assoc.connectedBy) {
              throw new Error('todo: belongsTo connectedBy. entity: ' + entity.name);
            } else {}
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
            throw new Error(`"connectedBy" required for m:n relation. Source: ${entity.name}, destination: ${destEntityName}`);
          }

          let tag1 = `${entity.name}:${assoc.type === 'hasMany' ? 'm' : '1'}-${destEntityName}:* by ${connEntityName}`;

          if (assoc.srcField) {
            tag1 += ' ' + assoc.srcField;
          }

          if (!!this._processedRef.has(tag1)) {
            throw new Error("Assertion failed: !this._processedRef.has(tag1)");
          }

          let connectedByField2 = destEntity.name;

          if (connectedByField === connectedByField2) {
            throw new Error('Cannot use the same "connectedBy" field in a relation entity.');
          }

          let connEntity = schema.entities[connEntityName];

          if (!connEntity) {
            connEntity = this._addRelationEntity(schema, connEntityName, connectedByField, connectedByField2);
          }

          this._updateRelationEntity(connEntity, entity, destEntity, connectedByField, connectedByField2);

          let localFieldName = assoc.srcField || pluralize(destEntityName);
          entity.addAssociation(localFieldName, destEntity, {
            optional: assoc.optional,
            connectedBy: connEntityName,
            remoteField: connectedByField,
            refersToField: connectedByField2,
            ...(assoc.type === 'hasMany' ? {
              isList: true
            } : {}),
            ...(assoc.connectedWith ? {
              connectedWith: this._oolConditionToQueryCondition(entity, connEntity, destEntity, connectedByField, connectedByField2, assoc.connectedWith, localFieldName)
            } : {})
          });

          this._processedRef.add(tag1);
        }

        break;

      case 'refersTo':
      case 'belongsTo':
        let localField = assoc.srcField || destEntityName;
        let fieldProps = { ..._.omit(destKeyField, ['optional']),
          ..._.pick(assoc, ['optional'])
        };
        entity.addAssocField(localField, destEntity, fieldProps);
        entity.addAssociation(localField, destEntity, {
          isList: false,
          optional: assoc.optional
        });

        if (assoc.type === 'belongsTo') {
          let backRef = destEntity.getReferenceTo(entity.name, {
            'remoteField': remoteField => _.isNil(remoteField) || remoteField == localField
          }, {
            types: ['refersTo', 'belongsTo'],
            association: assoc
          });

          if (!backRef) {
            destEntity.addAssociation(pluralize(entity.name), entity, {
              isList: true,
              remoteField: localField
            });
          } else {
            destEntity.addAssociation(backRef.srcField || pluralize(entity.name), entity, {
              isList: backRef.type === 'hasMany',
              remoteField: localField,
              optional: backRef.optional
            });
          }
        }

        this._addReference(entity.name, localField, destEntityName, destKeyField.name);

        break;
    }
  }

  _oolConditionToQueryCondition(entity, connEntity, destEntity, localFieldName, remoteFieldName, oolCon, anchor) {
    let context = {
      [connEntity.name]: anchor
    };

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
    let refs4LeftEntity = this._references[left];

    if (!refs4LeftEntity) {
      refs4LeftEntity = [];
      this._references[left] = refs4LeftEntity;
    } else {
      let found = _.find(refs4LeftEntity, item => item.leftField === leftField && item.right === right && item.rightField === rightField);

      if (found) {
        return this;
      }
    }

    refs4LeftEntity.push({
      leftField,
      right,
      rightField
    });
    return this;
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
    relationEntity.addAssociation(connectedByField, entity1);
    relationEntity.addAssociation(connectedByField2, entity2);

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImNvbnNvbGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjb25uZWN0ZWRCeSIsImNiIiwic3BsaXQiLCJjb25uZWN0ZWRXaXRoIiwicmVtb3RlRmllbGQiLCJzcmNGaWVsZCIsInJlbW90ZUZpZWxkcyIsImFkZEFzc29jaWF0aW9uIiwib3B0aW9uYWwiLCJpc0xpc3QiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwicmVmZXJzVG9GaWVsZCIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwicHJlZml4TmFtaW5nIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJpc05pbCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJhbmNob3IiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJtYXAiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsU0FBUyxHQUFHRCxPQUFPLENBQUMsV0FBRCxDQUF6Qjs7QUFDQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1JLElBQUksR0FBR0osT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHUixPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVMsTUFBTSxHQUFHVCxPQUFPLENBQUMsc0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTVUsS0FBSyxHQUFHVixPQUFPLENBQUMsd0JBQUQsQ0FBckI7O0FBRUEsTUFBTVcseUJBQXlCLEdBQUcsSUFBSUMsR0FBSixDQUFRLENBQUMsTUFBRCxFQUFTLE1BQVQsRUFBaUIsTUFBakIsRUFBeUIsVUFBekIsQ0FBUixDQUFsQzs7QUF1Q0EsTUFBTUMsWUFBTixDQUFtQjtBQVVmQyxFQUFBQSxXQUFXLENBQUNDLE9BQUQsRUFBVUMsU0FBVixFQUFxQkMsU0FBckIsRUFBZ0M7QUFDdkMsU0FBS0MsTUFBTCxHQUFjSCxPQUFPLENBQUNHLE1BQXRCO0FBQ0EsU0FBS0MsTUFBTCxHQUFjSixPQUFPLENBQUNJLE1BQXRCO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQkwsT0FBTyxDQUFDTSxnQkFBMUI7QUFDQSxTQUFLTCxTQUFMLEdBQWlCQSxTQUFqQjtBQUVBLFNBQUtNLE9BQUwsR0FBZSxJQUFJdkIsWUFBSixFQUFmO0FBRUEsU0FBS3dC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QUFVLENBQUNrTCxNQUFYLENBQWtCd0MsaUJBQWlCLENBQUNyTixNQUFwQyxDQUFiO0FBQ0g7QUFDSjs7QUFFRCxXQUFPNUQsUUFBUSxDQUFDb0gsWUFBVCxDQUFzQjdELFVBQXRCLENBQVA7QUFDSDs7QUExcENjOztBQTZwQ25CK04sTUFBTSxDQUFDQyxPQUFQLEdBQWlCbFIsWUFBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgRXZlbnRFbWl0dGVyID0gcmVxdWlyZSgnZXZlbnRzJyk7XG5jb25zdCBwbHVyYWxpemUgPSByZXF1aXJlKCdwbHVyYWxpemUnKTtcbmNvbnN0IHBhdGggPSByZXF1aXJlKCdwYXRoJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG5jb25zdCBVdGlsID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgXywgZnMsIHF1b3RlIH0gPSBVdGlsO1xuXG5jb25zdCBPb2xVdGlscyA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvT29sVXRpbHMnKTtcbmNvbnN0IEVudGl0eSA9IHJlcXVpcmUoJy4uLy4uLy4uL2xhbmcvRW50aXR5Jyk7XG5jb25zdCBUeXBlcyA9IHJlcXVpcmUoJy4uLy4uLy4uL3J1bnRpbWUvdHlwZXMnKTtcblxuY29uc3QgVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRSA9IG5ldyBTZXQoWydCTE9CJywgJ1RFWFQnLCAnSlNPTicsICdHRU9NRVRSWSddKTtcblxuLypcbmNvbnN0IE1ZU1FMX0tFWVdPUkRTID0gW1xuICAgICdzZWxlY3QnLFxuICAgICdmcm9tJyxcbiAgICAnd2hlcmUnLFxuICAgICdsaW1pdCcsXG4gICAgJ29yZGVyJyxcbiAgICAnZ3JvdXAnLFxuICAgICdkaXN0aW5jdCcsXG4gICAgJ2luc2VydCcsXG4gICAgJ3VwZGF0ZScsXG4gICAgJ2luJyxcbiAgICAnb2Zmc2V0JyxcbiAgICAnYnknLFxuICAgICdhc2MnLFxuICAgICdkZXNjJyxcbiAgICAnZGVsZXRlJyxcbiAgICAnYmVnaW4nLFxuICAgICdlbmQnLFxuICAgICdsZWZ0JyxcbiAgICAncmlnaHQnLFxuICAgICdqb2luJyxcbiAgICAnb24nLFxuICAgICdhbmQnLFxuICAgICdvcicsXG4gICAgJ25vdCcsXG4gICAgJ3JldHVybnMnLFxuICAgICdyZXR1cm4nLFxuICAgICdjcmVhdGUnLFxuICAgICdhbHRlcidcbl07XG4qL1xuXG4vKipcbiAqIE9vb2xvbmcgZGF0YWJhc2UgbW9kZWxlciBmb3IgbXlzcWwgZGIuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgTXlTUUxNb2RlbGVyIHtcbiAgICAvKiogICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb250ZXh0XG4gICAgICogQHByb3BlcnR5IHtMb2dnZXJ9IGNvbnRleHQubG9nZ2VyIC0gTG9nZ2VyIG9iamVjdCAgICAgXG4gICAgICogQHByb3BlcnR5IHtPb2xvbmdMaW5rZXJ9IGNvbnRleHQubGlua2VyIC0gT29sb25nIERTTCBsaW5rZXJcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoIC0gR2VuZXJhdGVkIHNjcmlwdCBwYXRoXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRiT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMuZGJcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLnRhYmxlXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29udGV4dCwgY29ubmVjdG9yLCBkYk9wdGlvbnMpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIgPSBjb250ZXh0LmxvZ2dlcjtcbiAgICAgICAgdGhpcy5saW5rZXIgPSBjb250ZXh0LmxpbmtlcjtcbiAgICAgICAgdGhpcy5vdXRwdXRQYXRoID0gY29udGV4dC5zY3JpcHRPdXRwdXRQYXRoO1xuICAgICAgICB0aGlzLmNvbm5lY3RvciA9IGNvbm5lY3RvcjtcblxuICAgICAgICB0aGlzLl9ldmVudHMgPSBuZXcgRXZlbnRFbWl0dGVyKCk7XG5cbiAgICAgICAgdGhpcy5fZGJPcHRpb25zID0gZGJPcHRpb25zID8ge1xuICAgICAgICAgICAgZGI6IF8ubWFwS2V5cyhkYk9wdGlvbnMuZGIsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKSxcbiAgICAgICAgICAgIHRhYmxlOiBfLm1hcEtleXMoZGJPcHRpb25zLnRhYmxlLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSlcbiAgICAgICAgfSA6IHt9O1xuXG4gICAgICAgIHRoaXMuX3JlZmVyZW5jZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllcyA9IHt9O1xuICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYgPSBuZXcgU2V0KCk7XG4gICAgfVxuXG4gICAgbW9kZWxpbmcoc2NoZW1hKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnaW5mbycsICdHZW5lcmF0aW5nIG15c3FsIHNjcmlwdHMgZm9yIHNjaGVtYSBcIicgKyBzY2hlbWEubmFtZSArICdcIi4uLicpO1xuXG4gICAgICAgIGxldCBtb2RlbGluZ1NjaGVtYSA9IHNjaGVtYS5jbG9uZSgpO1xuXG4gICAgICAgIHRoaXMubG9nZ2VyLmxvZygnZGVidWcnLCAnQnVpbGRpbmcgcmVsYXRpb25zLi4uJyk7XG5cbiAgICAgICAgbGV0IGV4aXN0aW5nRW50aXRpZXMgPSBPYmplY3QudmFsdWVzKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzKTtcblxuICAgICAgICBfLmVhY2goZXhpc3RpbmdFbnRpdGllcywgKGVudGl0eSkgPT4ge1xuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSkge1xuICAgICAgICAgICAgICAgIGlmIChlbnRpdHkubmFtZSA9PT0gJ2Nhc2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucy5mb3JFYWNoKGFzc29jID0+IHRoaXMuX3Byb2Nlc3NBc3NvY2lhdGlvbihtb2RlbGluZ1NjaGVtYSwgZW50aXR5LCBhc3NvYykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYWZ0ZXJSZWxhdGlvbnNoaXBCdWlsZGluZycpOyAgICAgICAgXG5cbiAgICAgICAgLy9idWlsZCBTUUwgc2NyaXB0c1xuICAgICAgICBsZXQgc3FsRmlsZXNEaXIgPSBwYXRoLmpvaW4oJ215c3FsJywgdGhpcy5jb25uZWN0b3IuZGF0YWJhc2UpO1xuICAgICAgICBsZXQgZGJGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2VudGl0aWVzLnNxbCcpO1xuICAgICAgICBsZXQgZmtGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3JlbGF0aW9ucy5zcWwnKTtcbiAgICAgICAgbGV0IGluaXRJZHhGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnaW5kZXgubGlzdCcpO1xuICAgICAgICBsZXQgaW5pdEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICcwLWluaXQuanNvbicpO1xuICAgICAgICBsZXQgdGFibGVTUUwgPSAnJywgcmVsYXRpb25TUUwgPSAnJywgZGF0YSA9IHt9O1xuXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS5lbnRpdGllcywgKGVudGl0eSwgZW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgZW50aXR5LmFkZEluZGV4ZXMoKTtcblxuICAgICAgICAgICAgbGV0IHJlc3VsdCA9IE15U1FMTW9kZWxlci5jb21wbGlhbmNlQ2hlY2soZW50aXR5KTtcbiAgICAgICAgICAgIGlmIChyZXN1bHQuZXJyb3JzLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIGxldCBtZXNzYWdlID0gJyc7XG4gICAgICAgICAgICAgICAgaWYgKHJlc3VsdC53YXJuaW5ncy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gJ1dhcm5pbmdzOiBcXG4nICsgcmVzdWx0Lndhcm5pbmdzLmpvaW4oJ1xcbicpICsgJ1xcbic7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG1lc3NhZ2UgKz0gcmVzdWx0LmVycm9ycy5qb2luKCdcXG4nKTtcblxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihtZXNzYWdlKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGVudGl0eS5mZWF0dXJlcykge1xuICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5mZWF0dXJlcywgKGYsIGZlYXR1cmVOYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBmLmZvckVhY2goZmYgPT4gdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZmYpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGYpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHRhYmxlU1FMICs9IHRoaXMuX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkgKyAnXFxuJztcblxuICAgICAgICAgICAgaWYgKGVudGl0eS5pbmZvLmRhdGEpIHtcbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gYC0tIEluaXRpYWwgZGF0YSBmb3IgZW50aXR5OiAke2VudGl0eU5hbWV9XFxuYDtcbiAgICAgICAgICAgICAgICBsZXQgZW50aXR5RGF0YSA9IFtdO1xuXG4gICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZW50aXR5LmluZm8uZGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmluZm8uZGF0YS5mb3JFYWNoKHJlY29yZCA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHsgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkgfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIF8uZm9yT3duKGVudGl0eS5pbmZvLmRhdGEsIChyZWNvcmQsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7W2VudGl0eS5rZXldOiBrZXksIFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpfTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0gT2JqZWN0LmFzc2lnbih7W2VudGl0eS5rZXldOiBrZXl9LCB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5RGF0YS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ0lOU0VSVCBJTlRPIGAnICsgZW50aXR5TmFtZSArICdgIFNFVCAnICsgXy5tYXAocmVjb3JkLCAodixrKSA9PiAnYCcgKyBrICsgJ2AgPSAnICsgSlNPTi5zdHJpbmdpZnkodikpLmpvaW4oJywgJykgKyAnO1xcbic7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eURhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGRhdGFbZW50aXR5TmFtZV0gPSBlbnRpdHlEYXRhO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnXFxuJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgXy5mb3JPd24odGhpcy5fcmVmZXJlbmNlcywgKHJlZnMsIHNyY0VudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIF8uZWFjaChyZWZzLCByZWYgPT4ge1xuICAgICAgICAgICAgICAgIHJlbGF0aW9uU1FMICs9IHRoaXMuX2FkZEZvcmVpZ25LZXlTdGF0ZW1lbnQoc3JjRW50aXR5TmFtZSwgcmVmKSArICdcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBkYkZpbGVQYXRoKSwgdGFibGVTUUwpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZmtGaWxlUGF0aCksIHJlbGF0aW9uU1FMKTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRGaWxlUGF0aCksIEpTT04uc3RyaW5naWZ5KGRhdGEsIG51bGwsIDQpKTtcblxuICAgICAgICAgICAgaWYgKCFmcy5leGlzdHNTeW5jKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCkpKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGluaXRJZHhGaWxlUGF0aCksICcwLWluaXQuanNvblxcbicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGZ1bmNTUUwgPSAnJztcbiAgICAgICAgXG4gICAgICAgIC8vcHJvY2VzcyB2aWV3XG4gICAgICAgIC8qXG4gICAgICAgIF8uZWFjaChtb2RlbGluZ1NjaGVtYS52aWV3cywgKHZpZXcsIHZpZXdOYW1lKSA9PiB7XG4gICAgICAgICAgICB2aWV3LmluZmVyVHlwZUluZm8obW9kZWxpbmdTY2hlbWEpO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGBDUkVBVEUgUFJPQ0VEVVJFICR7ZGJTZXJ2aWNlLmdldFZpZXdTUE5hbWUodmlld05hbWUpfShgO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICBsZXQgcGFyYW1TUUxzID0gW107XG4gICAgICAgICAgICAgICAgdmlldy5wYXJhbXMuZm9yRWFjaChwYXJhbSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIHBhcmFtU1FMcy5wdXNoKGBwJHtfLnVwcGVyRmlyc3QocGFyYW0ubmFtZSl9ICR7TXlTUUxNb2RlbGVyLmNvbHVtbkRlZmluaXRpb24ocGFyYW0sIHRydWUpfWApO1xuICAgICAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICAgICAgZnVuY1NRTCArPSBwYXJhbVNRTHMuam9pbignLCAnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgKVxcbkNPTU1FTlQgJ1NQIGZvciB2aWV3ICR7dmlld05hbWV9J1xcblJFQURTIFNRTCBEQVRBXFxuQkVHSU5cXG5gO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9IHRoaXMuX3ZpZXdEb2N1bWVudFRvU1FMKG1vZGVsaW5nU2NoZW1hLCB2aWV3KSArICc7JztcblxuICAgICAgICAgICAgZnVuY1NRTCArPSAnXFxuRU5EO1xcblxcbic7XG4gICAgICAgIH0pO1xuICAgICAgICAqL1xuXG4gICAgICAgIGxldCBzcEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncHJvY2VkdXJlcy5zcWwnKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIHNwRmlsZVBhdGgpLCBmdW5jU1FMKTtcblxuICAgICAgICByZXR1cm4gbW9kZWxpbmdTY2hlbWE7XG4gICAgfSAgICBcblxuICAgIF9wcm9jZXNzQXNzb2NpYXRpb24oc2NoZW1hLCBlbnRpdHksIGFzc29jKSB7XG4gICAgICAgIGxldCBkZXN0RW50aXR5TmFtZSA9IGFzc29jLmRlc3RFbnRpdHk7XG4gICAgICAgIC8vdG9kbzogY3Jvc3MgZGIgcmVmZXJlbmNlXG4gICAgICAgIGxldCBkZXN0RW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Rlc3RFbnRpdHlOYW1lXTtcbiAgICAgICAgaWYgKCFkZXN0RW50aXR5KSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgcmVmZXJlbmNlcyB0byBhbiB1bmV4aXN0aW5nIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZGVzdEtleUZpZWxkID0gZGVzdEVudGl0eS5nZXRLZXlGaWVsZCgpO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGRlc3RLZXlGaWVsZCkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRGVzdGluYXRpb24gZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIiB3aXRoIGNvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKGFzc29jLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2hhc09uZSc6XG4gICAgICAgICAgICBjYXNlICdoYXNNYW55JzogICBcbiAgICAgICAgICAgICAgICBsZXQgaW5jbHVkZXM7ICAgIFxuICAgICAgICAgICAgICAgIGxldCBleGNsdWRlcyA9IHsgdHlwZXM6IFsgJ3JlZmVyc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfTtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgZXhjbHVkZXMudHlwZXMucHVzaCgnYmVsb25nc1RvJyk7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBjb25uZWN0ZWRCeTogY2IgPT4gY2IgJiYgY2Iuc3BsaXQoJy4nKVswXSA9PT0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKVswXSB9O1xuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkV2l0aCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMuY29ubmVjdGVkV2l0aCA9IGFzc29jLmNvbm5lY3RlZFdpdGg7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLnJlbW90ZUZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzID0geyBzcmNGaWVsZDogYXNzb2MucmVtb3RlRmllbGQgfTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGFzc29jLnJlbW90ZUZpZWxkcykge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1wic3JjRmllbGRcIiBpcyByZXF1aXJlZCBmb3IgbXVsdGlwbGUgcmVtb3RlIGZpZWxkcy4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzb2Muc3JjRmllbGQsIFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkczogYXNzb2MucmVtb3RlRmllbGRzLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSlcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OjokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIsIGFzc29jLmNvbm5lY3RlZFdpdGgsIGxvY2FsRmllbGROYW1lKSB9IDoge30pIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZGVzdEVudGl0eSwgY29ubkVudGl0eSwgZW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkMiwgY29ubmVjdGVkQnlGaWVsZCwgYmFja1JlZi5jb25uZWN0ZWRXaXRoLCByZW1vdGVGaWVsZE5hbWUpIH0gOiB7fSkgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICBcbiAgICAgICAgICAgICAgICAgICAgLy8gc2VtaSBhc3NvY2lhdGlvbiBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5ID8gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKSA6IFsgT29sVXRpbHMucHJlZml4TmFtaW5nKGVudGl0eS5uYW1lLCBkZXN0RW50aXR5TmFtZSkgXTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5FbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyLCBhc3NvYy5jb25uZWN0ZWRXaXRoLCBsb2NhbEZpZWxkTmFtZSkgfSA6IHt9KSBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsIFxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IGZhbHNlLCBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5Lm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAncmVtb3RlRmllbGQnOiAocmVtb3RlRmllbGQpID0+IF8uaXNOaWwocmVtb3RlRmllbGQpIHx8IHJlbW90ZUZpZWxkID09IGxvY2FsRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sICAvLyBpbmNsdWRlc1xuICAgICAgICAgICAgICAgICAgICAgICAgeyB0eXBlczogWyAncmVmZXJzVG8nLCAnYmVsb25nc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfSAvLyBleGNsdWRlc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogdHJ1ZSwgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzTGlzdDogYmFja1JlZi50eXBlID09PSAnaGFzTWFueScsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBsb2NhbEZpZWxkTmFtZSwgcmVtb3RlRmllbGROYW1lLCBvb2xDb24sIGFuY2hvcikge1xuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBbY29ubkVudGl0eS5uYW1lXSA6IGFuY2hvclxuICAgICAgICB9OyAgICAgICAgXG5cbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZikge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZpZWxkLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBoYXNSZWZUb0VudGl0eTEgPSBmYWxzZSwgaGFzUmVmVG9FbnRpdHkyID0gZmFsc2U7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIF8uZWFjaChyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywgYXNzb2MgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAncmVmZXJzVG8nICYmIGFzc29jLmRlc3RFbnRpdHkgPT09IGVudGl0eTEubmFtZSAmJiAoYXNzb2Muc3JjRmllbGQgfHwgZW50aXR5MS5uYW1lKSA9PT0gY29ubmVjdGVkQnlGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTEgPSB0cnVlOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkyLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTIubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgIGhhc1JlZlRvRW50aXR5MiA9IHRydWU7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgIGlmIChoYXNSZWZUb0VudGl0eTEgJiYgaGFzUmVmVG9FbnRpdHkyKSB7XG4gICAgICAgICAgICAgICAgdGhpcy5fcmVsYXRpb25FbnRpdGllc1tyZWxhdGlvbkVudGl0eU5hbWVdID0gdHJ1ZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgZW50aXR5MVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIGVudGl0eTJcbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=