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
          if (!assoc.connectedBy) {
            throw assoc;
          }

          let connectedByParts = assoc.connectedBy.split('.');

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
          let backRef = destEntity.getReferenceTo(entity.name, null, {
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
      if (relationEntityName === 'companyRole') {
        console.dir(relationEntity.info.associations, {
          depth: 10,
          colors: true
        });
        console.log(connectedByField, connectedByField2);
      }

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

        if (relationEntityName === 'companyRole') {
          console.log('OK');
        }

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImNvbnNvbGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjb25uZWN0ZWRCeSIsImNiIiwic3BsaXQiLCJjb25uZWN0ZWRXaXRoIiwiYmFja1JlZiIsImdldFJlZmVyZW5jZVRvIiwiY29ubmVjdGVkQnlQYXJ0cyIsImNvbm5lY3RlZEJ5RmllbGQiLCJjb25uRW50aXR5TmFtZSIsImVudGl0eU5hbWluZyIsInRhZzEiLCJ0YWcyIiwic3JjRmllbGQiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwiYWRkQXNzb2NpYXRpb24iLCJvcHRpb25hbCIsInJlbW90ZUZpZWxkIiwicmVmZXJzVG9GaWVsZCIsImlzTGlzdCIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJfYWRkUmVmZXJlbmNlIiwib29sQ29uIiwiYW5jaG9yIiwib29sVHlwZSIsIm9wZXJhdG9yIiwibGVmdCIsIl90cmFuc2xhdGVSZWZlcmVuY2UiLCJyaWdodCIsImJhc2UiLCJvdGhlciIsInRyYW5zbGF0ZWQiLCJsZWZ0RmllbGQiLCJyaWdodEZpZWxkIiwicmVmczRMZWZ0RW50aXR5IiwiZm91bmQiLCJmaW5kIiwiaXRlbSIsIl9nZXRSZWZlcmVuY2VPZkZpZWxkIiwidW5kZWZpbmVkIiwicmVmZXJlbmNlIiwiX2hhc1JlZmVyZW5jZU9mRmllbGQiLCJfZ2V0UmVmZXJlbmNlQmV0d2VlbiIsIl9oYXNSZWZlcmVuY2VCZXR3ZWVuIiwiZmVhdHVyZSIsImZpZWxkIiwiZ2VuZXJhdG9yIiwiYXV0b0luY3JlbWVudElkIiwib24iLCJleHRyYU9wdHMiLCJzdGFydEZyb20iLCJpc0NyZWF0ZVRpbWVzdGFtcCIsImlzVXBkYXRlVGltZXN0YW1wIiwiZmlsZVBhdGgiLCJjb250ZW50IiwiZW5zdXJlRmlsZVN5bmMiLCJ3cml0ZUZpbGVTeW5jIiwicmVsYXRpb25FbnRpdHlOYW1lIiwiZW50aXR5MVJlZkZpZWxkIiwiZW50aXR5MlJlZkZpZWxkIiwiZW50aXR5SW5mbyIsImxpbmsiLCJhZGRFbnRpdHkiLCJyZWxhdGlvbkVudGl0eSIsImVudGl0eTEiLCJlbnRpdHkyIiwiZGlyIiwiZGVwdGgiLCJjb2xvcnMiLCJoYXNSZWZUb0VudGl0eTEiLCJoYXNSZWZUb0VudGl0eTIiLCJrZXlFbnRpdHkxIiwia2V5RW50aXR5MiIsIm9vbE9wVG9TcWwiLCJvcCIsIm9vbFRvU3FsIiwiZG9jIiwib29sIiwicGFyYW1zIiwiaXNNZW1iZXJBY2Nlc3MiLCJwIiwidXBwZXJGaXJzdCIsImVudGl0eU5vZGUiLCJwYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQiLCJhbGlhcyIsInF1b3RlSWRlbnRpZmllciIsIl9vcmRlckJ5VG9TcWwiLCJhc2NlbmQiLCJfdmlld0RvY3VtZW50VG9TUUwiLCJ2aWV3Iiwic3FsIiwiY2xvbmVEZWVwIiwiZ2V0RG9jdW1lbnRIaWVyYXJjaHkiLCJjb2xMaXN0Iiwiam9pbnMiLCJfYnVpbGRWaWV3U2VsZWN0Iiwic2VsZWN0QnkiLCJtYXAiLCJzZWxlY3QiLCJncm91cEJ5IiwiY29sIiwib3JkZXJCeSIsInNraXAiLCJsaW1pdCIsInN0YXJ0SW5kZXgiLCJrIiwic3ViRG9jdW1lbnRzIiwiZmllbGROYW1lIiwic3ViQ29sTGlzdCIsInN1YkFsaWFzIiwic3ViSm9pbnMiLCJzdGFydEluZGV4MiIsImNvbmNhdCIsImxpbmtXaXRoRmllbGQiLCJjb2x1bW5EZWZpbml0aW9uIiwicXVvdGVMaXN0T3JWYWx1ZSIsImluZGV4ZXMiLCJpbmRleCIsInVuaXF1ZSIsImxpbmVzIiwic3Vic3RyIiwiZXh0cmFQcm9wcyIsInByb3BzIiwicmVkdWNlIiwicmVsYXRpb24iLCJmb3JlaWduS2V5RmllbGROYW1pbmciLCJsZWZ0UGFydCIsImNhbWVsQ2FzZSIsInJpZ2h0UGFydCIsInBhc2NhbENhc2UiLCJlbmRzV2l0aCIsInF1b3RlU3RyaW5nIiwic3RyIiwicmVwbGFjZSIsIm9iaiIsInYiLCJpc1Byb2MiLCJpbnRDb2x1bW5EZWZpbml0aW9uIiwiZmxvYXRDb2x1bW5EZWZpbml0aW9uIiwidGV4dENvbHVtbkRlZmluaXRpb24iLCJib29sQ29sdW1uRGVmaW5pdGlvbiIsImJpbmFyeUNvbHVtbkRlZmluaXRpb24iLCJkYXRldGltZUNvbHVtbkRlZmluaXRpb24iLCJlbnVtQ29sdW1uRGVmaW5pdGlvbiIsImNvbHVtbk51bGxhYmxlIiwiZGVmYXVsdFZhbHVlIiwiZGlnaXRzIiwidW5zaWduZWQiLCJleGFjdCIsInRvdGFsRGlnaXRzIiwiZGVjaW1hbERpZ2l0cyIsImZpeGVkTGVuZ3RoIiwibWF4TGVuZ3RoIiwicmFuZ2UiLCJoYXNPd25Qcm9wZXJ0eSIsImNyZWF0ZUJ5RGIiLCJ1cGRhdGVCeURiIiwiQk9PTEVBTiIsInNhbml0aXplIiwicmVtb3ZlVGFibGVOYW1lUHJlZml4IiwicmVtb3ZlVGFibGVQcmVmaXgiLCJ0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QUFHLElBQUksY0FBZTVNLEtBQUssQ0FBQ3VDLElBQUksQ0FBQ0wsTUFBTCxDQUFZLENBQVosQ0FBRCxDQUEzQjtBQUNILFNBRk0sTUFFQztBQUNKMEssVUFBQUEsR0FBRyxJQUFJLGFBQVA7QUFDSDs7QUFFRHJLLFFBQUFBLElBQUksQ0FBQ3NPLFVBQUwsR0FBa0IsSUFBbEI7QUFDSDtBQUNKOztBQTRERCxXQUFPakUsR0FBUDtBQUNIOztBQUVELFNBQU9xRSxxQkFBUCxDQUE2QnpOLFVBQTdCLEVBQXlDME4saUJBQXpDLEVBQTREO0FBQ3hELFFBQUlBLGlCQUFKLEVBQXVCO0FBQ25CMU4sTUFBQUEsVUFBVSxHQUFHMUQsQ0FBQyxDQUFDcVIsSUFBRixDQUFPclIsQ0FBQyxDQUFDc1IsU0FBRixDQUFZNU4sVUFBWixDQUFQLENBQWI7QUFFQTBOLE1BQUFBLGlCQUFpQixHQUFHcFIsQ0FBQyxDQUFDdVIsT0FBRixDQUFVdlIsQ0FBQyxDQUFDc1IsU0FBRixDQUFZRixpQkFBWixDQUFWLEVBQTBDLEdBQTFDLElBQWlELEdBQXJFOztBQUVBLFVBQUlwUixDQUFDLENBQUN3UixVQUFGLENBQWE5TixVQUFiLEVBQXlCME4saUJBQXpCLENBQUosRUFBaUQ7QUFDN0MxTixRQUFBQSxVQUFVLEdBQUdBLFVBQVUsQ0FBQ2tMLE1BQVgsQ0FBa0J3QyxpQkFBaUIsQ0FBQ3JOLE1BQXBDLENBQWI7QUFDSDtBQUNKOztBQUVELFdBQU81RCxRQUFRLENBQUM4RyxZQUFULENBQXNCdkQsVUFBdEIsQ0FBUDtBQUNIOztBQTNvQ2M7O0FBOG9DbkIrTixNQUFNLENBQUNDLE9BQVAsR0FBaUJsUixZQUFqQiIsInNvdXJjZXNDb250ZW50IjpbIlwidXNlIHN0cmljdFwiO1xuXG5jb25zdCBFdmVudEVtaXR0ZXIgPSByZXF1aXJlKCdldmVudHMnKTtcbmNvbnN0IHBsdXJhbGl6ZSA9IHJlcXVpcmUoJ3BsdXJhbGl6ZScpO1xuY29uc3QgcGF0aCA9IHJlcXVpcmUoJ3BhdGgnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbmNvbnN0IFV0aWwgPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBfLCBmcywgcXVvdGUgfSA9IFV0aWw7XG5cbmNvbnN0IE9vbFV0aWxzID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9Pb2xVdGlscycpO1xuY29uc3QgRW50aXR5ID0gcmVxdWlyZSgnLi4vLi4vLi4vbGFuZy9FbnRpdHknKTtcbmNvbnN0IFR5cGVzID0gcmVxdWlyZSgnLi4vLi4vLi4vcnVudGltZS90eXBlcycpO1xuXG5jb25zdCBVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFID0gbmV3IFNldChbJ0JMT0InLCAnVEVYVCcsICdKU09OJywgJ0dFT01FVFJZJ10pO1xuXG4vKlxuY29uc3QgTVlTUUxfS0VZV09SRFMgPSBbXG4gICAgJ3NlbGVjdCcsXG4gICAgJ2Zyb20nLFxuICAgICd3aGVyZScsXG4gICAgJ2xpbWl0JyxcbiAgICAnb3JkZXInLFxuICAgICdncm91cCcsXG4gICAgJ2Rpc3RpbmN0JyxcbiAgICAnaW5zZXJ0JyxcbiAgICAndXBkYXRlJyxcbiAgICAnaW4nLFxuICAgICdvZmZzZXQnLFxuICAgICdieScsXG4gICAgJ2FzYycsXG4gICAgJ2Rlc2MnLFxuICAgICdkZWxldGUnLFxuICAgICdiZWdpbicsXG4gICAgJ2VuZCcsXG4gICAgJ2xlZnQnLFxuICAgICdyaWdodCcsXG4gICAgJ2pvaW4nLFxuICAgICdvbicsXG4gICAgJ2FuZCcsXG4gICAgJ29yJyxcbiAgICAnbm90JyxcbiAgICAncmV0dXJucycsXG4gICAgJ3JldHVybicsXG4gICAgJ2NyZWF0ZScsXG4gICAgJ2FsdGVyJ1xuXTtcbiovXG5cbi8qKlxuICogT29vbG9uZyBkYXRhYmFzZSBtb2RlbGVyIGZvciBteXNxbCBkYi5cbiAqIEBjbGFzc1xuICovXG5jbGFzcyBNeVNRTE1vZGVsZXIge1xuICAgIC8qKiAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbnRleHRcbiAgICAgKiBAcHJvcGVydHkge0xvZ2dlcn0gY29udGV4dC5sb2dnZXIgLSBMb2dnZXIgb2JqZWN0ICAgICBcbiAgICAgKiBAcHJvcGVydHkge09vbG9uZ0xpbmtlcn0gY29udGV4dC5saW5rZXIgLSBPb2xvbmcgRFNMIGxpbmtlclxuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGggLSBHZW5lcmF0ZWQgc2NyaXB0IHBhdGhcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGJPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy5kYlxuICAgICAqIEBwcm9wZXJ0eSB7b2JqZWN0fSBkYk9wdGlvbnMudGFibGVcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb250ZXh0LCBjb25uZWN0b3IsIGRiT3B0aW9ucykge1xuICAgICAgICB0aGlzLmxvZ2dlciA9IGNvbnRleHQubG9nZ2VyO1xuICAgICAgICB0aGlzLmxpbmtlciA9IGNvbnRleHQubGlua2VyO1xuICAgICAgICB0aGlzLm91dHB1dFBhdGggPSBjb250ZXh0LnNjcmlwdE91dHB1dFBhdGg7XG4gICAgICAgIHRoaXMuY29ubmVjdG9yID0gY29ubmVjdG9yO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cyA9IG5ldyBFdmVudEVtaXR0ZXIoKTtcblxuICAgICAgICB0aGlzLl9kYk9wdGlvbnMgPSBkYk9wdGlvbnMgPyB7XG4gICAgICAgICAgICBkYjogXy5tYXBLZXlzKGRiT3B0aW9ucy5kYiwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpLFxuICAgICAgICAgICAgdGFibGU6IF8ubWFwS2V5cyhkYk9wdGlvbnMudGFibGUsICh2YWx1ZSwga2V5KSA9PiBfLnVwcGVyQ2FzZShrZXkpKVxuICAgICAgICB9IDoge307XG5cbiAgICAgICAgdGhpcy5fcmVmZXJlbmNlcyA9IHt9O1xuICAgICAgICB0aGlzLl9yZWxhdGlvbkVudGl0aWVzID0ge307XG4gICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZiA9IG5ldyBTZXQoKTtcbiAgICB9XG5cbiAgICBtb2RlbGluZyhzY2hlbWEpIHtcbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdpbmZvJywgJ0dlbmVyYXRpbmcgbXlzcWwgc2NyaXB0cyBmb3Igc2NoZW1hIFwiJyArIHNjaGVtYS5uYW1lICsgJ1wiLi4uJyk7XG5cbiAgICAgICAgbGV0IG1vZGVsaW5nU2NoZW1hID0gc2NoZW1hLmNsb25lKCk7XG5cbiAgICAgICAgdGhpcy5sb2dnZXIubG9nKCdkZWJ1ZycsICdCdWlsZGluZyByZWxhdGlvbnMuLi4nKTtcblxuICAgICAgICBsZXQgZXhpc3RpbmdFbnRpdGllcyA9IE9iamVjdC52YWx1ZXMobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMpO1xuXG4gICAgICAgIF8uZWFjaChleGlzdGluZ0VudGl0aWVzLCAoZW50aXR5KSA9PiB7XG4gICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpKSB7XG4gICAgICAgICAgICAgICAgaWYgKGVudGl0eS5uYW1lID09PSAnY2FzZScpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coZW50aXR5LmluZm8uYXNzb2NpYXRpb25zKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZW50aXR5LmluZm8uYXNzb2NpYXRpb25zLmZvckVhY2goYXNzb2MgPT4gdGhpcy5fcHJvY2Vzc0Fzc29jaWF0aW9uKG1vZGVsaW5nU2NoZW1hLCBlbnRpdHksIGFzc29jKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdhZnRlclJlbGF0aW9uc2hpcEJ1aWxkaW5nJyk7ICAgICAgICBcblxuICAgICAgICAvL2J1aWxkIFNRTCBzY3JpcHRzXG4gICAgICAgIGxldCBzcWxGaWxlc0RpciA9IHBhdGguam9pbignbXlzcWwnLCB0aGlzLmNvbm5lY3Rvci5kYXRhYmFzZSk7XG4gICAgICAgIGxldCBkYkZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZW50aXRpZXMuc3FsJyk7XG4gICAgICAgIGxldCBma0ZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAncmVsYXRpb25zLnNxbCcpO1xuICAgICAgICBsZXQgaW5pdElkeEZpbGVQYXRoID0gcGF0aC5qb2luKHNxbEZpbGVzRGlyLCAnZGF0YScsICdfaW5pdCcsICdpbmRleC5saXN0Jyk7XG4gICAgICAgIGxldCBpbml0RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJzAtaW5pdC5qc29uJyk7XG4gICAgICAgIGxldCB0YWJsZVNRTCA9ICcnLCByZWxhdGlvblNRTCA9ICcnLCBkYXRhID0ge307XG5cbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLmVudGl0aWVzLCAoZW50aXR5LCBlbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBlbnRpdHkuYWRkSW5kZXhlcygpO1xuXG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gTXlTUUxNb2RlbGVyLmNvbXBsaWFuY2VDaGVjayhlbnRpdHkpO1xuICAgICAgICAgICAgaWYgKHJlc3VsdC5lcnJvcnMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1lc3NhZ2UgPSAnJztcbiAgICAgICAgICAgICAgICBpZiAocmVzdWx0Lndhcm5pbmdzLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICAgICAgbWVzc2FnZSArPSAnV2FybmluZ3M6IFxcbicgKyByZXN1bHQud2FybmluZ3Muam9pbignXFxuJykgKyAnXFxuJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbWVzc2FnZSArPSByZXN1bHQuZXJyb3JzLmpvaW4oJ1xcbicpO1xuXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKG1lc3NhZ2UpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmZlYXR1cmVzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmZlYXR1cmVzLCAoZiwgZmVhdHVyZU5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGYuZm9yRWFjaChmZiA9PiB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmZikpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZmVhdHVyZVJlZHVjZXIoZW50aXR5LCBmZWF0dXJlTmFtZSwgZik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgdGFibGVTUUwgKz0gdGhpcy5fY3JlYXRlVGFibGVTdGF0ZW1lbnQoZW50aXR5TmFtZSwgZW50aXR5KSArICdcXG4nO1xuXG4gICAgICAgICAgICBpZiAoZW50aXR5LmluZm8uZGF0YSkge1xuICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSBgLS0gSW5pdGlhbCBkYXRhIGZvciBlbnRpdHk6ICR7ZW50aXR5TmFtZX1cXG5gO1xuICAgICAgICAgICAgICAgIGxldCBlbnRpdHlEYXRhID0gW107XG5cbiAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShlbnRpdHkuaW5mby5kYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5kYXRhLmZvckVhY2gocmVjb3JkID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0geyBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSB9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JPd24oZW50aXR5LmluZm8uZGF0YSwgKHJlY29yZCwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNQbGFpbk9iamVjdChyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGZpZWxkcyA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChmaWVsZHMubGVuZ3RoICE9PSAyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgSW52YWxpZCBkYXRhIHN5bnRheDogZW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiBoYXMgbW9yZSB0aGFuIDIgZmllbGRzLmApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHtbZW50aXR5LmtleV06IGtleSwgW2ZpZWxkc1sxXV06IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCl9O1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSBPYmplY3QuYXNzaWduKHtbZW50aXR5LmtleV06IGtleX0sIHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHlEYXRhLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vaW50aVNRTCArPSAnSU5TRVJUIElOVE8gYCcgKyBlbnRpdHlOYW1lICsgJ2AgU0VUICcgKyBfLm1hcChyZWNvcmQsICh2LGspID0+ICdgJyArIGsgKyAnYCA9ICcgKyBKU09OLnN0cmluZ2lmeSh2KSkuam9pbignLCAnKSArICc7XFxuJztcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkoZW50aXR5RGF0YSkpIHtcbiAgICAgICAgICAgICAgICAgICAgZGF0YVtlbnRpdHlOYW1lXSA9IGVudGl0eURhdGE7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdcXG4nO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBfLmZvck93bih0aGlzLl9yZWZlcmVuY2VzLCAocmVmcywgc3JjRW50aXR5TmFtZSkgPT4ge1xuICAgICAgICAgICAgXy5lYWNoKHJlZnMsIHJlZiA9PiB7XG4gICAgICAgICAgICAgICAgcmVsYXRpb25TUUwgKz0gdGhpcy5fYWRkRm9yZWlnbktleVN0YXRlbWVudChzcmNFbnRpdHlOYW1lLCByZWYpICsgJ1xcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGRiRmlsZVBhdGgpLCB0YWJsZVNRTCk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBma0ZpbGVQYXRoKSwgcmVsYXRpb25TUUwpO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdEZpbGVQYXRoKSwgSlNPTi5zdHJpbmdpZnkoZGF0YSwgbnVsbCwgNCkpO1xuXG4gICAgICAgICAgICBpZiAoIWZzLmV4aXN0c1N5bmMocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSkpIHtcbiAgICAgICAgICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgaW5pdElkeEZpbGVQYXRoKSwgJzAtaW5pdC5qc29uXFxuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgZnVuY1NRTCA9ICcnO1xuICAgICAgICBcbiAgICAgICAgLy9wcm9jZXNzIHZpZXdcbiAgICAgICAgLypcbiAgICAgICAgXy5lYWNoKG1vZGVsaW5nU2NoZW1hLnZpZXdzLCAodmlldywgdmlld05hbWUpID0+IHtcbiAgICAgICAgICAgIHZpZXcuaW5mZXJUeXBlSW5mbyhtb2RlbGluZ1NjaGVtYSk7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYENSRUFURSBQUk9DRURVUkUgJHtkYlNlcnZpY2UuZ2V0Vmlld1NQTmFtZSh2aWV3TmFtZSl9KGA7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcucGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIGxldCBwYXJhbVNRTHMgPSBbXTtcbiAgICAgICAgICAgICAgICB2aWV3LnBhcmFtcy5mb3JFYWNoKHBhcmFtID0+IHtcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1TUUxzLnB1c2goYHAke18udXBwZXJGaXJzdChwYXJhbS5uYW1lKX0gJHtNeVNRTE1vZGVsZXIuY29sdW1uRGVmaW5pdGlvbihwYXJhbSwgdHJ1ZSl9YCk7XG4gICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICBmdW5jU1FMICs9IHBhcmFtU1FMcy5qb2luKCcsICcpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jU1FMICs9IGApXFxuQ09NTUVOVCAnU1AgZm9yIHZpZXcgJHt2aWV3TmFtZX0nXFxuUkVBRFMgU1FMIERBVEFcXG5CRUdJTlxcbmA7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gdGhpcy5fdmlld0RvY3VtZW50VG9TUUwobW9kZWxpbmdTY2hlbWEsIHZpZXcpICsgJzsnO1xuXG4gICAgICAgICAgICBmdW5jU1FMICs9ICdcXG5FTkQ7XFxuXFxuJztcbiAgICAgICAgfSk7XG4gICAgICAgICovXG5cbiAgICAgICAgbGV0IHNwRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdwcm9jZWR1cmVzLnNxbCcpO1xuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgc3BGaWxlUGF0aCksIGZ1bmNTUUwpO1xuXG4gICAgICAgIHJldHVybiBtb2RlbGluZ1NjaGVtYTtcbiAgICB9ICAgIFxuXG4gICAgX3Byb2Nlc3NBc3NvY2lhdGlvbihzY2hlbWEsIGVudGl0eSwgYXNzb2MpIHtcbiAgICAgICAgbGV0IGRlc3RFbnRpdHlOYW1lID0gYXNzb2MuZGVzdEVudGl0eTtcbiAgICAgICAgLy90b2RvOiBjcm9zcyBkYiByZWZlcmVuY2VcbiAgICAgICAgbGV0IGRlc3RFbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbZGVzdEVudGl0eU5hbWVdO1xuICAgICAgICBpZiAoIWRlc3RFbnRpdHkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgRW50aXR5IFwiJHtlbnRpdHkubmFtZX1cIiByZWZlcmVuY2VzIHRvIGFuIHVuZXhpc3RpbmcgZW50aXR5IFwiJHtkZXN0RW50aXR5TmFtZX1cIi5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBkZXN0S2V5RmllbGQgPSBkZXN0RW50aXR5LmdldEtleUZpZWxkKCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZGVzdEtleUZpZWxkKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBEZXN0aW5hdGlvbiBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiIHdpdGggY29tYmluYXRpb24gcHJpbWFyeSBrZXkgaXMgbm90IHN1cHBvcnRlZC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHN3aXRjaCAoYXNzb2MudHlwZSkge1xuICAgICAgICAgICAgY2FzZSAnaGFzT25lJzpcbiAgICAgICAgICAgIGNhc2UgJ2hhc01hbnknOiAgIFxuICAgICAgICAgICAgICAgIGxldCBpbmNsdWRlczsgICAgXG4gICAgICAgICAgICAgICAgbGV0IGV4Y2x1ZGVzID0geyB0eXBlczogWyAncmVmZXJzVG8nIF0sIGFzc29jaWF0aW9uOiBhc3NvYyB9O1xuICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICBleGNsdWRlcy50eXBlcy5wdXNoKCdiZWxvbmdzVG8nKTtcbiAgICAgICAgICAgICAgICAgICAgaW5jbHVkZXMgPSB7IGNvbm5lY3RlZEJ5OiBjYiA9PiBjYiAmJiBjYi5zcGxpdCgnLicpWzBdID09PSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpWzBdIH07XG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5jb25uZWN0ZWRXaXRoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcy5jb25uZWN0ZWRXaXRoID0gYXNzb2MuY29ubmVjdGVkV2l0aDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKGVudGl0eS5uYW1lLCBpbmNsdWRlcywgZXhjbHVkZXMpO1xuICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyB8fCBiYWNrUmVmLnR5cGUgPT09ICdoYXNPbmUnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0cyA9IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5TmFtZSA9IE9vbFV0aWxzLmVudGl0eU5hbWluZyhjb25uZWN0ZWRCeVBhcnRzWzBdKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgdGFnMiA9IGAke2Rlc3RFbnRpdHlOYW1lfTokeyBiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZW50aXR5Lm5hbWV9OjokeyBhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyAnbicgOiAnMScgfSBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzEgKz0gJyAnICsgYXNzb2Muc3JjRmllbGQ7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChiYWNrUmVmLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGFnMiArPSAnICcgKyBiYWNrUmVmLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAodGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKSB8fCB0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzIpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9hbHJlYWR5IHByb2Nlc3NlZCwgc2tpcFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlQYXJ0czIgPSBiYWNrUmVmLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSAoY29ubmVjdGVkQnlQYXJ0czIubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzMlsxXSkgfHwgZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoY29ubmVjdGVkQnlGaWVsZCA9PT0gY29ubmVjdGVkQnlGaWVsZDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tjb25uRW50aXR5TmFtZV07XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZE5hbWUgPSBhc3NvYy5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZGVzdEVudGl0eU5hbWUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIsIGFzc29jLmNvbm5lY3RlZFdpdGgsIGxvY2FsRmllbGROYW1lKSB9IDoge30pIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCByZW1vdGVGaWVsZE5hbWUgPSBiYWNrUmVmLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShlbnRpdHkubmFtZSk7ICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYmFja1JlZi5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZEJ5OiBjb25uRW50aXR5TmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMixcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8geyBpc0xpc3Q6IHRydWUgfSA6IHt9KSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLmNvbm5lY3RlZFdpdGggPyB7IGNvbm5lY3RlZFdpdGg6IHRoaXMuX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZGVzdEVudGl0eSwgY29ubkVudGl0eSwgZW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkMiwgY29ubmVjdGVkQnlGaWVsZCwgYmFja1JlZi5jb25uZWN0ZWRXaXRoLCByZW1vdGVGaWVsZE5hbWUpIH0gOiB7fSkgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcyKTsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChiYWNrUmVmLnR5cGUgPT09ICdiZWxvbmdzVG8nKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGJlbG9uZ3NUbyBjb25uZWN0ZWRCeS4gZW50aXR5OiAnICsgZW50aXR5Lm5hbWUpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvL2xlYXZlIGl0IHRvIHRoZSByZWZlcmVuY2VkIGVudGl0eSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5leHBlY3RlZCBwYXRoLiBFbnRpdHk6ICcgKyBlbnRpdHkubmFtZSArICcsIGFzc29jaWF0aW9uOiAnICsgSlNPTi5zdHJpbmdpZnkoYXNzb2MsIG51bGwsIDIpKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgIH0gZWxzZSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5jb25uZWN0ZWRCeSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgYXNzb2M7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoIDw9IDI7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQgPSAoY29ubmVjdGVkQnlQYXJ0cy5sZW5ndGggPiAxICYmIGNvbm5lY3RlZEJ5UGFydHNbMV0pIHx8IGVudGl0eS5uYW1lO1xuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5TmFtZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBcImNvbm5lY3RlZEJ5XCIgcmVxdWlyZWQgZm9yIG06biByZWxhdGlvbi4gU291cmNlOiAke2VudGl0eS5uYW1lfSwgZGVzdGluYXRpb246ICR7ZGVzdEVudGl0eU5hbWV9YCk7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzEgPSBgJHtlbnRpdHkubmFtZX06JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ20nIDogJzEnIH0tJHtkZXN0RW50aXR5TmFtZX06KiBieSAke2Nvbm5FbnRpdHlOYW1lfWA7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLnNyY0ZpZWxkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICF0aGlzLl9wcm9jZXNzZWRSZWYuaGFzKHRhZzEpOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZDIgPSBkZXN0RW50aXR5Lm5hbWU7XG5cbiAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ0Nhbm5vdCB1c2UgdGhlIHNhbWUgXCJjb25uZWN0ZWRCeVwiIGZpZWxkIGluIGEgcmVsYXRpb24gZW50aXR5LicpO1xuICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbY29ubkVudGl0eU5hbWVdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWNvbm5FbnRpdHkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5FbnRpdHkgPSB0aGlzLl9hZGRSZWxhdGlvbkVudGl0eShzY2hlbWEsIGNvbm5FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fdXBkYXRlUmVsYXRpb25FbnRpdHkoY29ubkVudGl0eSwgZW50aXR5LCBkZXN0RW50aXR5LCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMik7XG5cbiAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICBsb2NhbEZpZWxkTmFtZSwgXG4gICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGFzc29jLm9wdGlvbmFsLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW90ZUZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkLFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyc1RvRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQyLCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGVudGl0eSwgY29ubkVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIsIGFzc29jLmNvbm5lY3RlZFdpdGgsIGxvY2FsRmllbGROYW1lKSB9IDoge30pIFxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMSk7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAncmVmZXJzVG8nOlxuICAgICAgICAgICAgY2FzZSAnYmVsb25nc1RvJzpcbiAgICAgICAgICAgICAgICBsZXQgbG9jYWxGaWVsZCA9IGFzc29jLnNyY0ZpZWxkIHx8IGRlc3RFbnRpdHlOYW1lO1xuICAgICAgICAgICAgICAgIGxldCBmaWVsZFByb3BzID0geyAuLi5fLm9taXQoZGVzdEtleUZpZWxkLCBbJ29wdGlvbmFsJ10pLCAuLi5fLnBpY2soYXNzb2MsIFsnb3B0aW9uYWwnXSkgfTtcblxuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY0ZpZWxkKGxvY2FsRmllbGQsIGRlc3RFbnRpdHksIGZpZWxkUHJvcHMpO1xuICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZCwgXG4gICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogZmFsc2UsIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCB9XG4gICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgIGlmIChhc3NvYy50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICBsZXQgYmFja1JlZiA9IGRlc3RFbnRpdHkuZ2V0UmVmZXJlbmNlVG8oZW50aXR5Lm5hbWUsIG51bGwsIHsgdHlwZXM6IFsgJ3JlZmVyc1RvJywgJ2JlbG9uZ3NUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH0pO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogdHJ1ZSwgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzTGlzdDogYmFja1JlZi50eXBlID09PSAnaGFzTWFueScsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBsb2NhbEZpZWxkTmFtZSwgcmVtb3RlRmllbGROYW1lLCBvb2xDb24sIGFuY2hvcikge1xuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBbY29ubkVudGl0eS5uYW1lXSA6IGFuY2hvclxuICAgICAgICB9OyAgICAgICAgXG5cbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZikge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZpZWxkLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGlmIChyZWxhdGlvbkVudGl0eU5hbWUgPT09ICdjb21wYW55Um9sZScpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRpcihyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywge2RlcHRoOiAxMCwgY29sb3JzOiB0cnVlfSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5TmFtZSA9PT0gJ2NvbXBhbnlSb2xlJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnT0snKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgZW50aXR5MVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIGVudGl0eTJcbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=