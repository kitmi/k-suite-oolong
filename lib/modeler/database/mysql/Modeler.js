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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9tb2RlbGVyL2RhdGFiYXNlL215c3FsL01vZGVsZXIuanMiXSwibmFtZXMiOlsiRXZlbnRFbWl0dGVyIiwicmVxdWlyZSIsInBsdXJhbGl6ZSIsInBhdGgiLCJudG9sIiwiVXRpbCIsIl8iLCJmcyIsInF1b3RlIiwiT29sVXRpbHMiLCJFbnRpdHkiLCJUeXBlcyIsIlVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUiLCJTZXQiLCJNeVNRTE1vZGVsZXIiLCJjb25zdHJ1Y3RvciIsImNvbnRleHQiLCJjb25uZWN0b3IiLCJkYk9wdGlvbnMiLCJsb2dnZXIiLCJsaW5rZXIiLCJvdXRwdXRQYXRoIiwic2NyaXB0T3V0cHV0UGF0aCIsIl9ldmVudHMiLCJfZGJPcHRpb25zIiwiZGIiLCJtYXBLZXlzIiwidmFsdWUiLCJrZXkiLCJ1cHBlckNhc2UiLCJ0YWJsZSIsIl9yZWZlcmVuY2VzIiwiX3JlbGF0aW9uRW50aXRpZXMiLCJfcHJvY2Vzc2VkUmVmIiwibW9kZWxpbmciLCJzY2hlbWEiLCJsb2ciLCJuYW1lIiwibW9kZWxpbmdTY2hlbWEiLCJjbG9uZSIsImV4aXN0aW5nRW50aXRpZXMiLCJPYmplY3QiLCJ2YWx1ZXMiLCJlbnRpdGllcyIsImVhY2giLCJlbnRpdHkiLCJpc0VtcHR5IiwiaW5mbyIsImFzc29jaWF0aW9ucyIsImNvbnNvbGUiLCJmb3JFYWNoIiwiYXNzb2MiLCJfcHJvY2Vzc0Fzc29jaWF0aW9uIiwiZW1pdCIsInNxbEZpbGVzRGlyIiwiam9pbiIsImRhdGFiYXNlIiwiZGJGaWxlUGF0aCIsImZrRmlsZVBhdGgiLCJpbml0SWR4RmlsZVBhdGgiLCJpbml0RmlsZVBhdGgiLCJ0YWJsZVNRTCIsInJlbGF0aW9uU1FMIiwiZGF0YSIsImVudGl0eU5hbWUiLCJhZGRJbmRleGVzIiwicmVzdWx0IiwiY29tcGxpYW5jZUNoZWNrIiwiZXJyb3JzIiwibGVuZ3RoIiwibWVzc2FnZSIsIndhcm5pbmdzIiwiRXJyb3IiLCJmZWF0dXJlcyIsImZvck93biIsImYiLCJmZWF0dXJlTmFtZSIsIkFycmF5IiwiaXNBcnJheSIsImZmIiwiX2ZlYXR1cmVSZWR1Y2VyIiwiX2NyZWF0ZVRhYmxlU3RhdGVtZW50IiwiZW50aXR5RGF0YSIsInJlY29yZCIsImlzUGxhaW5PYmplY3QiLCJmaWVsZHMiLCJrZXlzIiwidHJhbnNsYXRlT29sVmFsdWUiLCJvb2xNb2R1bGUiLCJwdXNoIiwiYXNzaWduIiwicmVmcyIsInNyY0VudGl0eU5hbWUiLCJyZWYiLCJfYWRkRm9yZWlnbktleVN0YXRlbWVudCIsIl93cml0ZUZpbGUiLCJKU09OIiwic3RyaW5naWZ5IiwiZXhpc3RzU3luYyIsImZ1bmNTUUwiLCJzcEZpbGVQYXRoIiwiZGVzdEVudGl0eU5hbWUiLCJkZXN0RW50aXR5IiwiZGVzdEtleUZpZWxkIiwiZ2V0S2V5RmllbGQiLCJ0eXBlIiwiaW5jbHVkZXMiLCJleGNsdWRlcyIsInR5cGVzIiwiYXNzb2NpYXRpb24iLCJjb25uZWN0ZWRCeSIsImNiIiwic3BsaXQiLCJjb25uZWN0ZWRXaXRoIiwicmVtb3RlRmllbGQiLCJzcmNGaWVsZCIsInJlbW90ZUZpZWxkcyIsImFkZEFzc29jaWF0aW9uIiwib3B0aW9uYWwiLCJpc0xpc3QiLCJiYWNrUmVmIiwiZ2V0UmVmZXJlbmNlVG8iLCJjb25uZWN0ZWRCeVBhcnRzIiwiY29ubmVjdGVkQnlGaWVsZCIsImNvbm5FbnRpdHlOYW1lIiwiZW50aXR5TmFtaW5nIiwidGFnMSIsInRhZzIiLCJoYXMiLCJjb25uZWN0ZWRCeVBhcnRzMiIsImNvbm5lY3RlZEJ5RmllbGQyIiwiY29ubkVudGl0eSIsIl9hZGRSZWxhdGlvbkVudGl0eSIsIl91cGRhdGVSZWxhdGlvbkVudGl0eSIsImxvY2FsRmllbGROYW1lIiwicmVmZXJzVG9GaWVsZCIsIl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uIiwicmVtb3RlRmllbGROYW1lIiwiYWRkIiwibG9jYWxGaWVsZCIsImZpZWxkUHJvcHMiLCJvbWl0IiwicGljayIsImFkZEFzc29jRmllbGQiLCJpc05pbCIsIl9hZGRSZWZlcmVuY2UiLCJvb2xDb24iLCJhbmNob3IiLCJvb2xUeXBlIiwib3BlcmF0b3IiLCJsZWZ0IiwiX3RyYW5zbGF0ZVJlZmVyZW5jZSIsInJpZ2h0IiwiYmFzZSIsIm90aGVyIiwidHJhbnNsYXRlZCIsImxlZnRGaWVsZCIsInJpZ2h0RmllbGQiLCJyZWZzNExlZnRFbnRpdHkiLCJmb3VuZCIsImZpbmQiLCJpdGVtIiwiX2dldFJlZmVyZW5jZU9mRmllbGQiLCJ1bmRlZmluZWQiLCJyZWZlcmVuY2UiLCJfaGFzUmVmZXJlbmNlT2ZGaWVsZCIsIl9nZXRSZWZlcmVuY2VCZXR3ZWVuIiwiX2hhc1JlZmVyZW5jZUJldHdlZW4iLCJmZWF0dXJlIiwiZmllbGQiLCJnZW5lcmF0b3IiLCJhdXRvSW5jcmVtZW50SWQiLCJvbiIsImV4dHJhT3B0cyIsInN0YXJ0RnJvbSIsImlzQ3JlYXRlVGltZXN0YW1wIiwiaXNVcGRhdGVUaW1lc3RhbXAiLCJmaWxlUGF0aCIsImNvbnRlbnQiLCJlbnN1cmVGaWxlU3luYyIsIndyaXRlRmlsZVN5bmMiLCJyZWxhdGlvbkVudGl0eU5hbWUiLCJlbnRpdHkxUmVmRmllbGQiLCJlbnRpdHkyUmVmRmllbGQiLCJlbnRpdHlJbmZvIiwibGluayIsImFkZEVudGl0eSIsInJlbGF0aW9uRW50aXR5IiwiZW50aXR5MSIsImVudGl0eTIiLCJkaXIiLCJkZXB0aCIsImNvbG9ycyIsImhhc1JlZlRvRW50aXR5MSIsImhhc1JlZlRvRW50aXR5MiIsImtleUVudGl0eTEiLCJrZXlFbnRpdHkyIiwib29sT3BUb1NxbCIsIm9wIiwib29sVG9TcWwiLCJkb2MiLCJvb2wiLCJwYXJhbXMiLCJpc01lbWJlckFjY2VzcyIsInAiLCJ1cHBlckZpcnN0IiwiZW50aXR5Tm9kZSIsInBhcnNlUmVmZXJlbmNlSW5Eb2N1bWVudCIsImFsaWFzIiwicXVvdGVJZGVudGlmaWVyIiwiX29yZGVyQnlUb1NxbCIsImFzY2VuZCIsIl92aWV3RG9jdW1lbnRUb1NRTCIsInZpZXciLCJzcWwiLCJjbG9uZURlZXAiLCJnZXREb2N1bWVudEhpZXJhcmNoeSIsImNvbExpc3QiLCJqb2lucyIsIl9idWlsZFZpZXdTZWxlY3QiLCJzZWxlY3RCeSIsIm1hcCIsInNlbGVjdCIsImdyb3VwQnkiLCJjb2wiLCJvcmRlckJ5Iiwic2tpcCIsImxpbWl0Iiwic3RhcnRJbmRleCIsImsiLCJzdWJEb2N1bWVudHMiLCJmaWVsZE5hbWUiLCJzdWJDb2xMaXN0Iiwic3ViQWxpYXMiLCJzdWJKb2lucyIsInN0YXJ0SW5kZXgyIiwiY29uY2F0IiwibGlua1dpdGhGaWVsZCIsImNvbHVtbkRlZmluaXRpb24iLCJxdW90ZUxpc3RPclZhbHVlIiwiaW5kZXhlcyIsImluZGV4IiwidW5pcXVlIiwibGluZXMiLCJzdWJzdHIiLCJleHRyYVByb3BzIiwicHJvcHMiLCJyZWR1Y2UiLCJyZWxhdGlvbiIsImZvcmVpZ25LZXlGaWVsZE5hbWluZyIsImxlZnRQYXJ0IiwiY2FtZWxDYXNlIiwicmlnaHRQYXJ0IiwicGFzY2FsQ2FzZSIsImVuZHNXaXRoIiwicXVvdGVTdHJpbmciLCJzdHIiLCJyZXBsYWNlIiwib2JqIiwidiIsImlzUHJvYyIsImludENvbHVtbkRlZmluaXRpb24iLCJmbG9hdENvbHVtbkRlZmluaXRpb24iLCJ0ZXh0Q29sdW1uRGVmaW5pdGlvbiIsImJvb2xDb2x1bW5EZWZpbml0aW9uIiwiYmluYXJ5Q29sdW1uRGVmaW5pdGlvbiIsImRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbiIsImVudW1Db2x1bW5EZWZpbml0aW9uIiwiY29sdW1uTnVsbGFibGUiLCJkZWZhdWx0VmFsdWUiLCJkaWdpdHMiLCJ1bnNpZ25lZCIsImV4YWN0IiwidG90YWxEaWdpdHMiLCJkZWNpbWFsRGlnaXRzIiwiZml4ZWRMZW5ndGgiLCJtYXhMZW5ndGgiLCJyYW5nZSIsImhhc093blByb3BlcnR5IiwiY3JlYXRlQnlEYiIsInVwZGF0ZUJ5RGIiLCJCT09MRUFOIiwic2FuaXRpemUiLCJyZW1vdmVUYWJsZU5hbWVQcmVmaXgiLCJyZW1vdmVUYWJsZVByZWZpeCIsInRyaW0iLCJzbmFrZUNhc2UiLCJ0cmltRW5kIiwic3RhcnRzV2l0aCIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiJBQUFBOzs7O0FBRUEsTUFBTUEsWUFBWSxHQUFHQyxPQUFPLENBQUMsUUFBRCxDQUE1Qjs7QUFDQSxNQUFNQyxTQUFTLEdBQUdELE9BQU8sQ0FBQyxXQUFELENBQXpCOztBQUNBLE1BQU1FLElBQUksR0FBR0YsT0FBTyxDQUFDLE1BQUQsQ0FBcEI7O0FBQ0EsTUFBTUcsSUFBSSxHQUFHSCxPQUFPLENBQUMsa0JBQUQsQ0FBcEI7O0FBRUEsTUFBTUksSUFBSSxHQUFHSixPQUFPLENBQUMsVUFBRCxDQUFwQjs7QUFDQSxNQUFNO0FBQUVLLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsRUFBTDtBQUFTQyxFQUFBQTtBQUFULElBQW1CSCxJQUF6Qjs7QUFFQSxNQUFNSSxRQUFRLEdBQUdSLE9BQU8sQ0FBQyx3QkFBRCxDQUF4Qjs7QUFDQSxNQUFNUyxNQUFNLEdBQUdULE9BQU8sQ0FBQyxzQkFBRCxDQUF0Qjs7QUFDQSxNQUFNVSxLQUFLLEdBQUdWLE9BQU8sQ0FBQyx3QkFBRCxDQUFyQjs7QUFFQSxNQUFNVyx5QkFBeUIsR0FBRyxJQUFJQyxHQUFKLENBQVEsQ0FBQyxNQUFELEVBQVMsTUFBVCxFQUFpQixNQUFqQixFQUF5QixVQUF6QixDQUFSLENBQWxDOztBQXVDQSxNQUFNQyxZQUFOLENBQW1CO0FBVWZDLEVBQUFBLFdBQVcsQ0FBQ0MsT0FBRCxFQUFVQyxTQUFWLEVBQXFCQyxTQUFyQixFQUFnQztBQUN2QyxTQUFLQyxNQUFMLEdBQWNILE9BQU8sQ0FBQ0csTUFBdEI7QUFDQSxTQUFLQyxNQUFMLEdBQWNKLE9BQU8sQ0FBQ0ksTUFBdEI7QUFDQSxTQUFLQyxVQUFMLEdBQWtCTCxPQUFPLENBQUNNLGdCQUExQjtBQUNBLFNBQUtMLFNBQUwsR0FBaUJBLFNBQWpCO0FBRUEsU0FBS00sT0FBTCxHQUFlLElBQUl2QixZQUFKLEVBQWY7QUFF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QUFBQSxVQUFVLEdBQUcxRCxDQUFDLENBQUN1UixJQUFGLENBQU92UixDQUFDLENBQUN3UixTQUFGLENBQVk5TixVQUFaLENBQVAsQ0FBYjtBQUVBNE4sTUFBQUEsaUJBQWlCLEdBQUd0UixDQUFDLENBQUN5UixPQUFGLENBQVV6UixDQUFDLENBQUN3UixTQUFGLENBQVlGLGlCQUFaLENBQVYsRUFBMEMsR0FBMUMsSUFBaUQsR0FBckU7O0FBRUEsVUFBSXRSLENBQUMsQ0FBQzBSLFVBQUYsQ0FBYWhPLFVBQWIsRUFBeUI0TixpQkFBekIsQ0FBSixFQUFpRDtBQUM3QzVOLFFBQUFBLFVBQVUsR0FBR0EsVUFBVSxDQUFDb0wsTUFBWCxDQUFrQndDLGlCQUFpQixDQUFDdk4sTUFBcEMsQ0FBYjtBQUNIO0FBQ0o7O0FBRUQsV0FBTzVELFFBQVEsQ0FBQ29ILFlBQVQsQ0FBc0I3RCxVQUF0QixDQUFQO0FBQ0g7O0FBbnFDYzs7QUFzcUNuQmlPLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnBSLFlBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiXCJ1c2Ugc3RyaWN0XCI7XG5cbmNvbnN0IEV2ZW50RW1pdHRlciA9IHJlcXVpcmUoJ2V2ZW50cycpO1xuY29uc3QgcGx1cmFsaXplID0gcmVxdWlyZSgncGx1cmFsaXplJyk7XG5jb25zdCBwYXRoID0gcmVxdWlyZSgncGF0aCcpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuY29uc3QgVXRpbCA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IF8sIGZzLCBxdW90ZSB9ID0gVXRpbDtcblxuY29uc3QgT29sVXRpbHMgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL09vbFV0aWxzJyk7XG5jb25zdCBFbnRpdHkgPSByZXF1aXJlKCcuLi8uLi8uLi9sYW5nL0VudGl0eScpO1xuY29uc3QgVHlwZXMgPSByZXF1aXJlKCcuLi8uLi8uLi9ydW50aW1lL3R5cGVzJyk7XG5cbmNvbnN0IFVOU1VQUE9SVEVEX0RFRkFVTFRfVkFMVUUgPSBuZXcgU2V0KFsnQkxPQicsICdURVhUJywgJ0pTT04nLCAnR0VPTUVUUlknXSk7XG5cbi8qXG5jb25zdCBNWVNRTF9LRVlXT1JEUyA9IFtcbiAgICAnc2VsZWN0JyxcbiAgICAnZnJvbScsXG4gICAgJ3doZXJlJyxcbiAgICAnbGltaXQnLFxuICAgICdvcmRlcicsXG4gICAgJ2dyb3VwJyxcbiAgICAnZGlzdGluY3QnLFxuICAgICdpbnNlcnQnLFxuICAgICd1cGRhdGUnLFxuICAgICdpbicsXG4gICAgJ29mZnNldCcsXG4gICAgJ2J5JyxcbiAgICAnYXNjJyxcbiAgICAnZGVzYycsXG4gICAgJ2RlbGV0ZScsXG4gICAgJ2JlZ2luJyxcbiAgICAnZW5kJyxcbiAgICAnbGVmdCcsXG4gICAgJ3JpZ2h0JyxcbiAgICAnam9pbicsXG4gICAgJ29uJyxcbiAgICAnYW5kJyxcbiAgICAnb3InLFxuICAgICdub3QnLFxuICAgICdyZXR1cm5zJyxcbiAgICAncmV0dXJuJyxcbiAgICAnY3JlYXRlJyxcbiAgICAnYWx0ZXInXG5dO1xuKi9cblxuLyoqXG4gKiBPb29sb25nIGRhdGFiYXNlIG1vZGVsZXIgZm9yIG15c3FsIGRiLlxuICogQGNsYXNzXG4gKi9cbmNsYXNzIE15U1FMTW9kZWxlciB7XG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29udGV4dFxuICAgICAqIEBwcm9wZXJ0eSB7TG9nZ2VyfSBjb250ZXh0LmxvZ2dlciAtIExvZ2dlciBvYmplY3QgICAgIFxuICAgICAqIEBwcm9wZXJ0eSB7T29sb25nTGlua2VyfSBjb250ZXh0LmxpbmtlciAtIE9vbG9uZyBEU0wgbGlua2VyXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aCAtIEdlbmVyYXRlZCBzY3JpcHQgcGF0aFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYk9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge29iamVjdH0gZGJPcHRpb25zLmRiXG4gICAgICogQHByb3BlcnR5IHtvYmplY3R9IGRiT3B0aW9ucy50YWJsZVxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbnRleHQsIGNvbm5lY3RvciwgZGJPcHRpb25zKSB7XG4gICAgICAgIHRoaXMubG9nZ2VyID0gY29udGV4dC5sb2dnZXI7XG4gICAgICAgIHRoaXMubGlua2VyID0gY29udGV4dC5saW5rZXI7XG4gICAgICAgIHRoaXMub3V0cHV0UGF0aCA9IGNvbnRleHQuc2NyaXB0T3V0cHV0UGF0aDtcbiAgICAgICAgdGhpcy5jb25uZWN0b3IgPSBjb25uZWN0b3I7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzID0gbmV3IEV2ZW50RW1pdHRlcigpO1xuXG4gICAgICAgIHRoaXMuX2RiT3B0aW9ucyA9IGRiT3B0aW9ucyA/IHtcbiAgICAgICAgICAgIGRiOiBfLm1hcEtleXMoZGJPcHRpb25zLmRiLCAodmFsdWUsIGtleSkgPT4gXy51cHBlckNhc2Uoa2V5KSksXG4gICAgICAgICAgICB0YWJsZTogXy5tYXBLZXlzKGRiT3B0aW9ucy50YWJsZSwgKHZhbHVlLCBrZXkpID0+IF8udXBwZXJDYXNlKGtleSkpXG4gICAgICAgIH0gOiB7fTtcblxuICAgICAgICB0aGlzLl9yZWZlcmVuY2VzID0ge307XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXMgPSB7fTtcbiAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmID0gbmV3IFNldCgpO1xuICAgIH1cblxuICAgIG1vZGVsaW5nKHNjaGVtYSkge1xuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGluZyBteXNxbCBzY3JpcHRzIGZvciBzY2hlbWEgXCInICsgc2NoZW1hLm5hbWUgKyAnXCIuLi4nKTtcblxuICAgICAgICBsZXQgbW9kZWxpbmdTY2hlbWEgPSBzY2hlbWEuY2xvbmUoKTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2RlYnVnJywgJ0J1aWxkaW5nIHJlbGF0aW9ucy4uLicpO1xuXG4gICAgICAgIGxldCBleGlzdGluZ0VudGl0aWVzID0gT2JqZWN0LnZhbHVlcyhtb2RlbGluZ1NjaGVtYS5lbnRpdGllcyk7XG5cbiAgICAgICAgXy5lYWNoKGV4aXN0aW5nRW50aXRpZXMsIChlbnRpdHkpID0+IHtcbiAgICAgICAgICAgIGlmICghXy5pc0VtcHR5KGVudGl0eS5pbmZvLmFzc29jaWF0aW9ucykpIHtcbiAgICAgICAgICAgICAgICBpZiAoZW50aXR5Lm5hbWUgPT09ICdjYXNlJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZyhlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBlbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMuZm9yRWFjaChhc3NvYyA9PiB0aGlzLl9wcm9jZXNzQXNzb2NpYXRpb24obW9kZWxpbmdTY2hlbWEsIGVudGl0eSwgYXNzb2MpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgdGhpcy5fZXZlbnRzLmVtaXQoJ2FmdGVyUmVsYXRpb25zaGlwQnVpbGRpbmcnKTsgICAgICAgIFxuXG4gICAgICAgIC8vYnVpbGQgU1FMIHNjcmlwdHNcbiAgICAgICAgbGV0IHNxbEZpbGVzRGlyID0gcGF0aC5qb2luKCdteXNxbCcsIHRoaXMuY29ubmVjdG9yLmRhdGFiYXNlKTtcbiAgICAgICAgbGV0IGRiRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdlbnRpdGllcy5zcWwnKTtcbiAgICAgICAgbGV0IGZrRmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdyZWxhdGlvbnMuc3FsJyk7XG4gICAgICAgIGxldCBpbml0SWR4RmlsZVBhdGggPSBwYXRoLmpvaW4oc3FsRmlsZXNEaXIsICdkYXRhJywgJ19pbml0JywgJ2luZGV4Lmxpc3QnKTtcbiAgICAgICAgbGV0IGluaXRGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ2RhdGEnLCAnX2luaXQnLCAnMC1pbml0Lmpzb24nKTtcbiAgICAgICAgbGV0IHRhYmxlU1FMID0gJycsIHJlbGF0aW9uU1FMID0gJycsIGRhdGEgPSB7fTtcblxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEuZW50aXRpZXMsIChlbnRpdHksIGVudGl0eU5hbWUpID0+IHtcbiAgICAgICAgICAgIGVudGl0eS5hZGRJbmRleGVzKCk7XG5cbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBNeVNRTE1vZGVsZXIuY29tcGxpYW5jZUNoZWNrKGVudGl0eSk7XG4gICAgICAgICAgICBpZiAocmVzdWx0LmVycm9ycy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICBsZXQgbWVzc2FnZSA9ICcnO1xuICAgICAgICAgICAgICAgIGlmIChyZXN1bHQud2FybmluZ3MubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgICAgICBtZXNzYWdlICs9ICdXYXJuaW5nczogXFxuJyArIHJlc3VsdC53YXJuaW5ncy5qb2luKCdcXG4nKSArICdcXG4nO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBtZXNzYWdlICs9IHJlc3VsdC5lcnJvcnMuam9pbignXFxuJyk7XG5cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IobWVzc2FnZSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuZmVhdHVyZXMpIHtcbiAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuZmVhdHVyZXMsIChmLCBmZWF0dXJlTmFtZSkgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShmKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZi5mb3JFYWNoKGZmID0+IHRoaXMuX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZmKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl9mZWF0dXJlUmVkdWNlcihlbnRpdHksIGZlYXR1cmVOYW1lLCBmKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICB0YWJsZVNRTCArPSB0aGlzLl9jcmVhdGVUYWJsZVN0YXRlbWVudChlbnRpdHlOYW1lLCBlbnRpdHkpICsgJ1xcbic7XG5cbiAgICAgICAgICAgIGlmIChlbnRpdHkuaW5mby5kYXRhKSB7XG4gICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9IGAtLSBJbml0aWFsIGRhdGEgZm9yIGVudGl0eTogJHtlbnRpdHlOYW1lfVxcbmA7XG4gICAgICAgICAgICAgICAgbGV0IGVudGl0eURhdGEgPSBbXTtcblxuICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KGVudGl0eS5pbmZvLmRhdGEpKSB7XG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5pbmZvLmRhdGEuZm9yRWFjaChyZWNvcmQgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzUGxhaW5PYmplY3QocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxldCBmaWVsZHMgPSBPYmplY3Qua2V5cyhlbnRpdHkuZmllbGRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoZmllbGRzLmxlbmd0aCAhPT0gMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYEludmFsaWQgZGF0YSBzeW50YXg6IGVudGl0eSBcIiR7ZW50aXR5Lm5hbWV9XCIgaGFzIG1vcmUgdGhhbiAyIGZpZWxkcy5gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmQgPSB7IFtmaWVsZHNbMV1dOiB0aGlzLmxpbmtlci50cmFuc2xhdGVPb2xWYWx1ZShlbnRpdHkub29sTW9kdWxlLCByZWNvcmQpIH07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IHRoaXMubGlua2VyLnRyYW5zbGF0ZU9vbFZhbHVlKGVudGl0eS5vb2xNb2R1bGUsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBfLmZvck93bihlbnRpdHkuaW5mby5kYXRhLCAocmVjb3JkLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc1BsYWluT2JqZWN0KHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgZmllbGRzID0gT2JqZWN0LmtleXMoZW50aXR5LmZpZWxkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGZpZWxkcy5sZW5ndGggIT09IDIpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBJbnZhbGlkIGRhdGEgc3ludGF4OiBlbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIGhhcyBtb3JlIHRoYW4gMiBmaWVsZHMuYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkID0ge1tlbnRpdHkua2V5XToga2V5LCBbZmllbGRzWzFdXTogdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKX07XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZCA9IE9iamVjdC5hc3NpZ24oe1tlbnRpdHkua2V5XToga2V5fSwgdGhpcy5saW5rZXIudHJhbnNsYXRlT29sVmFsdWUoZW50aXR5Lm9vbE1vZHVsZSwgcmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eURhdGEucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9pbnRpU1FMICs9ICdJTlNFUlQgSU5UTyBgJyArIGVudGl0eU5hbWUgKyAnYCBTRVQgJyArIF8ubWFwKHJlY29yZCwgKHYsaykgPT4gJ2AnICsgayArICdgID0gJyArIEpTT04uc3RyaW5naWZ5KHYpKS5qb2luKCcsICcpICsgJztcXG4nO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShlbnRpdHlEYXRhKSkge1xuICAgICAgICAgICAgICAgICAgICBkYXRhW2VudGl0eU5hbWVdID0gZW50aXR5RGF0YTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAvL2ludGlTUUwgKz0gJ1xcbic7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIF8uZm9yT3duKHRoaXMuX3JlZmVyZW5jZXMsIChyZWZzLCBzcmNFbnRpdHlOYW1lKSA9PiB7XG4gICAgICAgICAgICBfLmVhY2gocmVmcywgcmVmID0+IHtcbiAgICAgICAgICAgICAgICByZWxhdGlvblNRTCArPSB0aGlzLl9hZGRGb3JlaWduS2V5U3RhdGVtZW50KHNyY0VudGl0eU5hbWUsIHJlZikgKyAnXFxuJztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9KTtcblxuICAgICAgICB0aGlzLl93cml0ZUZpbGUocGF0aC5qb2luKHRoaXMub3V0cHV0UGF0aCwgZGJGaWxlUGF0aCksIHRhYmxlU1FMKTtcbiAgICAgICAgdGhpcy5fd3JpdGVGaWxlKHBhdGguam9pbih0aGlzLm91dHB1dFBhdGgsIGZrRmlsZVBhdGgpLCByZWxhdGlvblNRTCk7XG5cbiAgICAgICAgaWYgKCFfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0RmlsZVBhdGgpLCBKU09OLnN0cmluZ2lmeShkYXRhLCBudWxsLCA0KSk7XG5cbiAgICAgICAgICAgIGlmICghZnMuZXhpc3RzU3luYyhwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpKSkge1xuICAgICAgICAgICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBpbml0SWR4RmlsZVBhdGgpLCAnMC1pbml0Lmpzb25cXG4nKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBmdW5jU1FMID0gJyc7XG4gICAgICAgIFxuICAgICAgICAvL3Byb2Nlc3Mgdmlld1xuICAgICAgICAvKlxuICAgICAgICBfLmVhY2gobW9kZWxpbmdTY2hlbWEudmlld3MsICh2aWV3LCB2aWV3TmFtZSkgPT4ge1xuICAgICAgICAgICAgdmlldy5pbmZlclR5cGVJbmZvKG1vZGVsaW5nU2NoZW1hKTtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSBgQ1JFQVRFIFBST0NFRFVSRSAke2RiU2VydmljZS5nZXRWaWV3U1BOYW1lKHZpZXdOYW1lKX0oYDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5wYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgbGV0IHBhcmFtU1FMcyA9IFtdO1xuICAgICAgICAgICAgICAgIHZpZXcucGFyYW1zLmZvckVhY2gocGFyYW0gPT4ge1xuICAgICAgICAgICAgICAgICAgICBwYXJhbVNRTHMucHVzaChgcCR7Xy51cHBlckZpcnN0KHBhcmFtLm5hbWUpfSAke015U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKHBhcmFtLCB0cnVlKX1gKTtcbiAgICAgICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgICAgIGZ1bmNTUUwgKz0gcGFyYW1TUUxzLmpvaW4oJywgJyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gYClcXG5DT01NRU5UICdTUCBmb3IgdmlldyAke3ZpZXdOYW1lfSdcXG5SRUFEUyBTUUwgREFUQVxcbkJFR0lOXFxuYDtcblxuICAgICAgICAgICAgZnVuY1NRTCArPSB0aGlzLl92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykgKyAnOyc7XG5cbiAgICAgICAgICAgIGZ1bmNTUUwgKz0gJ1xcbkVORDtcXG5cXG4nO1xuICAgICAgICB9KTtcbiAgICAgICAgKi9cblxuICAgICAgICBsZXQgc3BGaWxlUGF0aCA9IHBhdGguam9pbihzcWxGaWxlc0RpciwgJ3Byb2NlZHVyZXMuc3FsJyk7XG4gICAgICAgIHRoaXMuX3dyaXRlRmlsZShwYXRoLmpvaW4odGhpcy5vdXRwdXRQYXRoLCBzcEZpbGVQYXRoKSwgZnVuY1NRTCk7XG5cbiAgICAgICAgcmV0dXJuIG1vZGVsaW5nU2NoZW1hO1xuICAgIH0gICAgXG5cbiAgICBfcHJvY2Vzc0Fzc29jaWF0aW9uKHNjaGVtYSwgZW50aXR5LCBhc3NvYykge1xuICAgICAgICBsZXQgZGVzdEVudGl0eU5hbWUgPSBhc3NvYy5kZXN0RW50aXR5O1xuICAgICAgICAvL3RvZG86IGNyb3NzIGRiIHJlZmVyZW5jZVxuICAgICAgICBsZXQgZGVzdEVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkZXN0RW50aXR5TmFtZV07XG4gICAgICAgIGlmICghZGVzdEVudGl0eSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBFbnRpdHkgXCIke2VudGl0eS5uYW1lfVwiIHJlZmVyZW5jZXMgdG8gYW4gdW5leGlzdGluZyBlbnRpdHkgXCIke2Rlc3RFbnRpdHlOYW1lfVwiLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGRlc3RLZXlGaWVsZCA9IGRlc3RFbnRpdHkuZ2V0S2V5RmllbGQoKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShkZXN0S2V5RmllbGQpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYERlc3RpbmF0aW9uIGVudGl0eSBcIiR7ZGVzdEVudGl0eU5hbWV9XCIgd2l0aCBjb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgc3dpdGNoIChhc3NvYy50eXBlKSB7XG4gICAgICAgICAgICBjYXNlICdoYXNPbmUnOlxuICAgICAgICAgICAgY2FzZSAnaGFzTWFueSc6ICAgXG4gICAgICAgICAgICAgICAgbGV0IGluY2x1ZGVzOyAgICBcbiAgICAgICAgICAgICAgICBsZXQgZXhjbHVkZXMgPSB7IHR5cGVzOiBbICdyZWZlcnNUbycgXSwgYXNzb2NpYXRpb246IGFzc29jIH07XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgIGV4Y2x1ZGVzLnR5cGVzLnB1c2goJ2JlbG9uZ3NUbycpO1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgY29ubmVjdGVkQnk6IGNiID0+IGNiICYmIGNiLnNwbGl0KCcuJylbMF0gPT09IGFzc29jLmNvbm5lY3RlZEJ5LnNwbGl0KCcuJylbMF0gfTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGluY2x1ZGVzLmNvbm5lY3RlZFdpdGggPSBhc3NvYy5jb25uZWN0ZWRXaXRoO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhc3NvYy5yZW1vdGVGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICBpbmNsdWRlcyA9IHsgc3JjRmllbGQ6IGFzc29jLnJlbW90ZUZpZWxkIH07XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChhc3NvYy5yZW1vdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdcInNyY0ZpZWxkXCIgaXMgcmVxdWlyZWQgZm9yIG11bHRpcGxlIHJlbW90ZSBmaWVsZHMuIEVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc29jLnNyY0ZpZWxkLCBcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZHM6IGFzc29jLnJlbW90ZUZpZWxkcywgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgICAgIH0gICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBiYWNrUmVmID0gZGVzdEVudGl0eS5nZXRSZWZlcmVuY2VUbyhlbnRpdHkubmFtZSwgaW5jbHVkZXMsIGV4Y2x1ZGVzKTtcbiAgICAgICAgICAgICAgICBpZiAoYmFja1JlZikge1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgfHwgYmFja1JlZi50eXBlID09PSAnaGFzT25lJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMgPSBhc3NvYy5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubmVjdGVkQnlGaWVsZCA9IChjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0c1sxXSkgfHwgZW50aXR5Lm5hbWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgY29ubkVudGl0eU5hbWUgPSBPb2xVdGlscy5lbnRpdHlOYW1pbmcoY29ubmVjdGVkQnlQYXJ0c1swXSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFwiY29ubmVjdGVkQnlcIiByZXF1aXJlZCBmb3IgbTpuIHJlbGF0aW9uLiBTb3VyY2U6ICR7ZW50aXR5Lm5hbWV9LCBkZXN0aW5hdGlvbjogJHtkZXN0RW50aXR5TmFtZX1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiR7IGJhY2tSZWYudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IHRhZzIgPSBgJHtkZXN0RW50aXR5TmFtZX06JHsgYmFja1JlZi50eXBlID09PSAnaGFzTWFueScgPyAnbScgOiAnMScgfS0ke2VudGl0eS5uYW1lfTo6JHsgYXNzb2MudHlwZSA9PT0gJ2hhc01hbnknID8gJ24nIDogJzEnIH0gYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYXNzb2Muc3JjRmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0YWcxICs9ICcgJyArIGFzc29jLnNyY0ZpZWxkO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoYmFja1JlZi5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRhZzIgKz0gJyAnICsgYmFja1JlZi5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHRoaXMuX3Byb2Nlc3NlZFJlZi5oYXModGFnMSkgfHwgdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcyKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vYWxyZWFkeSBwcm9jZXNzZWQsIHNraXBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5UGFydHMyID0gYmFja1JlZi5jb25uZWN0ZWRCeS5zcGxpdCgnLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gKGNvbm5lY3RlZEJ5UGFydHMyLmxlbmd0aCA+IDEgJiYgY29ubmVjdGVkQnlQYXJ0czJbMV0pIHx8IGRlc3RFbnRpdHkubmFtZTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGNvbm5lY3RlZEJ5RmllbGQgPT09IGNvbm5lY3RlZEJ5RmllbGQyKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHkgPSBzY2hlbWEuZW50aXRpZXNbY29ubkVudGl0eU5hbWVdO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubkVudGl0eSA9IHRoaXMuX2FkZFJlbGF0aW9uRW50aXR5KHNjaGVtYSwgY29ubkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB0aGlzLl91cGRhdGVSZWxhdGlvbkVudGl0eShjb25uRW50aXR5LCBlbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGROYW1lID0gYXNzb2Muc3JjRmllbGQgfHwgcGx1cmFsaXplKGRlc3RFbnRpdHlOYW1lKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGROYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVmZXJzVG9GaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLi4uKGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyLCBhc3NvYy5jb25uZWN0ZWRXaXRoLCBsb2NhbEZpZWxkTmFtZSkgfSA6IHt9KSBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICApO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmVtb3RlRmllbGROYW1lID0gYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpOyAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRCeTogY29ubkVudGl0eU5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZDIsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlZmVyc1RvRmllbGQ6IGNvbm5lY3RlZEJ5RmllbGQsXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihiYWNrUmVmLnR5cGUgPT09ICdoYXNNYW55JyA/IHsgaXNMaXN0OiB0cnVlIH0gOiB7fSksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYmFja1JlZi5jb25uZWN0ZWRXaXRoID8geyBjb25uZWN0ZWRXaXRoOiB0aGlzLl9vb2xDb25kaXRpb25Ub1F1ZXJ5Q29uZGl0aW9uKGRlc3RFbnRpdHksIGNvbm5FbnRpdHksIGVudGl0eSwgY29ubmVjdGVkQnlGaWVsZDIsIGNvbm5lY3RlZEJ5RmllbGQsIGJhY2tSZWYuY29ubmVjdGVkV2l0aCwgcmVtb3RlRmllbGROYW1lKSB9IDoge30pICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fcHJvY2Vzc2VkUmVmLmFkZCh0YWcxKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRoaXMuX3Byb2Nlc3NlZFJlZi5hZGQodGFnMik7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoYmFja1JlZi50eXBlID09PSAnYmVsb25nc1RvJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFzc29jLmNvbm5lY3RlZEJ5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBiZWxvbmdzVG8gY29ubmVjdGVkQnkuIGVudGl0eTogJyArIGVudGl0eS5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy9sZWF2ZSBpdCB0byB0aGUgcmVmZXJlbmNlZCBlbnRpdHkgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1VuZXhwZWN0ZWQgcGF0aC4gRW50aXR5OiAnICsgZW50aXR5Lm5hbWUgKyAnLCBhc3NvY2lhdGlvbjogJyArIEpTT04uc3RyaW5naWZ5KGFzc29jLCBudWxsLCAyKSk7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmICghYXNzb2MuY29ubmVjdGVkQnkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IGFzc29jO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeVBhcnRzID0gYXNzb2MuY29ubmVjdGVkQnkuc3BsaXQoJy4nKTtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBjb25uZWN0ZWRCeVBhcnRzLmxlbmd0aCA8PSAyO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uZWN0ZWRCeUZpZWxkID0gKGNvbm5lY3RlZEJ5UGFydHMubGVuZ3RoID4gMSAmJiBjb25uZWN0ZWRCeVBhcnRzWzFdKSB8fCBlbnRpdHkubmFtZTtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5FbnRpdHlOYW1lID0gT29sVXRpbHMuZW50aXR5TmFtaW5nKGNvbm5lY3RlZEJ5UGFydHNbMF0pO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmICghY29ubkVudGl0eU5hbWUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgXCJjb25uZWN0ZWRCeVwiIHJlcXVpcmVkIGZvciBtOm4gcmVsYXRpb24uIFNvdXJjZTogJHtlbnRpdHkubmFtZX0sIGRlc3RpbmF0aW9uOiAke2Rlc3RFbnRpdHlOYW1lfWApO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGxldCB0YWcxID0gYCR7ZW50aXR5Lm5hbWV9OiR7IGFzc29jLnR5cGUgPT09ICdoYXNNYW55JyA/ICdtJyA6ICcxJyB9LSR7ZGVzdEVudGl0eU5hbWV9OiogYnkgJHtjb25uRW50aXR5TmFtZX1gO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChhc3NvYy5zcmNGaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGFnMSArPSAnICcgKyBhc3NvYy5zcmNGaWVsZDtcbiAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhdGhpcy5fcHJvY2Vzc2VkUmVmLmhhcyh0YWcxKTsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgbGV0IGNvbm5lY3RlZEJ5RmllbGQyID0gZGVzdEVudGl0eS5uYW1lO1xuXG4gICAgICAgICAgICAgICAgICAgIGlmIChjb25uZWN0ZWRCeUZpZWxkID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdDYW5ub3QgdXNlIHRoZSBzYW1lIFwiY29ubmVjdGVkQnlcIiBmaWVsZCBpbiBhIHJlbGF0aW9uIGVudGl0eS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgIGxldCBjb25uRW50aXR5ID0gc2NoZW1hLmVudGl0aWVzW2Nvbm5FbnRpdHlOYW1lXTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFjb25uRW50aXR5KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uRW50aXR5ID0gdGhpcy5fYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCBjb25uRW50aXR5TmFtZSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX3VwZGF0ZVJlbGF0aW9uRW50aXR5KGNvbm5FbnRpdHksIGVudGl0eSwgZGVzdEVudGl0eSwgY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuXG4gICAgICAgICAgICAgICAgICAgIGxldCBsb2NhbEZpZWxkTmFtZSA9IGFzc29jLnNyY0ZpZWxkIHx8IHBsdXJhbGl6ZShkZXN0RW50aXR5TmFtZSk7XG5cbiAgICAgICAgICAgICAgICAgICAgZW50aXR5LmFkZEFzc29jaWF0aW9uKFxuICAgICAgICAgICAgICAgICAgICAgICAgbG9jYWxGaWVsZE5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgZGVzdEVudGl0eSwgXG4gICAgICAgICAgICAgICAgICAgICAgICB7IFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIG9wdGlvbmFsOiBhc3NvYy5vcHRpb25hbCwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY29ubmVjdGVkQnk6IGNvbm5FbnRpdHlOYW1lLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogY29ubmVjdGVkQnlGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWZlcnNUb0ZpZWxkOiBjb25uZWN0ZWRCeUZpZWxkMiwgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC4uLihhc3NvYy50eXBlID09PSAnaGFzTWFueScgPyB7IGlzTGlzdDogdHJ1ZSB9IDoge30pLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAuLi4oYXNzb2MuY29ubmVjdGVkV2l0aCA/IHsgY29ubmVjdGVkV2l0aDogdGhpcy5fb29sQ29uZGl0aW9uVG9RdWVyeUNvbmRpdGlvbihlbnRpdHksIGNvbm5FbnRpdHksIGRlc3RFbnRpdHksIGNvbm5lY3RlZEJ5RmllbGQsIGNvbm5lY3RlZEJ5RmllbGQyLCBhc3NvYy5jb25uZWN0ZWRXaXRoLCBsb2NhbEZpZWxkTmFtZSkgfSA6IHt9KSBcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgKTtcblxuICAgICAgICAgICAgICAgICAgICB0aGlzLl9wcm9jZXNzZWRSZWYuYWRkKHRhZzEpOyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ3JlZmVyc1RvJzpcbiAgICAgICAgICAgIGNhc2UgJ2JlbG9uZ3NUbyc6XG4gICAgICAgICAgICAgICAgbGV0IGxvY2FsRmllbGQgPSBhc3NvYy5zcmNGaWVsZCB8fCBkZXN0RW50aXR5TmFtZTtcbiAgICAgICAgICAgICAgICBsZXQgZmllbGRQcm9wcyA9IHsgLi4uXy5vbWl0KGRlc3RLZXlGaWVsZCwgWydvcHRpb25hbCddKSwgLi4uXy5waWNrKGFzc29jLCBbJ29wdGlvbmFsJ10pIH07XG5cbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NGaWVsZChsb2NhbEZpZWxkLCBkZXN0RW50aXR5LCBmaWVsZFByb3BzKTtcbiAgICAgICAgICAgICAgICBlbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgIGxvY2FsRmllbGQsIFxuICAgICAgICAgICAgICAgICAgICBkZXN0RW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgeyBpc0xpc3Q6IGZhbHNlLCBvcHRpb25hbDogYXNzb2Mub3B0aW9uYWwgfVxuICAgICAgICAgICAgICAgICk7XG5cbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ2JlbG9uZ3NUbycpIHtcbiAgICAgICAgICAgICAgICAgICAgbGV0IGJhY2tSZWYgPSBkZXN0RW50aXR5LmdldFJlZmVyZW5jZVRvKFxuICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5Lm5hbWUsIFxuICAgICAgICAgICAgICAgICAgICAgICAgeyBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAncmVtb3RlRmllbGQnOiAocmVtb3RlRmllbGQpID0+IF8uaXNOaWwocmVtb3RlRmllbGQpIHx8IHJlbW90ZUZpZWxkID09IGxvY2FsRmllbGRcbiAgICAgICAgICAgICAgICAgICAgICAgIH0sICAvLyBpbmNsdWRlc1xuICAgICAgICAgICAgICAgICAgICAgICAgeyB0eXBlczogWyAncmVmZXJzVG8nLCAnYmVsb25nc1RvJyBdLCBhc3NvY2lhdGlvbjogYXNzb2MgfSAvLyBleGNsdWRlc1xuICAgICAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhY2tSZWYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcGx1cmFsaXplKGVudGl0eS5uYW1lKSwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZW50aXR5LCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB7IGlzTGlzdDogdHJ1ZSwgcmVtb3RlRmllbGQ6IGxvY2FsRmllbGQgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlc3RFbnRpdHkuYWRkQXNzb2NpYXRpb24oXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgYmFja1JlZi5zcmNGaWVsZCB8fCBwbHVyYWxpemUoZW50aXR5Lm5hbWUpLCBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBlbnRpdHksIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHsgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzTGlzdDogYmFja1JlZi50eXBlID09PSAnaGFzTWFueScsIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZDogbG9jYWxGaWVsZCxcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgb3B0aW9uYWw6IGJhY2tSZWYub3B0aW9uYWwgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShlbnRpdHkubmFtZSwgbG9jYWxGaWVsZCwgZGVzdEVudGl0eU5hbWUsIGRlc3RLZXlGaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgX29vbENvbmRpdGlvblRvUXVlcnlDb25kaXRpb24oZW50aXR5LCBjb25uRW50aXR5LCBkZXN0RW50aXR5LCBsb2NhbEZpZWxkTmFtZSwgcmVtb3RlRmllbGROYW1lLCBvb2xDb24sIGFuY2hvcikge1xuICAgICAgICBsZXQgY29udGV4dCA9IHsgXG4gICAgICAgICAgICBbY29ubkVudGl0eS5uYW1lXSA6IGFuY2hvclxuICAgICAgICB9OyAgICAgICAgXG5cbiAgICAgICAgYXNzZXJ0OiBvb2xDb24ub29sVHlwZTtcblxuICAgICAgICBpZiAob29sQ29uLm9vbFR5cGUgPT09ICdCaW5hcnlFeHByZXNzaW9uJykge1xuICAgICAgICAgICAgaWYgKG9vbENvbi5vcGVyYXRvciA9PT0gJz09Jykge1xuICAgICAgICAgICAgICAgIGxldCBsZWZ0ID0gb29sQ29uLmxlZnQ7XG4gICAgICAgICAgICAgICAgaWYgKGxlZnQub29sVHlwZSAmJiBsZWZ0Lm9vbFR5cGUgPT09ICdPYmplY3RSZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIGxlZnQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgbGVmdC5uYW1lKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSBvb2xDb24ucmlnaHQ7XG4gICAgICAgICAgICAgICAgaWYgKHJpZ2h0Lm9vbFR5cGUgJiYgcmlnaHQub29sVHlwZSA9PT0gJ09iamVjdFJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmlnaHQgPSB0aGlzLl90cmFuc2xhdGVSZWZlcmVuY2UoY29udGV4dCwgcmlnaHQubmFtZSk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgICAgICAgICAgW2xlZnRdOiB7ICckZXEnOiByaWdodCB9XG4gICAgICAgICAgICAgICAgfTsgXG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBfdHJhbnNsYXRlUmVmZXJlbmNlKGNvbnRleHQsIHJlZikge1xuICAgICAgICBsZXQgWyBiYXNlLCAuLi5vdGhlciBdID0gcmVmLnNwbGl0KCcuJyk7XG5cbiAgICAgICAgbGV0IHRyYW5zbGF0ZWQgPSBjb250ZXh0W2Jhc2VdO1xuICAgICAgICBpZiAoIXRyYW5zbGF0ZWQpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgUmVmZXJlbmNlZCBvYmplY3QgXCIke3JlZn1cIiBub3QgZm91bmQgaW4gY29udGV4dC5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBbIHRyYW5zbGF0ZWQsIC4uLm90aGVyIF0uam9pbignLicpO1xuICAgIH1cblxuICAgIF9hZGRSZWZlcmVuY2UobGVmdCwgbGVmdEZpZWxkLCByaWdodCwgcmlnaHRGaWVsZCkge1xuICAgICAgICBsZXQgcmVmczRMZWZ0RW50aXR5ID0gdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XTtcbiAgICAgICAgaWYgKCFyZWZzNExlZnRFbnRpdHkpIHtcbiAgICAgICAgICAgIHJlZnM0TGVmdEVudGl0eSA9IFtdO1xuICAgICAgICAgICAgdGhpcy5fcmVmZXJlbmNlc1tsZWZ0XSA9IHJlZnM0TGVmdEVudGl0eTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGxldCBmb3VuZCA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZCAmJiBpdGVtLnJpZ2h0ID09PSByaWdodCAmJiBpdGVtLnJpZ2h0RmllbGQgPT09IHJpZ2h0RmllbGQpXG4gICAgICAgICAgICApO1xuICAgIFxuICAgICAgICAgICAgaWYgKGZvdW5kKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIHJlZnM0TGVmdEVudGl0eS5wdXNoKHtsZWZ0RmllbGQsIHJpZ2h0LCByaWdodEZpZWxkfSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXM7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZWZlcmVuY2UgPSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZU9mRmllbGQobGVmdCwgbGVmdEZpZWxkKSB7XG4gICAgICAgIGxldCByZWZzNExlZnRFbnRpdHkgPSB0aGlzLl9yZWZlcmVuY2VzW2xlZnRdO1xuICAgICAgICBpZiAoIXJlZnM0TGVmdEVudGl0eSkgcmV0dXJuIGZhbHNlO1xuXG4gICAgICAgIHJldHVybiAodW5kZWZpbmVkICE9PSBfLmZpbmQocmVmczRMZWZ0RW50aXR5LFxuICAgICAgICAgICAgaXRlbSA9PiAoaXRlbS5sZWZ0RmllbGQgPT09IGxlZnRGaWVsZClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2dldFJlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdW5kZWZpbmVkO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlZmVyZW5jZSA9IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKTtcblxuICAgICAgICBpZiAoIXJlZmVyZW5jZSkge1xuICAgICAgICAgICAgcmV0dXJuIHVuZGVmaW5lZDtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZWZlcmVuY2U7XG4gICAgfVxuXG4gICAgX2hhc1JlZmVyZW5jZUJldHdlZW4obGVmdCwgcmlnaHQpIHtcbiAgICAgICAgbGV0IHJlZnM0TGVmdEVudGl0eSA9IHRoaXMuX3JlZmVyZW5jZXNbbGVmdF07XG4gICAgICAgIGlmICghcmVmczRMZWZ0RW50aXR5KSByZXR1cm4gZmFsc2U7XG5cbiAgICAgICAgcmV0dXJuICh1bmRlZmluZWQgIT09IF8uZmluZChyZWZzNExlZnRFbnRpdHksXG4gICAgICAgICAgICBpdGVtID0+IChpdGVtLnJpZ2h0ID09PSByaWdodClcbiAgICAgICAgKSk7XG4gICAgfVxuXG4gICAgX2ZlYXR1cmVSZWR1Y2VyKGVudGl0eSwgZmVhdHVyZU5hbWUsIGZlYXR1cmUpIHtcbiAgICAgICAgbGV0IGZpZWxkO1xuXG4gICAgICAgIHN3aXRjaCAoZmVhdHVyZU5hbWUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2F1dG9JZCc6XG4gICAgICAgICAgICAgICAgZmllbGQgPSBlbnRpdHkuZmllbGRzW2ZlYXR1cmUuZmllbGRdO1xuXG4gICAgICAgICAgICAgICAgaWYgKGZpZWxkLnR5cGUgPT09ICdpbnRlZ2VyJyAmJiAhZmllbGQuZ2VuZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgICAgIGZpZWxkLmF1dG9JbmNyZW1lbnRJZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgIGlmICgnc3RhcnRGcm9tJyBpbiBmaWVsZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5fZXZlbnRzLm9uKCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eS5uYW1lLCBleHRyYU9wdHMgPT4ge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGV4dHJhT3B0c1snQVVUT19JTkNSRU1FTlQnXSA9IGZpZWxkLnN0YXJ0RnJvbTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnY3JlYXRlVGltZXN0YW1wJzpcbiAgICAgICAgICAgICAgICBmaWVsZCA9IGVudGl0eS5maWVsZHNbZmVhdHVyZS5maWVsZF07XG4gICAgICAgICAgICAgICAgZmllbGQuaXNDcmVhdGVUaW1lc3RhbXAgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd1cGRhdGVUaW1lc3RhbXAnOlxuICAgICAgICAgICAgICAgIGZpZWxkID0gZW50aXR5LmZpZWxkc1tmZWF0dXJlLmZpZWxkXTtcbiAgICAgICAgICAgICAgICBmaWVsZC5pc1VwZGF0ZVRpbWVzdGFtcCA9IHRydWU7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2xvZ2ljYWxEZWxldGlvbic6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2F0TGVhc3RPbmVOb3ROdWxsJzpcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAndmFsaWRhdGVBbGxGaWVsZHNPbkNyZWF0aW9uJzpcbiAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnc3RhdGVUcmFja2luZyc6XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2kxOG4nOlxuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgZmVhdHVyZSBcIicgKyBmZWF0dXJlTmFtZSArICdcIi4nKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIF93cml0ZUZpbGUoZmlsZVBhdGgsIGNvbnRlbnQpIHtcbiAgICAgICAgZnMuZW5zdXJlRmlsZVN5bmMoZmlsZVBhdGgpO1xuICAgICAgICBmcy53cml0ZUZpbGVTeW5jKGZpbGVQYXRoLCBjb250ZW50KTtcblxuICAgICAgICB0aGlzLmxvZ2dlci5sb2coJ2luZm8nLCAnR2VuZXJhdGVkIGRiIHNjcmlwdDogJyArIGZpbGVQYXRoKTtcbiAgICB9XG5cbiAgICBfYWRkUmVsYXRpb25FbnRpdHkoc2NoZW1hLCByZWxhdGlvbkVudGl0eU5hbWUsIGVudGl0eTFSZWZGaWVsZCwgZW50aXR5MlJlZkZpZWxkKSB7XG4gICAgICAgIGxldCBlbnRpdHlJbmZvID0ge1xuICAgICAgICAgICAgZmVhdHVyZXM6IFsgJ2NyZWF0ZVRpbWVzdGFtcCcgXSxcbiAgICAgICAgICAgIGtleTogWyBlbnRpdHkxUmVmRmllbGQsIGVudGl0eTJSZWZGaWVsZCBdXG4gICAgICAgIH07XG5cbiAgICAgICAgbGV0IGVudGl0eSA9IG5ldyBFbnRpdHkodGhpcy5saW5rZXIsIHJlbGF0aW9uRW50aXR5TmFtZSwgc2NoZW1hLm9vbE1vZHVsZSwgZW50aXR5SW5mbyk7XG4gICAgICAgIGVudGl0eS5saW5rKCk7XG5cbiAgICAgICAgc2NoZW1hLmFkZEVudGl0eShlbnRpdHkpO1xuXG4gICAgICAgIHJldHVybiBlbnRpdHk7XG4gICAgfVxuXG4gICAgX3VwZGF0ZVJlbGF0aW9uRW50aXR5KHJlbGF0aW9uRW50aXR5LCBlbnRpdHkxLCBlbnRpdHkyLCBjb25uZWN0ZWRCeUZpZWxkLCBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICBsZXQgcmVsYXRpb25FbnRpdHlOYW1lID0gcmVsYXRpb25FbnRpdHkubmFtZTtcblxuICAgICAgICBpZiAocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMpIHtcbiAgICAgICAgICAgIGlmIChyZWxhdGlvbkVudGl0eU5hbWUgPT09ICdjb21wYW55Um9sZScpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRpcihyZWxhdGlvbkVudGl0eS5pbmZvLmFzc29jaWF0aW9ucywge2RlcHRoOiAxMCwgY29sb3JzOiB0cnVlfSk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coY29ubmVjdGVkQnlGaWVsZCwgY29ubmVjdGVkQnlGaWVsZDIpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgaGFzUmVmVG9FbnRpdHkxID0gZmFsc2UsIGhhc1JlZlRvRW50aXR5MiA9IGZhbHNlOyAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBfLmVhY2gocmVsYXRpb25FbnRpdHkuaW5mby5hc3NvY2lhdGlvbnMsIGFzc29jID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoYXNzb2MudHlwZSA9PT0gJ3JlZmVyc1RvJyAmJiBhc3NvYy5kZXN0RW50aXR5ID09PSBlbnRpdHkxLm5hbWUgJiYgKGFzc29jLnNyY0ZpZWxkIHx8IGVudGl0eTEubmFtZSkgPT09IGNvbm5lY3RlZEJ5RmllbGQpIHtcbiAgICAgICAgICAgICAgICAgICAgaGFzUmVmVG9FbnRpdHkxID0gdHJ1ZTsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGFzc29jLnR5cGUgPT09ICdyZWZlcnNUbycgJiYgYXNzb2MuZGVzdEVudGl0eSA9PT0gZW50aXR5Mi5uYW1lICYmIChhc3NvYy5zcmNGaWVsZCB8fCBlbnRpdHkyLm5hbWUpID09PSBjb25uZWN0ZWRCeUZpZWxkMikge1xuICAgICAgICAgICAgICAgICAgICBoYXNSZWZUb0VudGl0eTIgPSB0cnVlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBpZiAoaGFzUmVmVG9FbnRpdHkxICYmIGhhc1JlZlRvRW50aXR5Mikge1xuICAgICAgICAgICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKHJlbGF0aW9uRW50aXR5TmFtZSA9PT0gJ2NvbXBhbnlSb2xlJykge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnT0snKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgbGV0IGtleUVudGl0eTEgPSBlbnRpdHkxLmdldEtleUZpZWxkKCk7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGtleUVudGl0eTEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYENvbWJpbmF0aW9uIHByaW1hcnkga2V5IGlzIG5vdCBzdXBwb3J0ZWQuIEVudGl0eTogJHtlbnRpdHkxLm5hbWV9YCk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBrZXlFbnRpdHkyID0gZW50aXR5Mi5nZXRLZXlGaWVsZCgpO1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShrZXlFbnRpdHkyKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb21iaW5hdGlvbiBwcmltYXJ5IGtleSBpcyBub3Qgc3VwcG9ydGVkLiBFbnRpdHk6ICR7ZW50aXR5Mi5uYW1lfWApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVsYXRpb25FbnRpdHkuYWRkQXNzb2NGaWVsZChjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLCBfLm9taXQoa2V5RW50aXR5MSwgWydvcHRpb25hbCddKSk7XG4gICAgICAgIHJlbGF0aW9uRW50aXR5LmFkZEFzc29jRmllbGQoY29ubmVjdGVkQnlGaWVsZDIsIGVudGl0eTIsIF8ub21pdChrZXlFbnRpdHkyLCBbJ29wdGlvbmFsJ10pKTtcblxuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQsIFxuICAgICAgICAgICAgZW50aXR5MVxuICAgICAgICApO1xuICAgICAgICByZWxhdGlvbkVudGl0eS5hZGRBc3NvY2lhdGlvbihcbiAgICAgICAgICAgIGNvbm5lY3RlZEJ5RmllbGQyLCBcbiAgICAgICAgICAgIGVudGl0eTJcbiAgICAgICAgKTtcblxuICAgICAgICB0aGlzLl9hZGRSZWZlcmVuY2UocmVsYXRpb25FbnRpdHlOYW1lLCBjb25uZWN0ZWRCeUZpZWxkLCBlbnRpdHkxLm5hbWUsIGtleUVudGl0eTEubmFtZSk7XG4gICAgICAgIHRoaXMuX2FkZFJlZmVyZW5jZShyZWxhdGlvbkVudGl0eU5hbWUsIGNvbm5lY3RlZEJ5RmllbGQyLCBlbnRpdHkyLm5hbWUsIGtleUVudGl0eTIubmFtZSk7XG4gICAgICAgIHRoaXMuX3JlbGF0aW9uRW50aXRpZXNbcmVsYXRpb25FbnRpdHlOYW1lXSA9IHRydWU7XG4gICAgfVxuICAgIFxuICAgIHN0YXRpYyBvb2xPcFRvU3FsKG9wKSB7XG4gICAgICAgIHN3aXRjaCAob3ApIHtcbiAgICAgICAgICAgIGNhc2UgJz0nOlxuICAgICAgICAgICAgICAgIHJldHVybiAnPSc7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvb2xPcFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyAgICAgICAgICAgICAgICBcbiAgICAgICAgfVxuICAgIH1cbiAgICBcbiAgICBzdGF0aWMgb29sVG9TcWwoc2NoZW1hLCBkb2MsIG9vbCwgcGFyYW1zKSB7XG4gICAgICAgIGlmICghb29sLm9vbFR5cGUpIHtcbiAgICAgICAgICAgIHJldHVybiBvb2w7XG4gICAgICAgIH1cblxuICAgICAgICBzd2l0Y2ggKG9vbC5vb2xUeXBlKSB7XG4gICAgICAgICAgICBjYXNlICdCaW5hcnlFeHByZXNzaW9uJzpcbiAgICAgICAgICAgICAgICBsZXQgbGVmdCwgcmlnaHQ7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgaWYgKG9vbC5sZWZ0Lm9vbFR5cGUpIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLmxlZnQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbGVmdCA9IG9vbC5sZWZ0O1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvb2wucmlnaHQub29sVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICByaWdodCA9IE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgb29sLnJpZ2h0LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHJpZ2h0ID0gb29sLnJpZ2h0O1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm4gbGVmdCArICcgJyArIE15U1FMTW9kZWxlci5vb2xPcFRvU3FsKG9vbC5vcGVyYXRvcikgKyAnICcgKyByaWdodDtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY2FzZSAnT2JqZWN0UmVmZXJlbmNlJzpcbiAgICAgICAgICAgICAgICBpZiAoIU9vbFV0aWxzLmlzTWVtYmVyQWNjZXNzKG9vbC5uYW1lKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAocGFyYW1zICYmIF8uZmluZChwYXJhbXMsIHAgPT4gcC5uYW1lID09PSBvb2wubmFtZSkgIT09IC0xKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ3AnICsgXy51cHBlckZpcnN0KG9vbC5uYW1lKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBSZWZlcmVuY2luZyB0byBhIG5vbi1leGlzdGluZyBwYXJhbSBcIiR7b29sLm5hbWV9XCIuYCk7XG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgeyBlbnRpdHlOb2RlLCBlbnRpdHksIGZpZWxkIH0gPSBPb2xVdGlscy5wYXJzZVJlZmVyZW5jZUluRG9jdW1lbnQoc2NoZW1hLCBkb2MsIG9vbC5uYW1lKTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBlbnRpdHlOb2RlLmFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihmaWVsZC5uYW1lKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29vbFRvU3FsIHRvIGJlIGltcGxlbWVudGVkLicpOyBcbiAgICAgICAgfVxuICAgIH1cblxuICAgIHN0YXRpYyBfb3JkZXJCeVRvU3FsKHNjaGVtYSwgZG9jLCBvb2wpIHtcbiAgICAgICAgcmV0dXJuIE15U1FMTW9kZWxlci5vb2xUb1NxbChzY2hlbWEsIGRvYywgeyBvb2xUeXBlOiAnT2JqZWN0UmVmZXJlbmNlJywgbmFtZTogb29sLmZpZWxkIH0pICsgKG9vbC5hc2NlbmQgPyAnJyA6ICcgREVTQycpO1xuICAgIH1cblxuICAgIF92aWV3RG9jdW1lbnRUb1NRTChtb2RlbGluZ1NjaGVtYSwgdmlldykge1xuICAgICAgICBsZXQgc3FsID0gJyAgJztcbiAgICAgICAgLy9jb25zb2xlLmxvZygndmlldzogJyArIHZpZXcubmFtZSk7XG4gICAgICAgIGxldCBkb2MgPSBfLmNsb25lRGVlcCh2aWV3LmdldERvY3VtZW50SGllcmFyY2h5KG1vZGVsaW5nU2NoZW1hKSk7XG4gICAgICAgIC8vY29uc29sZS5kaXIoZG9jLCB7ZGVwdGg6IDgsIGNvbG9yczogdHJ1ZX0pO1xuXG4gICAgICAgIC8vbGV0IGFsaWFzTWFwcGluZyA9IHt9O1xuICAgICAgICBsZXQgWyBjb2xMaXN0LCBhbGlhcywgam9pbnMgXSA9IHRoaXMuX2J1aWxkVmlld1NlbGVjdChtb2RlbGluZ1NjaGVtYSwgZG9jLCAwKTtcbiAgICAgICAgXG4gICAgICAgIHNxbCArPSAnU0VMRUNUICcgKyBjb2xMaXN0LmpvaW4oJywgJykgKyAnIEZST00gJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZG9jLmVudGl0eSkgKyAnIEFTICcgKyBhbGlhcztcblxuICAgICAgICBpZiAoIV8uaXNFbXB0eShqb2lucykpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyBqb2lucy5qb2luKCcgJyk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGlmICghXy5pc0VtcHR5KHZpZXcuc2VsZWN0QnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgdmlldy5zZWxlY3RCeS5tYXAoc2VsZWN0ID0+IE15U1FMTW9kZWxlci5vb2xUb1NxbChtb2RlbGluZ1NjaGVtYSwgZG9jLCBzZWxlY3QsIHZpZXcucGFyYW1zKSkuam9pbignIEFORCAnKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgaWYgKCFfLmlzRW1wdHkodmlldy5ncm91cEJ5KSkge1xuICAgICAgICAgICAgc3FsICs9ICcgR1JPVVAgQlkgJyArIHZpZXcuZ3JvdXBCeS5tYXAoY29sID0+IE15U1FMTW9kZWxlci5fb3JkZXJCeVRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIGNvbCkpLmpvaW4oJywgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIV8uaXNFbXB0eSh2aWV3Lm9yZGVyQnkpKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBPUkRFUiBCWSAnICsgdmlldy5vcmRlckJ5Lm1hcChjb2wgPT4gTXlTUUxNb2RlbGVyLl9vcmRlckJ5VG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgY29sKSkuam9pbignLCAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBza2lwID0gdmlldy5za2lwIHx8IDA7XG4gICAgICAgIGlmICh2aWV3LmxpbWl0KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCAnICsgTXlTUUxNb2RlbGVyLm9vbFRvU3FsKG1vZGVsaW5nU2NoZW1hLCBkb2MsIHNraXAsIHZpZXcucGFyYW1zKSArICcsICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5saW1pdCwgdmlldy5wYXJhbXMpO1xuICAgICAgICB9IGVsc2UgaWYgKHZpZXcuc2tpcCkge1xuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUICcgKyBNeVNRTE1vZGVsZXIub29sVG9TcWwobW9kZWxpbmdTY2hlbWEsIGRvYywgdmlldy5za2lwLCB2aWV3LnBhcmFtcyk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIF9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpIHtcbiAgICAgICAgbGV0IGVudGl0eSA9IHNjaGVtYS5lbnRpdGllc1tkb2MuZW50aXR5XTtcbiAgICAgICAgbGV0IGFsaWFzID0gbnRvbChzdGFydEluZGV4KyspO1xuICAgICAgICBkb2MuYWxpYXMgPSBhbGlhcztcblxuICAgICAgICBsZXQgY29sTGlzdCA9IE9iamVjdC5rZXlzKGVudGl0eS5maWVsZHMpLm1hcChrID0+IGFsaWFzICsgJy4nICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihrKSk7XG4gICAgICAgIGxldCBqb2lucyA9IFtdO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KGRvYy5zdWJEb2N1bWVudHMpKSB7XG4gICAgICAgICAgICBfLmZvck93bihkb2Muc3ViRG9jdW1lbnRzLCAoZG9jLCBmaWVsZE5hbWUpID0+IHtcbiAgICAgICAgICAgICAgICBsZXQgWyBzdWJDb2xMaXN0LCBzdWJBbGlhcywgc3ViSm9pbnMsIHN0YXJ0SW5kZXgyIF0gPSB0aGlzLl9idWlsZFZpZXdTZWxlY3Qoc2NoZW1hLCBkb2MsIHN0YXJ0SW5kZXgpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SW5kZXggPSBzdGFydEluZGV4MjtcbiAgICAgICAgICAgICAgICBjb2xMaXN0ID0gY29sTGlzdC5jb25jYXQoc3ViQ29sTGlzdCk7XG4gICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbnMucHVzaCgnTEVGVCBKT0lOICcgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5lbnRpdHkpICsgJyBBUyAnICsgc3ViQWxpYXNcbiAgICAgICAgICAgICAgICAgICAgKyAnIE9OICcgKyBhbGlhcyArICcuJyArIE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIoZmllbGROYW1lKSArICcgPSAnICtcbiAgICAgICAgICAgICAgICAgICAgc3ViQWxpYXMgKyAnLicgKyBNeVNRTE1vZGVsZXIucXVvdGVJZGVudGlmaWVyKGRvYy5saW5rV2l0aEZpZWxkKSk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNFbXB0eShzdWJKb2lucykpIHtcbiAgICAgICAgICAgICAgICAgICAgam9pbnMgPSBqb2lucy5jb25jYXQoc3ViSm9pbnMpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIFsgY29sTGlzdCwgYWxpYXMsIGpvaW5zLCBzdGFydEluZGV4IF07XG4gICAgfVxuXG4gICAgX2NyZWF0ZVRhYmxlU3RhdGVtZW50KGVudGl0eU5hbWUsIGVudGl0eSkge1xuICAgICAgICBsZXQgc3FsID0gJ0NSRUFURSBUQUJMRSBJRiBOT1QgRVhJU1RTIGAnICsgZW50aXR5TmFtZSArICdgIChcXG4nO1xuXG4gICAgICAgIC8vY29sdW1uIGRlZmluaXRpb25zXG4gICAgICAgIF8uZWFjaChlbnRpdHkuZmllbGRzLCAoZmllbGQsIG5hbWUpID0+IHtcbiAgICAgICAgICAgIHNxbCArPSAnICAnICsgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihuYW1lKSArICcgJyArIE15U1FMTW9kZWxlci5jb2x1bW5EZWZpbml0aW9uKGZpZWxkKSArICcsXFxuJztcbiAgICAgICAgfSk7XG5cbiAgICAgICAgLy9wcmltYXJ5IGtleVxuICAgICAgICBzcWwgKz0gJyAgUFJJTUFSWSBLRVkgKCcgKyBNeVNRTE1vZGVsZXIucXVvdGVMaXN0T3JWYWx1ZShlbnRpdHkua2V5KSArICcpLFxcbic7XG5cbiAgICAgICAgLy9vdGhlciBrZXlzXG4gICAgICAgIGlmIChlbnRpdHkuaW5kZXhlcyAmJiBlbnRpdHkuaW5kZXhlcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICBlbnRpdHkuaW5kZXhlcy5mb3JFYWNoKGluZGV4ID0+IHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyAgJztcbiAgICAgICAgICAgICAgICBpZiAoaW5kZXgudW5pcXVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnVU5JUVVFICc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNxbCArPSAnS0VZICgnICsgTXlTUUxNb2RlbGVyLnF1b3RlTGlzdE9yVmFsdWUoaW5kZXguZmllbGRzKSArICcpLFxcbic7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBsaW5lcyA9IFtdO1xuICAgICAgICB0aGlzLl9ldmVudHMuZW1pdCgnYmVmb3JlRW5kQ29sdW1uRGVmaW5pdGlvbjonICsgZW50aXR5TmFtZSwgbGluZXMpO1xuICAgICAgICBpZiAobGluZXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgICcgKyBsaW5lcy5qb2luKCcsXFxuICAnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHNxbCA9IHNxbC5zdWJzdHIoMCwgc3FsLmxlbmd0aC0yKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCArPSAnXFxuKSc7XG5cbiAgICAgICAgLy90YWJsZSBvcHRpb25zXG4gICAgICAgIGxldCBleHRyYVByb3BzID0ge307XG4gICAgICAgIHRoaXMuX2V2ZW50cy5lbWl0KCdzZXRUYWJsZU9wdGlvbnM6JyArIGVudGl0eU5hbWUsIGV4dHJhUHJvcHMpO1xuICAgICAgICBsZXQgcHJvcHMgPSBPYmplY3QuYXNzaWduKHt9LCB0aGlzLl9kYk9wdGlvbnMudGFibGUsIGV4dHJhUHJvcHMpO1xuXG4gICAgICAgIHNxbCA9IF8ucmVkdWNlKHByb3BzLCBmdW5jdGlvbihyZXN1bHQsIHZhbHVlLCBrZXkpIHtcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQgKyAnICcgKyBrZXkgKyAnPScgKyB2YWx1ZTtcbiAgICAgICAgfSwgc3FsKTtcblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuICAgIFxuICAgIF9hZGRGb3JlaWduS2V5U3RhdGVtZW50KGVudGl0eU5hbWUsIHJlbGF0aW9uKSB7XG4gICAgICAgIGxldCBzcWwgPSAnQUxURVIgVEFCTEUgYCcgKyBlbnRpdHlOYW1lICtcbiAgICAgICAgICAgICdgIEFERCBGT1JFSUdOIEtFWSAoYCcgKyByZWxhdGlvbi5sZWZ0RmllbGQgKyAnYCkgJyArXG4gICAgICAgICAgICAnUkVGRVJFTkNFUyBgJyArIHJlbGF0aW9uLnJpZ2h0ICsgJ2AgKGAnICsgcmVsYXRpb24ucmlnaHRGaWVsZCArICdgKSAnO1xuXG4gICAgICAgIHNxbCArPSAnJztcblxuICAgICAgICBpZiAodGhpcy5fcmVsYXRpb25FbnRpdGllc1tlbnRpdHlOYW1lXSkge1xuICAgICAgICAgICAgc3FsICs9ICdPTiBERUxFVEUgQ0FTQ0FERSBPTiBVUERBVEUgQ0FTQ0FERSc7XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBzcWwgKz0gJ09OIERFTEVURSBOTyBBQ1RJT04gT04gVVBEQVRFIE5PIEFDVElPTic7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgKz0gJztcXG4nO1xuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGZvcmVpZ25LZXlGaWVsZE5hbWluZyhlbnRpdHlOYW1lLCBlbnRpdHkpIHtcbiAgICAgICAgbGV0IGxlZnRQYXJ0ID0gVXRpbC5fLmNhbWVsQ2FzZShlbnRpdHlOYW1lKTtcbiAgICAgICAgbGV0IHJpZ2h0UGFydCA9IFV0aWwucGFzY2FsQ2FzZShlbnRpdHkua2V5KTtcblxuICAgICAgICBpZiAoXy5lbmRzV2l0aChsZWZ0UGFydCwgcmlnaHRQYXJ0KSkge1xuICAgICAgICAgICAgcmV0dXJuIGxlZnRQYXJ0O1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGxlZnRQYXJ0ICsgcmlnaHRQYXJ0O1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZVN0cmluZyhzdHIpIHtcbiAgICAgICAgcmV0dXJuIFwiJ1wiICsgc3RyLnJlcGxhY2UoLycvZywgXCJcXFxcJ1wiKSArIFwiJ1wiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUlkZW50aWZpZXIoc3RyKSB7XG4gICAgICAgIHJldHVybiBcImBcIiArIHN0ciArIFwiYFwiO1xuICAgIH1cblxuICAgIHN0YXRpYyBxdW90ZUxpc3RPclZhbHVlKG9iaikge1xuICAgICAgICByZXR1cm4gXy5pc0FycmF5KG9iaikgP1xuICAgICAgICAgICAgb2JqLm1hcCh2ID0+IE15U1FMTW9kZWxlci5xdW90ZUlkZW50aWZpZXIodikpLmpvaW4oJywgJykgOlxuICAgICAgICAgICAgTXlTUUxNb2RlbGVyLnF1b3RlSWRlbnRpZmllcihvYmopO1xuICAgIH1cblxuICAgIHN0YXRpYyBjb21wbGlhbmNlQ2hlY2soZW50aXR5KSB7XG4gICAgICAgIGxldCByZXN1bHQgPSB7IGVycm9yczogW10sIHdhcm5pbmdzOiBbXSB9O1xuXG4gICAgICAgIGlmICghZW50aXR5LmtleSkge1xuICAgICAgICAgICAgcmVzdWx0LmVycm9ycy5wdXNoKCdQcmltYXJ5IGtleSBpcyBub3Qgc3BlY2lmaWVkLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBzdGF0aWMgY29sdW1uRGVmaW5pdGlvbihmaWVsZCwgaXNQcm9jKSB7XG4gICAgICAgIGxldCBjb2w7XG4gICAgICAgIFxuICAgICAgICBzd2l0Y2ggKGZpZWxkLnR5cGUpIHtcbiAgICAgICAgICAgIGNhc2UgJ2ludGVnZXInOlxuICAgICAgICAgICAgY29sID0gTXlTUUxNb2RlbGVyLmludENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdudW1iZXInOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5mbG9hdENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICd0ZXh0JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdib29sZWFuJzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIuYm9vbENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdiaW5hcnknOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5iaW5hcnlDb2x1bW5EZWZpbml0aW9uKGZpZWxkKTtcbiAgICAgICAgICAgICAgICBicmVhaztcblxuICAgICAgICAgICAgY2FzZSAnZGF0ZXRpbWUnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5kYXRldGltZUNvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBjYXNlICdvYmplY3QnOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci50ZXh0Q29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGNhc2UgJ2VudW0nOlxuICAgICAgICAgICAgY29sID0gIE15U1FMTW9kZWxlci5lbnVtQ29sdW1uRGVmaW5pdGlvbihmaWVsZCk7XG4gICAgICAgICAgICAgICAgYnJlYWs7XG5cbiAgICAgICAgICAgIGNhc2UgJ2FycmF5JzpcbiAgICAgICAgICAgIGNvbCA9ICBNeVNRTE1vZGVsZXIudGV4dENvbHVtbkRlZmluaXRpb24oZmllbGQpO1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuXG4gICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVW5zdXBwb3J0ZWQgdHlwZSBcIicgKyBmaWVsZC50eXBlICsgJ1wiLicpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHsgc3FsLCB0eXBlIH0gPSBjb2w7ICAgICAgICBcblxuICAgICAgICBpZiAoIWlzUHJvYykge1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuY29sdW1uTnVsbGFibGUoZmllbGQpO1xuICAgICAgICAgICAgc3FsICs9IHRoaXMuZGVmYXVsdFZhbHVlKGZpZWxkLCB0eXBlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBzcWw7XG4gICAgfVxuXG4gICAgc3RhdGljIGludENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmRpZ2l0cykge1xuICAgICAgICAgICAgaWYgKGluZm8uZGlnaXRzID4gMTApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JJR0lOVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8uZGlnaXRzID4gNykge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby5kaWdpdHMgPiA0KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1JTlQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLmRpZ2l0cyA+IDIpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1NNQUxMSU5UJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdUSU5ZSU5UJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3FsICs9IGAoJHtpbmZvLmRpZ2l0c30pYFxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdJTlQnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluZm8udW5zaWduZWQpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFVOU0lHTkVEJztcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB7IHNxbCwgdHlwZSB9O1xuICAgIH1cblxuICAgIHN0YXRpYyBmbG9hdENvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8udHlwZSA9PSAnbnVtYmVyJyAmJiBpbmZvLmV4YWN0KSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0RFQ0lNQUwnO1xuXG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDY1KSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUb3RhbCBkaWdpdHMgZXhjZWVkIG1heGltdW0gbGltaXQuJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICBpZiAoaW5mby50b3RhbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdET1VCTEUnO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udG90YWxEaWdpdHMgPiA1Mykge1xuICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RvdGFsIGRpZ2l0cyBleGNlZWQgbWF4aW11bSBsaW1pdC4nKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnRkxPQVQnO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCd0b3RhbERpZ2l0cycgaW4gaW5mbykge1xuICAgICAgICAgICAgc3FsICs9ICcoJyArIGluZm8udG90YWxEaWdpdHM7XG4gICAgICAgICAgICBpZiAoJ2RlY2ltYWxEaWdpdHMnIGluIGluZm8pIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJywgJyAraW5mby5kZWNpbWFsRGlnaXRzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3FsICs9ICcpJztcblxuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgaWYgKCdkZWNpbWFsRGlnaXRzJyBpbiBpbmZvKSB7XG4gICAgICAgICAgICAgICAgaWYgKGluZm8uZGVjaW1hbERpZ2l0cyA+IDIzKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDUzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfSBlbHNlICB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKDIzLCAnICtpbmZvLmRlY2ltYWxEaWdpdHMgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIHRleHRDb2x1bW5EZWZpbml0aW9uKGluZm8pIHtcbiAgICAgICAgbGV0IHNxbCA9ICcnLCB0eXBlO1xuXG4gICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoICYmIGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQ0hBUignICsgaW5mby5maXhlZExlbmd0aCArICcpJztcbiAgICAgICAgICAgIHR5cGUgPSAnQ0hBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5tYXhMZW5ndGgpIHtcbiAgICAgICAgICAgIGlmIChpbmZvLm1heExlbmd0aCA+IDE2Nzc3MjE1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdMT05HVEVYVCc7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoID4gNjU1MzUpIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ01FRElVTVRFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDIwMDApIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB0eXBlID0gc3FsID0gJ1ZBUkNIQVInO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ1RFWFQnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJpbmFyeUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICBsZXQgc3FsID0gJycsIHR5cGU7XG5cbiAgICAgICAgaWYgKGluZm8uZml4ZWRMZW5ndGggPD0gMjU1KSB7XG4gICAgICAgICAgICBzcWwgPSAnQklOQVJZKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgdHlwZSA9ICdCSU5BUlknO1xuICAgICAgICB9IGVsc2UgaWYgKGluZm8ubWF4TGVuZ3RoKSB7XG4gICAgICAgICAgICBpZiAoaW5mby5tYXhMZW5ndGggPiAxNjc3NzIxNSkge1xuICAgICAgICAgICAgICAgIHR5cGUgPSBzcWwgPSAnTE9OR0JMT0InO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLm1heExlbmd0aCA+IDY1NTM1KSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdNRURJVU1CTE9CJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdHlwZSA9IHNxbCA9ICdWQVJCSU5BUlknO1xuICAgICAgICAgICAgICAgIGlmIChpbmZvLmZpeGVkTGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLmZpeGVkTGVuZ3RoICsgJyknO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnKCcgKyBpbmZvLm1heExlbmd0aCArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICB0eXBlID0gc3FsID0gJ0JMT0InO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGJvb2xDb2x1bW5EZWZpbml0aW9uKCkge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdUSU5ZSU5UKDEpJywgdHlwZTogJ1RJTllJTlQnIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGRhdGV0aW1lQ29sdW1uRGVmaW5pdGlvbihpbmZvKSB7XG4gICAgICAgIGxldCBzcWw7XG5cbiAgICAgICAgaWYgKCFpbmZvLnJhbmdlIHx8IGluZm8ucmFuZ2UgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgIHNxbCA9ICdEQVRFVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ2RhdGUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnREFURSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWUnKSB7XG4gICAgICAgICAgICBzcWwgPSAnVElNRSc7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3llYXInKSB7XG4gICAgICAgICAgICBzcWwgPSAnWUVBUic7XG4gICAgICAgIH0gZWxzZSBpZiAoaW5mby5yYW5nZSA9PT0gJ3RpbWVzdGFtcCcpIHtcbiAgICAgICAgICAgIHNxbCA9ICdUSU1FU1RBTVAnO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHsgc3FsLCB0eXBlOiBzcWwgfTtcbiAgICB9XG5cbiAgICBzdGF0aWMgZW51bUNvbHVtbkRlZmluaXRpb24oaW5mbykge1xuICAgICAgICByZXR1cm4geyBzcWw6ICdFTlVNKCcgKyBfLm1hcChpbmZvLnZhbHVlcywgKHYpID0+IE15U1FMTW9kZWxlci5xdW90ZVN0cmluZyh2KSkuam9pbignLCAnKSArICcpJywgdHlwZTogJ0VOVU0nIH07XG4gICAgfVxuXG4gICAgc3RhdGljIGNvbHVtbk51bGxhYmxlKGluZm8pIHtcbiAgICAgICAgaWYgKGluZm8uaGFzT3duUHJvcGVydHkoJ29wdGlvbmFsJykgJiYgaW5mby5vcHRpb25hbCkge1xuICAgICAgICAgICAgcmV0dXJuICcgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJyBOT1QgTlVMTCc7XG4gICAgfVxuXG4gICAgc3RhdGljIGRlZmF1bHRWYWx1ZShpbmZvLCB0eXBlKSB7XG4gICAgICAgIGlmIChpbmZvLmlzQ3JlYXRlVGltZXN0YW1wKSB7XG4gICAgICAgICAgICBpbmZvLmNyZWF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgREVGQVVMVCBDVVJSRU5UX1RJTUVTVEFNUCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5mby5hdXRvSW5jcmVtZW50SWQpIHtcbiAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICByZXR1cm4gJyBBVVRPX0lOQ1JFTUVOVCc7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChpbmZvLmlzVXBkYXRlVGltZXN0YW1wKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBpbmZvLnVwZGF0ZUJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgcmV0dXJuICcgT04gVVBEQVRFIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnJztcblxuICAgICAgICBpZiAoIWluZm8ub3B0aW9uYWwpIHsgICAgICBcbiAgICAgICAgICAgIGlmIChpbmZvLmhhc093blByb3BlcnR5KCdkZWZhdWx0JykpIHtcbiAgICAgICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mb1snZGVmYXVsdCddO1xuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChUeXBlcy5CT09MRUFOLnNhbml0aXplKGRlZmF1bHRWYWx1ZSkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAvL3RvZG86IG90aGVyIHR5cGVzXG5cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoIWluZm8uaGFzT3duUHJvcGVydHkoJ2F1dG8nKSkge1xuICAgICAgICAgICAgICAgIGlmIChVTlNVUFBPUlRFRF9ERUZBVUxUX1ZBTFVFLmhhcyh0eXBlKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJyc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGluZm8udHlwZSA9PT0gJ2Jvb2xlYW4nIHx8IGluZm8udHlwZSA9PT0gJ2ludGVnZXInIHx8IGluZm8udHlwZSA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAwJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2RhdGV0aW1lJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUIENVUlJFTlRfVElNRVNUQU1QJztcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ2VudW0nKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArICBxdW90ZShpbmZvLnZhbHVlc1swXSk7XG4gICAgICAgICAgICAgICAgfSAgZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgXCJcIic7XG4gICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgIGluZm8uY3JlYXRlQnlEYiA9IHRydWU7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0gICAgICAgIFxuICAgIFxuICAgICAgICAvKlxuICAgICAgICBpZiAoaW5mby5oYXNPd25Qcm9wZXJ0eSgnZGVmYXVsdCcpICYmIHR5cGVvZiBpbmZvLmRlZmF1bHQgPT09ICdvYmplY3QnICYmIGluZm8uZGVmYXVsdC5vb2xUeXBlID09PSAnU3ltYm9sVG9rZW4nKSB7XG4gICAgICAgICAgICBsZXQgZGVmYXVsdFZhbHVlID0gaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgbGV0IGRlZmF1bHRCeURiID0gZmFsc2U7XG5cbiAgICAgICAgICAgIHN3aXRjaCAoZGVmYXVsdFZhbHVlLm5hbWUpIHtcbiAgICAgICAgICAgICAgICBjYXNlICdub3cnOlxuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgTk9XJ1xuICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoZGVmYXVsdEJ5RGIpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgaW5mby5kZWZhdWx0O1xuICAgICAgICAgICAgICAgIGluZm8uZGVmYXVsdEJ5RGIgPSB0cnVlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoaW5mby50eXBlID09PSAnYm9vbCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc1N0cmluZyhkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChTKGRlZmF1bHRWYWx1ZSkudG9Cb29sZWFuKCkgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIChkZWZhdWx0VmFsdWUgPyAnMScgOiAnMCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnaW50Jykge1xuICAgICAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlSW50KGRlZmF1bHRWYWx1ZSkudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3RleHQnKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdmbG9hdCcpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc051bWJlcihkZWZhdWx0VmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIGRlZmF1bHRWYWx1ZS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIHBhcnNlRmxvYXQoZGVmYXVsdFZhbHVlKS50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSBpZiAoaW5mby50eXBlID09PSAnYmluYXJ5Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwuYmluMkhleChkZWZhdWx0VmFsdWUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdkYXRldGltZScpIHtcbiAgICAgICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoZGVmYXVsdFZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBkZWZhdWx0VmFsdWUudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIGlmIChpbmZvLnR5cGUgPT09ICdqc29uJykge1xuICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgZGVmYXVsdFZhbHVlID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICBzcWwgKz0gJyBERUZBVUxUICcgKyBVdGlsLnF1b3RlKGRlZmF1bHRWYWx1ZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3FsICs9ICcgREVGQVVMVCAnICsgVXRpbC5xdW90ZShKU09OLnN0cmluZ2lmeShkZWZhdWx0VmFsdWUpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2UgaWYgKGluZm8udHlwZSA9PT0gJ3htbCcgfHwgaW5mby50eXBlID09PSAnZW51bScgfHwgaW5mby50eXBlID09PSAnY3N2Jykge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIERFRkFVTFQgJyArIFV0aWwucXVvdGUoZGVmYXVsdFZhbHVlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbmV4cGVjdGVkIHBhdGgnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSAgICBcbiAgICAgICAgKi8gICAgXG4gICAgICAgIFxuICAgICAgICByZXR1cm4gc3FsO1xuICAgIH1cblxuICAgIHN0YXRpYyByZW1vdmVUYWJsZU5hbWVQcmVmaXgoZW50aXR5TmFtZSwgcmVtb3ZlVGFibGVQcmVmaXgpIHtcbiAgICAgICAgaWYgKHJlbW92ZVRhYmxlUHJlZml4KSB7XG4gICAgICAgICAgICBlbnRpdHlOYW1lID0gXy50cmltKF8uc25ha2VDYXNlKGVudGl0eU5hbWUpKTtcblxuICAgICAgICAgICAgcmVtb3ZlVGFibGVQcmVmaXggPSBfLnRyaW1FbmQoXy5zbmFrZUNhc2UocmVtb3ZlVGFibGVQcmVmaXgpLCAnXycpICsgJ18nO1xuXG4gICAgICAgICAgICBpZiAoXy5zdGFydHNXaXRoKGVudGl0eU5hbWUsIHJlbW92ZVRhYmxlUHJlZml4KSkge1xuICAgICAgICAgICAgICAgIGVudGl0eU5hbWUgPSBlbnRpdHlOYW1lLnN1YnN0cihyZW1vdmVUYWJsZVByZWZpeC5sZW5ndGgpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIE9vbFV0aWxzLmVudGl0eU5hbWluZyhlbnRpdHlOYW1lKTtcbiAgICB9O1xufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMTW9kZWxlcjsiXX0=