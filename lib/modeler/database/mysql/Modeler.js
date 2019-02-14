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
            destEntity.addAssociation(backRef.srcField || (backRef.type === 'hasMany' ? pluralize(entity.name) : entity.name), entity, {
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImNvbnNvbGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjb25uZWN0ZWRCeSIsImNiIiwic3BsaXQiLCJjb25uZWN0ZWRXaXRoIiwicmVtb3RlRmllbGQiLCJzcmNGaWVsZCIsInJlbW90ZUZpZWxkcyIsImFkZEFzc29jaWF0aW9uIiwib3B0aW9uYWwiLCJpc0xpc3QiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwicmVmZXJzVG9GaWVsZCIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwicHJlZml4TmFtaW5nIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJpc05pbCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJhbmNob3IiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJtYXAiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0cmltIiwic25ha2VDYXNlIiwidHJpbUVuZCIsInN0YXJ0c1dpdGgiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiQUFBQTs7OztBQUVBLE1BQU1BLFlBQVksR0FBR0MsT0FBTyxDQUFDLFFBQUQsQ0FBNUI7O0FBQ0EsTUFBTUMsU0FBUyxHQUFHRCxPQUFPLENBQUMsV0FBRCxDQUF6Qjs7QUFDQSxNQUFNRSxJQUFJLEdBQUdGLE9BQU8sQ0FBQyxNQUFELENBQXBCOztBQUNBLE1BQU1HLElBQUksR0FBR0gsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQUVBLE1BQU1JLElBQUksR0FBR0osT0FBTyxDQUFDLFVBQUQsQ0FBcEI7O0FBQ0EsTUFBTTtBQUFFSyxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLEVBQUw7QUFBU0MsRUFBQUE7QUFBVCxJQUFtQkgsSUFBekI7O0FBRUEsTUFBTUksUUFBUSxHQUFHUixPQUFPLENBQUMsd0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTVMsTUFBTSxHQUFHVCxPQUFPLENBQUMsc0JBQUQsQ0FBdEI7O0FBQ0EsTUFBTVUsS0FBSyxHQUFHVixPQUFPLENBQUMsd0JBQUQsQ0FBckI7O0FBRUEsTUFBTVcseUJBQXlCLEdBQUcsSUFBSUMsR0FBSixDQUFRLENBQUMsTUFBRCxFQUFTLE1BQVQsRUFBaUIsTUFBakIsRUFBeUIsVUFBekIsQ0FBUixDQUFsQzs7QUF1Q0EsTUFBTUMsWUFBTixDQUFtQjtBQVVmQyxFQUFBQSxXQUFXLENBQUNDLE9BQUQsRUFBVUMsU0FBVixFQUFxQkMsU0FBckIsRUFBZ0M7QUFDdkMsU0FBS0MsTUFBTCxHQUFjSCxPQUFPLENBQUNHLE1BQXRCO0FBQ0EsU0FBS0MsTUFBTCxHQUFjSixPQUFPLENBQUNJLE1BQXRCO0FBQ0EsU0FBS0MsVUFBTCxHQUFrQkwsT0FBTyxDQUFDTSxnQkFBMUI7QUFDQSxTQUFLTCxTQUFMLEdBQWlCQSxTQUFqQjtBQUVBLFNBQUtNLE9BQUwsR0FBZSxJQUFJdkIsWUFBSixFQUFmO0FBRUEsU0FBS3dC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Q0FBYTlOLFVBQWIsRUFBeUIwTixpQkFBekIsQ0FBSixFQUFpRDtBQUM3QzFOLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDa0wsTUFBWCxDQUFrQndDLGlCQUFpQixDQUFDck4sTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBTzVELFFBQVEsQ0FBQ29ILFlBQVQsQ0FBc0I3RCxVQUF0QixDQUFQO0FBQ0g7O0FBMXBDYzs7QUE2cENuQitOLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQmxSLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGx1cmFsaXplID0gcmVxdWlyZSgncGx1cmFsaXplJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50aXR5Lm5hbWUgPT09ICdjYXNlJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYykge1xuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IHR5cGVzOiBbICdyZWZlcnNUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgY29ubmVjdGVkQnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJylbMF0gfTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLmNvbm5lY3RlZFdpdGggPSBhc3NvYy5jb25uZWN0ZWRXaXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhc3NvYy5yZW1vdGVGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgc3JjRmllbGQ6IGFzc29jLnJlbW90ZUZpZWxkIH07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhc3NvYy5yZW1vdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcInNyY0ZpZWxkXCIgaXMgcmVxdWlyZWQgZm9yIG11bHRpcGxlIHJlbW90ZSBmaWVsZHMuIEVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLnNyY0ZpZWxkLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZHM6IGFzc29jLnJlbW90ZUZpZWxkcywgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTo6JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbY29ubkVudGl0eU5hbWVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyLCBhc3NvYy5jb25uZWN0ZWRXaXRoLCBsb2NhbEZpZWxkTmFtZSkgfSA6IHt9KSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGROYW1lID0gYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpOyAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyc1RvRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGRlc3RFbnRpdHksIGNvbm5FbnRpdHksIGVudGl0eSwgY29ubmVjdGVkQnlGaWVsZDIsIGNvbm5lY3RlZEJ5RmllbGQsIGJhY2tSZWYuY29ubmVjdGVkV2l0aCwgcmVtb3RlRmllbGROYW1lKSB9IDoge30pICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gY29ubmVjdGVkQnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgXG4gICAgICAgICAgICAgICAgICAgIC8vIHNlbWkgYXNzb2NpYXRpb24gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeSA/IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJykgOiBbIE9vbFV0aWxzLnByZWZpeE5hbWluZyhlbnRpdHkubmFtZSwgZGVzdEVudGl0eU5hbWUpIF07XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPD0gMjtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHlOYW1lKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMSA9IGAke2VudGl0eS5uYW1lfTokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2Rlc3RFbnRpdHlOYW1lfToqIGJ5ICR7Y29ubkVudGl0eU5hbWV9YDtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogIXRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkMiA9IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignQ2Fubm90IHVzZSB0aGUgc2FtZSBcImNvbm5lY3RlZEJ5XCIgZmllbGQgaW4gYSByZWxhdGlvbiBlbnRpdHkuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMiwgYXNzb2MuY29ubmVjdGVkV2l0aCwgbG9jYWxGaWVsZE5hbWUpIH0gOiB7fSkgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdyZWZlcnNUbyc6XG4gICAgICAgICAgICBjYXNlICdiZWxvbmdzVG8nOlxuICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkID0gYXNzb2Muc3JjRmllbGQgfHwgZGVzdEVudGl0eU5hbWU7XG4gICAgICAgICAgICAgICAgbGV0IGZpZWxkUHJvcHMgPSB7IC4uLl8ub21pdChkZXN0S2V5RmllbGQsIFsnb3B0aW9uYWwnXSksIC4uLl8ucGljayhhc3NvYywgWydvcHRpb25hbCddKSB9O1xuXG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jRmllbGQobG9jYWxGaWVsZCwgZGVzdEVudGl0eSwgZmllbGRQcm9wcyk7XG4gICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkLCBcbiAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgIHsgaXNMaXN0OiBmYWxzZSwgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsIH1cbiAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhcbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eS5uYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgJ3JlbW90ZUZpZWxkJzogKHJlbW90ZUZpZWxkKSA9PiBfLmlzTmlsKHJlbW90ZUZpZWxkKSB8fCByZW1vdGVGaWVsZCA9PSBsb2NhbEZpZWxkXG4gICAgICAgICAgICAgICAgICAgICAgICB9LCAgLy8gaW5jbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgdHlwZXM6IFsgJ3JlZmVyc1RvJywgJ2JlbG9uZ3NUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH0gLy8gZXhjbHVkZXNcbiAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBsdXJhbGl6ZShlbnRpdHkubmFtZSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IHRydWUsIHJlbW90ZUZpZWxkOiBsb2NhbEZpZWxkIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGJhY2tSZWYuc3JjRmllbGQgfHwgKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gcGx1cmFsaXplKGVudGl0eS5uYW1lKSA6IGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0xpc3Q6IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBiYWNrUmVmLm9wdGlvbmFsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UoZW50aXR5Lm5hbWUsIGxvY2FsRmllbGQsIGRlc3RFbnRpdHlOYW1lLCBkZXN0S2V5RmllbGQubmFtZSk7XG4gICAgICAgICAgICBicmVhaztcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgbG9jYWxGaWVsZE5hbWUsIHJlbW90ZUZpZWxkTmFtZSwgb29sQ29uLCBhbmNob3IpIHtcbiAgICAgICAgbGV0IGNvbnRleHQgPSB7IFxuICAgICAgICAgICAgW2Nvbm5FbnRpdHkubmFtZV0gOiBhbmNob3JcbiAgICAgICAgfTsgICAgICAgIFxuXG4gICAgICAgIGFzc2VydDogb29sQ29uLm9vbFR5cGU7XG5cbiAgICAgICAgaWYgKG9vbENvbi5vb2xUeXBlID09PSAnQmluYXJ5RXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgIGlmIChvb2xDb24ub3BlcmF0b3IgPT09ICc9PScpIHtcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCA9IG9vbENvbi5sZWZ0O1xuICAgICAgICAgICAgICAgIGlmIChsZWZ0Lm9vbFR5cGUgJiYgbGVmdC5vb2xUeXBlID09PSAnT2JqZWN0UmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICBsZWZ0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIGxlZnQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IHJpZ2h0ID0gb29sQ29uLnJpZ2h0O1xuICAgICAgICAgICAgICAgIGlmIChyaWdodC5vb2xUeXBlICYmIHJpZ2h0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gdGhpcy5fdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJpZ2h0Lm5hbWUpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICAgICAgICAgIFtsZWZ0XTogeyAnJGVxJzogcmlnaHQgfVxuICAgICAgICAgICAgICAgIH07IFxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuXG4gICAgX3RyYW5zbGF0ZVJlZmVyZW5jZShjb250ZXh0LCByZWYpIHtcbiAgICAgICAgbGV0IFsgYmFzZSwgLi4ub3RoZXIgXSA9IHJlZi5zcGxpdCgnLicpO1xuXG4gICAgICAgIGxldCB0cmFuc2xhdGVkID0gY29udGV4dFtiYXNlXTtcbiAgICAgICAgaWYgKCF0cmFuc2xhdGVkKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFJlZmVyZW5jZWQgb2JqZWN0IFwiJHtyZWZ9XCIgbm90IGZvdW5kIGluIGNvbnRleHQuYCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gWyB0cmFuc2xhdGVkLCAuLi5vdGhlciBdLmpvaW4oJy4nKTtcbiAgICB9XG5cbiAgICBfYWRkUmVmZXJlbmNlKGxlZnQsIGxlZnRGaWVsZCwgcmlnaHQsIHJpZ2h0RmllbGQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZWZzNExlZnRFbnRpdHkgPSBbXTtcbiAgICAgICAgICAgIHRoaXMuX3JlZmVyZW5jZXNbbGVmdF0gPSByZWZzNExlZnRFbnRpdHk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBsZXQgZm91bmQgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQgJiYgaXRlbS5yaWdodCA9PT0gcmlnaHQgJiYgaXRlbS5yaWdodEZpZWxkID09PSByaWdodEZpZWxkKVxuICAgICAgICAgICAgKTtcbiAgICBcbiAgICAgICAgICAgIGlmIChmb3VuZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICByZWZzNExlZnRFbnRpdHkucHVzaCh7bGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZH0pO1xuXG4gICAgICAgIHJldHVybiB0aGlzO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVmZXJlbmNlID0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VPZkZpZWxkKGxlZnQsIGxlZnRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHJldHVybiBmYWxzZTtcblxuICAgICAgICByZXR1cm4gKHVuZGVmaW5lZCAhPT0gXy5maW5kKHJlZnM0TGVmdEVudGl0eSxcbiAgICAgICAgICAgIGl0ZW0gPT4gKGl0ZW0ubGVmdEZpZWxkID09PSBsZWZ0RmllbGQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9nZXRSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICk7XG5cbiAgICAgICAgaWYgKCFyZWZlcmVuY2UpIHtcbiAgICAgICAgICAgIHJldHVybiB1bmRlZmluZWQ7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gcmVmZXJlbmNlO1xuICAgIH1cblxuICAgIF9oYXNSZWZlcmVuY2VCZXR3ZWVuKGxlZnQsIHJpZ2h0KSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5yaWdodCA9PT0gcmlnaHQpXG4gICAgICAgICkpO1xuICAgIH1cblxuICAgIF9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZWF0dXJlKSB7XG4gICAgICAgIGxldCBmaWVsZDtcblxuICAgICAgICBzd2l0Y2ggKGZlYXR1cmVOYW1lKSB7XG4gICAgICAgICAgICBjYXNlICdhdXRvSWQnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcblxuICAgICAgICAgICAgICAgIGlmIChmaWVsZC50eXBlID09PSAnaW50ZWdlcicgJiYgIWZpZWxkLmdlbmVyYXRvcikge1xuICAgICAgICAgICAgICAgICAgICBmaWVsZC5hdXRvSW5jcmVtZW50SWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICBpZiAoJ3N0YXJ0RnJvbScgaW4gZmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX2V2ZW50cy5vbignc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHkubmFtZSwgZXh0cmFPcHRzID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBleHRyYU9wdHNbJ0FVVE9fSU5DUkVNRU5UJ10gPSBmaWVsZC5zdGFydEZyb207XG4gICAgICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2NyZWF0ZVRpbWVzdGFtcCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuICAgICAgICAgICAgICAgIGZpZWxkLmlzQ3JlYXRlVGltZXN0YW1wID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndXBkYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNVcGRhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdsb2dpY2FsRGVsZXRpb24nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhdExlYXN0T25lTm90TnVsbCc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3ZhbGlkYXRlQWxsRmllbGRzT25DcmVhdGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ3N0YXRlVHJhY2tpbmcnOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdpMThuJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGZlYXR1cmUgXCInICsgZmVhdHVyZU5hbWUgKyAnXCIuJyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfd3JpdGVGaWxlKGZpbGVQYXRoLCBjb250ZW50KSB7XG4gICAgICAgIGZzLmVuc3VyZUZpbGVTeW5jKGZpbGVQYXRoKTtcbiAgICAgICAgZnMud3JpdGVGaWxlU3luYyhmaWxlUGF0aCwgY29udGVudCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRlZCBkYiBzY3JpcHQ6ICcgKyBmaWxlUGF0aCk7XG4gICAgfVxuXG4gICAgX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgcmVsYXRpb25FbnRpdHlOYW1lLCBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCkge1xuICAgICAgICBsZXQgZW50aXR5SW5mbyA9IHtcbiAgICAgICAgICAgIGZlYXR1cmVzOiBbICdjcmVhdGVUaW1lc3RhbXAnIF0sXG4gICAgICAgICAgICBrZXk6IFsgZW50aXR5MVJlZkZpZWxkLCBlbnRpdHkyUmVmRmllbGQgXVxuICAgICAgICB9O1xuXG4gICAgICAgIGxldCBlbnRpdHkgPSBuZXcgRW50aXR5KHRoaXMubGlua2VyLCByZWxhdGlvbkVudGl0eU5hbWUsIHNjaGVtYS5vb2xNb2R1bGUsIGVudGl0eUluZm8pO1xuICAgICAgICBlbnRpdHkubGluaygpO1xuXG4gICAgICAgIHNjaGVtYS5hZGRFbnRpdHkoZW50aXR5KTtcblxuICAgICAgICByZXR1cm4gZW50aXR5O1xuICAgIH1cblxuICAgIF91cGRhdGVSZWxhdGlvbkVudGl0eShyZWxhdGlvbkVudGl0eSwgZW50aXR5MSwgZW50aXR5MiwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgbGV0IHJlbGF0aW9uRW50aXR5TmFtZSA9IHJlbGF0aW9uRW50aXR5Lm5hbWU7XG5cbiAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5LmluZm8uYXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkxID0gZW50aXR5MS5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkxKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5MS5uYW1lfWApO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQga2V5RW50aXR5MiA9IGVudGl0eTIuZ2V0S2V5RmllbGQoKTtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoa2V5RW50aXR5MikpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgQ29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC4gRW50aXR5OiAke2VudGl0eTIubmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MSwgXy5vbWl0KGtleUVudGl0eTEsIFsnb3B0aW9uYWwnXSkpO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY0ZpZWxkKGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLCBfLm9taXQoa2V5RW50aXR5MiwgWydvcHRpb25hbCddKSk7XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkLCBcbiAgICAgICAgICAgIGVudGl0eTFcbiAgICAgICAgKTtcbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICBjb25uZWN0ZWRCeUZpZWxkMiwgXG4gICAgICAgICAgICBlbnRpdHkyXG4gICAgICAgICk7XG5cbiAgICAgICAgdGhpcy5fYWRkUmVmZXJlbmNlKHJlbGF0aW9uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgZW50aXR5MS5uYW1lLCBrZXlFbnRpdHkxLm5hbWUpO1xuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkMiwgZW50aXR5Mi5uYW1lLCBrZXlFbnRpdHkyLm5hbWUpO1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzW3JlbGF0aW9uRW50aXR5TmFtZV0gPSB0cnVlO1xuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sT3BUb1NxbChvcCkge1xuICAgICAgICBzd2l0Y2ggKG9wKSB7XG4gICAgICAgICAgICBjYXNlICc9JzpcbiAgICAgICAgICAgICAgICByZXR1cm4gJz0nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb29sT3BUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgICAgICAgICAgICAgICAgXG4gICAgICAgIH1cbiAgICB9XG4gICAgXG4gICAgc3RhdGljIG9vbFRvU3FsKHNjaGVtYSwgZG9jLCBvb2wsIHBhcmFtcykge1xuICAgICAgICBpZiAoIW9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICByZXR1cm4gb29sO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChvb2wub29sVHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnQmluYXJ5RXhwcmVzc2lvbic6XG4gICAgICAgICAgICAgICAgbGV0IGxlZnQsIHJpZ2h0O1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGlmIChvb2wubGVmdC5vb2xUeXBlKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5sZWZ0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSBvb2wubGVmdDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob29sLnJpZ2h0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbC5yaWdodCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IG9vbC5yaWdodDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyAnICcgKyBNeVNRTE1vZGVsZXIub29sT3BUb1NxbChvb2wub3BlcmF0b3IpICsgJyAnICsgcmlnaHQ7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNhc2UgJ09iamVjdFJlZmVyZW5jZSc6XG4gICAgICAgICAgICAgICAgaWYgKCFPb2xVdGlscy5pc01lbWJlckFjY2Vzcyhvb2wubmFtZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHBhcmFtcyAmJiBfLmZpbmQocGFyYW1zLCBwID0+IHAubmFtZSA9PT0gb29sLm5hbWUpICE9PSAtMSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdwJyArIF8udXBwZXJGaXJzdChvb2wubmFtZSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNpbmcgdG8gYSBub24tZXhpc3RpbmcgcGFyYW0gXCIke29vbC5uYW1lfVwiLmApO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHsgZW50aXR5Tm9kZSwgZW50aXR5LCBmaWVsZCB9ID0gT29sVXRpbHMucGFyc2VSZWZlcmVuY2VJbkRvY3VtZW50KHNjaGVtYSwgZG9jLCBvb2wubmFtZSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gZW50aXR5Tm9kZS5hbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGQubmFtZSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xUb1NxbCB0byBiZSBpbXBsZW1lbnRlZC4nKTsgXG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBzdGF0aWMgX29yZGVyQnlUb1NxbChzY2hlbWEsIGRvYywgb29sKSB7XG4gICAgICAgIHJldHVybiBNeVNRTE1vZGVsZXIub29sVG9TcWwoc2NoZW1hLCBkb2MsIHsgb29sVHlwZTogJ09iamVjdFJlZmVyZW5jZScsIG5hbWU6IG9vbC5maWVsZCB9KSArIChvb2wuYXNjZW5kID8gJycgOiAnIERFU0MnKTtcbiAgICB9XG5cbiAgICBfdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpIHtcbiAgICAgICAgbGV0IHNxbCA9ICcgICc7XG4gICAgICAgIC8vY29uc29sZS5sb2coJ3ZpZXc6ICcgKyB2aWV3Lm5hbWUpO1xuICAgICAgICBsZXQgZG9jID0gXy5jbG9uZURlZXAodmlldy5nZXREb2N1bWVudEhpZXJhcmNoeShtb2RlbGluZ1NjaGVtYSkpO1xuICAgICAgICAvL2NvbnNvbGUuZGlyKGRvYywge2RlcHRoOiA4LCBjb2xvcnM6IHRydWV9KTtcblxuICAgICAgICAvL2xldCBhbGlhc01hcHBpbmcgPSB7fTtcbiAgICAgICAgbGV0IFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3QobW9kZWxpbmdTY2hlbWEsIGRvYywgMCk7XG4gICAgICAgIFxuICAgICAgICBzcWwgKz0gJ1NFTEVDVCAnICsgY29sTGlzdC5qb2luKCcsICcpICsgJyBGUk9NICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgYWxpYXM7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoam9pbnMpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgam9pbnMuam9pbignICcpO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3LnNlbGVjdEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHZpZXcuc2VsZWN0QnkubWFwKHNlbGVjdCA9PiBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgc2VsZWN0LCB2aWV3LnBhcmFtcykpLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEdST1VQIEJZICcgKyB2aWV3Lmdyb3VwQnkubWFwKGNvbCA9PiBNeVNRTE1vZGVsZXIuX29yZGVyQnlUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBjb2wpKS5qb2luKCcsICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5vcmRlckJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgT1JERVIgQlkgJyArIHZpZXcub3JkZXJCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2tpcCA9IHZpZXcuc2tpcCB8fCAwO1xuICAgICAgICBpZiAodmlldy5saW1pdCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgJyArIE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBza2lwLCB2aWV3LnBhcmFtcykgKyAnLCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcubGltaXQsIHZpZXcucGFyYW1zKTtcbiAgICAgICAgfSBlbHNlIGlmICh2aWV3LnNraXApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHZpZXcuc2tpcCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBfYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KSB7XG4gICAgICAgIGxldCBlbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZG9jLmVudGl0eV07XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJbmRleCsrKTtcbiAgICAgICAgZG9jLmFsaWFzID0gYWxpYXM7XG5cbiAgICAgICAgbGV0IGNvbExpc3QgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKS5tYXAoayA9PiBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoaykpO1xuICAgICAgICBsZXQgam9pbnMgPSBbXTtcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShkb2Muc3ViRG9jdW1lbnRzKSkge1xuICAgICAgICAgICAgXy5mb3JPd24oZG9jLnN1YkRvY3VtZW50cywgKGRvYywgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICAgICAgbGV0IFsgc3ViQ29sTGlzdCwgc3ViQWxpYXMsIHN1YkpvaW5zLCBzdGFydEluZGV4MiBdID0gdGhpcy5fYnVpbGRWaWV3U2VsZWN0KHNjaGVtYSwgZG9jLCBzdGFydEluZGV4KTtcbiAgICAgICAgICAgICAgICBzdGFydEluZGV4ID0gc3RhcnRJbmRleDI7XG4gICAgICAgICAgICAgICAgY29sTGlzdCA9IGNvbExpc3QuY29uY2F0KHN1YkNvbExpc3QpO1xuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGpvaW5zLnB1c2goJ0xFRlQgSk9JTiAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MuZW50aXR5KSArICcgQVMgJyArIHN1YkFsaWFzXG4gICAgICAgICAgICAgICAgICAgICsgJyBPTiAnICsgYWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGZpZWxkTmFtZSkgKyAnID0gJyArXG4gICAgICAgICAgICAgICAgICAgIHN1YkFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihkb2MubGlua1dpdGhGaWVsZCkpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoc3ViSm9pbnMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGpvaW5zID0gam9pbnMuY29uY2F0KHN1YkpvaW5zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIGNvbExpc3QsIGFsaWFzLCBqb2lucywgc3RhcnRJbmRleCBdO1xuICAgIH1cblxuICAgIF9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdDUkVBVEUgVEFCTEUgSUYgTk9UIEVYSVNUUyBgJyArIGVudGl0eU5hbWUgKyAnYCAoXFxuJztcblxuICAgICAgICAvL2NvbHVtbiBkZWZpbml0aW9uc1xuICAgICAgICBfLmVhY2goZW50aXR5LmZpZWxkcywgKGZpZWxkLCBuYW1lKSA9PiB7XG4gICAgICAgICAgICBzcWwgKz0gJyAgJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIobmFtZSkgKyAnICcgKyBNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihmaWVsZCkgKyAnLFxcbic7XG4gICAgICAgIH0pO1xuXG4gICAgICAgIC8vcHJpbWFyeSBrZXlcbiAgICAgICAgc3FsICs9ICcgIFBSSU1BUlkgS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoZW50aXR5LmtleSkgKyAnKSxcXG4nO1xuXG4gICAgICAgIC8vb3RoZXIga2V5c1xuICAgICAgICBpZiAoZW50aXR5LmluZGV4ZXMgJiYgZW50aXR5LmluZGV4ZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgZW50aXR5LmluZGV4ZXMuZm9yRWFjaChpbmRleCA9PiB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgICc7XG4gICAgICAgICAgICAgICAgaWYgKGluZGV4LnVuaXF1ZSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJ1VOSVFVRSAnO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzcWwgKz0gJ0tFWSAoJyArIE15U1FMTW9kZWxlci5xdW90ZUxpc3RPclZhbHVlKGluZGV4LmZpZWxkcykgKyAnKSxcXG4nO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgbGluZXMgPSBbXTtcbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2JlZm9yZUVuZENvbHVtbkRlZmluaXRpb246JyArIGVudGl0eU5hbWUsIGxpbmVzKTtcbiAgICAgICAgaWYgKGxpbmVzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgbGluZXMuam9pbignLFxcbiAgJyk7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgPSBzcWwuc3Vic3RyKDAsIHNxbC5sZW5ndGgtMik7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJ1xcbiknO1xuXG4gICAgICAgIC8vdGFibGUgb3B0aW9uc1xuICAgICAgICBsZXQgZXh0cmFQcm9wcyA9IHt9O1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnc2V0VGFibGVPcHRpb25zOicgKyBlbnRpdHlOYW1lLCBleHRyYVByb3BzKTtcbiAgICAgICAgbGV0IHByb3BzID0gT2JqZWN0LmFzc2lnbih7fSwgdGhpcy5fZGJPcHRpb25zLnRhYmxlLCBleHRyYVByb3BzKTtcblxuICAgICAgICBzcWwgPSBfLnJlZHVjZShwcm9wcywgZnVuY3Rpb24ocmVzdWx0LCB2YWx1ZSwga2V5KSB7XG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0ICsgJyAnICsga2V5ICsgJz0nICsgdmFsdWU7XG4gICAgICAgIH0sIHNxbCk7XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cbiAgICBcbiAgICBfYWRkRm9yZWlnbktleVN0YXRlbWVudChlbnRpdHlOYW1lLCByZWxhdGlvbikge1xuICAgICAgICBsZXQgc3FsID0gJ0FMVEVSIFRBQkxFIGAnICsgZW50aXR5TmFtZSArXG4gICAgICAgICAgICAnYCBBREQgRk9SRUlHTiBLRVkgKGAnICsgcmVsYXRpb24ubGVmdEZpZWxkICsgJ2ApICcgK1xuICAgICAgICAgICAgJ1JFRkVSRU5DRVMgYCcgKyByZWxhdGlvbi5yaWdodCArICdgIChgJyArIHJlbGF0aW9uLnJpZ2h0RmllbGQgKyAnYCkgJztcblxuICAgICAgICBzcWwgKz0gJyc7XG5cbiAgICAgICAgaWYgKHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbZW50aXR5TmFtZV0pIHtcbiAgICAgICAgICAgIHNxbCArPSAnT04gREVMRVRFIENBU0NBREUgT04gVVBEQVRFIENBU0NBREUnO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgTk8gQUNUSU9OIE9OIFVQREFURSBOTyBBQ1RJT04nO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsICs9ICc7XFxuJztcblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBmb3JlaWduS2V5RmllbGROYW1pbmcoZW50aXR5TmFtZSwgZW50aXR5KSB7XG4gICAgICAgIGxldCBsZWZ0UGFydCA9IFV0aWwuXy5jYW1lbENhc2UoZW50aXR5TmFtZSk7XG4gICAgICAgIGxldCByaWdodFBhcnQgPSBVdGlsLnBhc2NhbENhc2UoZW50aXR5LmtleSk7XG5cbiAgICAgICAgaWYgKF8uZW5kc1dpdGgobGVmdFBhcnQsIHJpZ2h0UGFydCkpIHtcbiAgICAgICAgICAgIHJldHVybiBsZWZ0UGFydDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBsZWZ0UGFydCArIHJpZ2h0UGFydDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVTdHJpbmcoc3RyKSB7XG4gICAgICAgIHJldHVybiBcIidcIiArIHN0ci5yZXBsYWNlKC8nL2csIFwiXFxcXCdcIikgKyBcIidcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVJZGVudGlmaWVyKHN0cikge1xuICAgICAgICByZXR1cm4gXCJgXCIgKyBzdHIgKyBcImBcIjtcbiAgICB9XG5cbiAgICBzdGF0aWMgcXVvdGVMaXN0T3JWYWx1ZShvYmopIHtcbiAgICAgICAgcmV0dXJuIF8uaXNBcnJheShvYmopID9cbiAgICAgICAgICAgIG9iai5tYXAodiA9PiBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKHYpKS5qb2luKCcsICcpIDpcbiAgICAgICAgICAgIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIob2JqKTtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29tcGxpYW5jZUNoZWNrKGVudGl0eSkge1xuICAgICAgICBsZXQgcmVzdWx0ID0geyBlcnJvcnM6IFtdLCB3YXJuaW5nczogW10gfTtcblxuICAgICAgICBpZiAoIWVudGl0eS5rZXkpIHtcbiAgICAgICAgICAgIHJlc3VsdC5lcnJvcnMucHVzaCgnUHJpbWFyeSBrZXkgaXMgbm90IHNwZWNpZmllZC4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbkRlZmluaXRpb24oZmllbGQsIGlzUHJvYykge1xuICAgICAgICBsZXQgY29sO1xuICAgICAgICBcbiAgICAgICAgc3dpdGNoIChmaWVsZC50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdpbnRlZ2VyJzpcbiAgICAgICAgICAgIGNvbCA9IE15U1FMTW9kZWxlci5pbnRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnbnVtYmVyJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZmxvYXRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndGV4dCc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYm9vbGVhbic6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLmJvb2xDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnYmluYXJ5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYmluYXJ5Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2RhdGV0aW1lJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZGF0ZXRpbWVDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnb2JqZWN0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBjYXNlICdlbnVtJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuZW51bUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdhcnJheSc6XG4gICAgICAgICAgICBjb2wgPSAgTXlTUUxNb2RlbGVyLnRleHRDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIHR5cGUgXCInICsgZmllbGQudHlwZSArICdcIi4nKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB7IHNxbCwgdHlwZSB9ID0gY29sOyAgICAgICAgXG5cbiAgICAgICAgaWYgKCFpc1Byb2MpIHtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmNvbHVtbk51bGxhYmxlKGZpZWxkKTtcbiAgICAgICAgICAgIHNxbCArPSB0aGlzLmRlZmF1bHRWYWx1ZShmaWVsZCwgdHlwZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyBpbnRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCwgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5kaWdpdHMpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLmRpZ2l0cyA+IDEwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCSUdJTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDcpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNCkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiAyKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdTTUFMTElOVCc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVElOWUlOVCc7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHNxbCArPSBgKCR7aW5mby5kaWdpdHN9KWBcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmZvLnVuc2lnbmVkKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBVTlNJR05FRCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4geyBzcWwsIHR5cGUgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZmxvYXRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLnR5cGUgPT0gJ251bWJlcicgJiYgaW5mby5leGFjdCkge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdERUNJTUFMJztcblxuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA2NSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVG90YWwgZGlnaXRzIGV4Y2VlZCBtYXhpbXVtIGxpbWl0LicpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRE9VQkxFJztcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnRvdGFsRGlnaXRzID4gNTMpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0ZMT0FUJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgndG90YWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLnRvdGFsRGlnaXRzO1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcsICcgK2luZm8uZGVjaW1hbERpZ2l0cztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNxbCArPSAnKSc7XG5cbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGlmICgnZGVjaW1hbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmRlY2ltYWxEaWdpdHMgPiAyMykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyg1MywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSAge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygyMywgJyAraW5mby5kZWNpbWFsRGlnaXRzICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyB0ZXh0Q29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWwgPSAnJywgdHlwZTtcblxuICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCAmJiBpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0NIQVIoJyArIGluZm8uZml4ZWRMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICB0eXBlID0gJ0NIQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1URVhUJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiAyMDAwKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJDSEFSJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdURVhUJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBiaW5hcnlDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoIDw9IDI1NSkge1xuICAgICAgICAgICAgc3FsID0gJ0JJTkFSWSgnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQklOQVJZJztcbiAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCkge1xuICAgICAgICAgICAgaWYgKGluZm8ubWF4TGVuZ3RoID4gMTY3NzcyMTUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0xPTkdCTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGggPiA2NTUzNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTUVESVVNQkxPQic7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnVkFSQklOQVJZJztcbiAgICAgICAgICAgICAgICBpZiAoaW5mby5maXhlZExlbmd0aCkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJygnICsgaW5mby5tYXhMZW5ndGggKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdCTE9CJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBib29sQ29sdW1uRGVmaW5pdGlvbigpIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnVElOWUlOVCgxKScsIHR5cGU6ICdUSU5ZSU5UJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBkYXRldGltZUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsO1xuXG4gICAgICAgIGlmICghaW5mby5yYW5nZSB8fCBpbmZvLnJhbmdlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURVRJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICdkYXRlJykge1xuICAgICAgICAgICAgc3FsID0gJ0RBVEUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lJykge1xuICAgICAgICAgICAgc3FsID0gJ1RJTUUnO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd5ZWFyJykge1xuICAgICAgICAgICAgc3FsID0gJ1lFQVInO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ucmFuZ2UgPT09ICd0aW1lc3RhbXAnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZTogc3FsIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGVudW1Db2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgcmV0dXJuIHsgc3FsOiAnRU5VTSgnICsgXy5tYXAoaW5mby52YWx1ZXMsICh2KSA9PiBNeVNRTE1vZGVsZXIucXVvdGVTdHJpbmcodikpLmpvaW4oJywgJykgKyAnKScsIHR5cGU6ICdFTlVNJyB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBjb2x1bW5OdWxsYWJsZShpbmZvKSB7XG4gICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdvcHRpb25hbCcpICYmIGluZm8ub3B0aW9uYWwpIHtcbiAgICAgICAgICAgIHJldHVybiAnIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuICcgTk9UIE5VTEwnO1xuICAgIH1cblxuICAgIHN0YXRpYyBkZWZhdWx0VmFsdWUoaW5mbywgdHlwZSkge1xuICAgICAgICBpZiAoaW5mby5pc0NyZWF0ZVRpbWVzdGFtcCkge1xuICAgICAgICAgICAgaW5mby5jcmVhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIERFRkFVTFQgQ1VSUkVOVF9USU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8uYXV0b0luY3JlbWVudElkKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgQVVUT19JTkNSRU1FTlQnO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAoaW5mby5pc1VwZGF0ZVRpbWVzdGFtcCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgaW5mby51cGRhdGVCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIHJldHVybiAnIE9OIFVQREFURSBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJyc7XG5cbiAgICAgICAgaWYgKCFpbmZvLm9wdGlvbmFsKSB7ICAgICAgXG4gICAgICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpKSB7XG4gICAgICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm9bJ2RlZmF1bHQnXTtcblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoVHlwZXMuQk9PTEVBTi5zYW5pdGl6ZShkZWZhdWx0VmFsdWUpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgLy90b2RvOiBvdGhlciB0eXBlc1xuXG4gICAgICAgICAgICB9IGVsc2UgaWYgKCFpbmZvLmhhc093blByb3BlcnR5KCdhdXRvJykpIHtcbiAgICAgICAgICAgICAgICBpZiAoVU5TVVBQT1JURURfREVGQVVMVF9WQUxVRS5oYXModHlwZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcnO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChpbmZvLnR5cGUgPT09ICdib29sZWFuJyB8fCBpbmZvLnR5cGUgPT09ICdpbnRlZ2VyJyB8fCBpbmZvLnR5cGUgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgMCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdlbnVtJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAgcXVvdGUoaW5mby52YWx1ZXNbMF0pO1xuICAgICAgICAgICAgICAgIH0gIGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIFwiXCInO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9ICAgICAgICBcbiAgICBcbiAgICAgICAgLypcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ2RlZmF1bHQnKSAmJiB0eXBlb2YgaW5mby5kZWZhdWx0ID09PSAnb2JqZWN0JyAmJiBpbmZvLmRlZmF1bHQub29sVHlwZSA9PT0gJ1N5bWJvbFRva2VuJykge1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRWYWx1ZSA9IGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgIGxldCBkZWZhdWx0QnlEYiA9IGZhbHNlO1xuXG4gICAgICAgICAgICBzd2l0Y2ggKGRlZmF1bHRWYWx1ZS5uYW1lKSB7XG4gICAgICAgICAgICAgICAgY2FzZSAnbm93JzpcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIE5PVydcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGRlZmF1bHRCeURiKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGluZm8uZGVmYXVsdDtcbiAgICAgICAgICAgICAgICBpbmZvLmRlZmF1bHRCeURiID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2wnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNTdHJpbmcoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoUyhkZWZhdWx0VmFsdWUpLnRvQm9vbGVhbigpID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyAoZGVmYXVsdFZhbHVlID8gJzEnIDogJzAnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2ludCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUludChkZWZhdWx0VmFsdWUpLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd0ZXh0Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZmxvYXQnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNOdW1iZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBwYXJzZUZsb2F0KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2JpbmFyeScpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLmJpbjJIZXgoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnZGF0ZXRpbWUnKSB7XG4gICAgICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKGRlZmF1bHRWYWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgZGVmYXVsdFZhbHVlLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnanNvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAodHlwZW9mIGRlZmF1bHRWYWx1ZSA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoSlNPTi5zdHJpbmdpZnkoZGVmYXVsdFZhbHVlKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICd4bWwnIHx8IGluZm8udHlwZSA9PT0gJ2VudW0nIHx8IGluZm8udHlwZSA9PT0gJ2NzdicpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG4gICAgICAgICovICAgIFxuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHNxbDtcbiAgICB9XG5cbiAgICBzdGF0aWMgcmVtb3ZlVGFibGVOYW1lUHJlZml4KGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgIGlmIChyZW1vdmVUYWJsZVByZWZpeCkge1xuICAgICAgICAgICAgZW50aXR5TmFtZSA9IF8udHJpbShfLnNuYWtlQ2FzZShlbnRpdHlOYW1lKSk7XG5cbiAgICAgICAgICAgIHJlbW92ZVRhYmxlUHJlZml4ID0gXy50cmltRW5kKF8uc25ha2VDYXNlKHJlbW92ZVRhYmxlUHJlZml4KSwgJ18nKSArICdfJztcblxuICAgICAgICAgICAgaWYgKF8uc3RhcnRzV2l0aChlbnRpdHlOYW1lLCByZW1vdmVUYWJsZVByZWZpeCkpIHtcbiAgICAgICAgICAgICAgICBlbnRpdHlOYW1lID0gZW50aXR5TmFtZS5zdWJzdHIocmVtb3ZlVGFibGVQcmVmaXgubGVuZ3RoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBPb2xVdGlscy5lbnRpdHlOYW1pbmcoZW50aXR5TmFtZSk7XG4gICAgfTtcbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTE1vZGVsZXI7Il19