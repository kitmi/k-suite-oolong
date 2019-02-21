"use strict";

const EventEmitter = require('events');
const path = require('path');
const ntol = require('number-to-letter');

const Util = require('rk-utils');
const { _, fs, quote } = Util;

const OolUtils = require('../../../lang/OolUtils');
const { pluralize } = OolUtils;
const Entity = require('../../../lang/Entity');
const Types = require('../../../runtime/types');

const UNSUPPORTED_DEFAULT_VALUE = new Set(['BLOB', 'TEXT', 'JSON', 'GEOMETRY']);

/*
const MYSQL_KEYWORDS = [
    'select',
    'from',
    'where',
    'limit',
    'order',
    'group',
    'distinct',
    'insert',
    'update',
    'in',
    'offset',
    'by',
    'asc',
    'desc',
    'delete',
    'begin',
    'end',
    'left',
    'right',
    'join',
    'on',
    'and',
    'or',
    'not',
    'returns',
    'return',
    'create',
    'alter'
];
*/

/**
 * Ooolong database modeler for mysql db.
 * @class
 */
class MySQLModeler {
    /**     
     * @param {object} context
     * @property {Logger} context.logger - Logger object     
     * @property {OolongLinker} context.linker - Oolong DSL linker
     * @property {string} context.scriptOutputPath - Generated script path
     * @param {object} dbOptions
     * @property {object} dbOptions.db
     * @property {object} dbOptions.table
     */
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

        _.each(existingEntities, (entity) => {
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

        //build SQL scripts
        let sqlFilesDir = path.join('mysql', this.connector.database);
        let dbFilePath = path.join(sqlFilesDir, 'entities.sql');
        let fkFilePath = path.join(sqlFilesDir, 'relations.sql');
        let initIdxFilePath = path.join(sqlFilesDir, 'data', '_init', 'index.list');
        let initFilePath = path.join(sqlFilesDir, 'data', '_init', '0-init.json');
        let tableSQL = '', relationSQL = '', data = {};

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
                //intiSQL += `-- Initial data for entity: ${entityName}\n`;
                let entityData = [];

                if (Array.isArray(entity.info.data)) {
                    entity.info.data.forEach(record => {
                        if (!_.isPlainObject(record)) {
                            let fields = Object.keys(entity.fields);
                            if (fields.length !== 2) {
                                throw new Error(`Invalid data syntax: entity "${entity.name}" has more than 2 fields.`);
                            }

                            record = { [fields[1]]: this.linker.translateOolValue(entity.oolModule, record) };
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

                            record = {[entity.key]: key, [fields[1]]: this.linker.translateOolValue(entity.oolModule, record)};
                        } else {
                            record = Object.assign({[entity.key]: key}, this.linker.translateOolValue(entity.oolModule, record));
                        }

                        entityData.push(record);
                        //intiSQL += 'INSERT INTO `' + entityName + '` SET ' + _.map(record, (v,k) => '`' + k + '` = ' + JSON.stringify(v)).join(', ') + ';\n';
                    });
                }

                if (!_.isEmpty(entityData)) {
                    data[entityName] = entityData;
                }

                //intiSQL += '\n';
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
        
        //process view
        /*
        _.each(modelingSchema.views, (view, viewName) => {
            view.inferTypeInfo(modelingSchema);

            funcSQL += `CREATE PROCEDURE ${dbService.getViewSPName(viewName)}(`;
            
            if (!_.isEmpty(view.params)) {
                let paramSQLs = [];
                view.params.forEach(param => {
                    paramSQLs.push(`p${_.upperFirst(param.name)} ${MySQLModeler.columnDefinition(param, true)}`);
                });

                funcSQL += paramSQLs.join(', ');
            }

            funcSQL += `)\nCOMMENT 'SP for view ${viewName}'\nREADS SQL DATA\nBEGIN\n`;

            funcSQL += this._viewDocumentToSQL(modelingSchema, view) + ';';

            funcSQL += '\nEND;\n\n';
        });
        */

        let spFilePath = path.join(sqlFilesDir, 'procedures.sql');
        this._writeFile(path.join(this.outputPath, spFilePath), funcSQL);

        return modelingSchema;
    }    

    _toColumnReference(name) {
        return { oorType: 'ColumnReference', name };  
    }

    _translateJoinCondition(context, localField, anchor, remoteField) {
        if (Array.isArray(remoteField)) {
            return remoteField.map(rf => this._translateJoinCondition(context, localField, anchor, rf));
        }

        if (_.isPlainObject(remoteField)) {
            let ret = { [localField]: this._toColumnReference(anchor + '.' + remoteField.by) };
            let withExtra = this._oolConditionToQueryCondition(context, remoteField.with);
            
            if (localField in withExtra) {
                return { $and: [ ret, withExtra ] };
            }
            
            return { ...ret, ...withExtra };
        }

        return { [localField]: this._toColumnReference(anchor + '.' + remoteField) };
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

    /**
     * hasMany/hasOne - belongsTo      
     * hasMany/hasOne - hasMany/hasOne [connectedBy] [connectedWith]
     * hasMany - semi connection       
     * refersTo - semi connection
     *      
     * remoteField:
     *   1. fieldName
     *   2. array of fieldName
     *   3. { by , with }
     *   4. array of fieldName and { by , with } mixed
     *  
     * @param {*} schema 
     * @param {*} entity 
     * @param {*} assoc 
     */
    _processAssociation(schema, entity, assoc, assocNames) {
        let entityKeyField = entity.getKeyField();
        assert: !Array.isArray(entityKeyField);

        let destEntityName = assoc.destEntity;
        //todo: cross db reference
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
                    types: [ 'refersTo' ], 
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
                        assert: connectedByParts.length <= 2;

                        // connected by field is usually a refersTo assoc
                        let connectedByField = (connectedByParts.length > 1 && connectedByParts[1]) || entity.name; 
                        let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

                        assert: connEntityName;

                        let tag1 = `${entity.name}:${ assoc.type === 'hasMany' ? 'm' : '1' }-${destEntityName}:${ backRef.type === 'hasMany' ? 'n' : '1' } by ${connEntityName}`;
                        let tag2 = `${destEntityName}:${ backRef.type === 'hasMany' ? 'm' : '1' }-${entity.name}:${ assoc.type === 'hasMany' ? 'n' : '1' } by ${connEntityName}`;

                        if (assoc.srcField) {
                            tag1 += ' ' + assoc.srcField;
                        }

                        if (backRef.srcField) {
                            tag2 += ' ' + backRef.srcField;
                        }

                        if (this._processedRef.has(tag1) || this._processedRef.has(tag2)) {
                            //already processed, skip
                            return;
                        }           
                        
                        let connectedByParts2 = backRef.connectedBy.split('.');
                        let connectedByField2 = (connectedByParts2.length > 1 && connectedByParts2[1]) || destEntity.name;

                        if (connectedByField === connectedByField2) {
                            throw new Error('Cannot use the same "connectedBy" field in a relation entity.');
                        }

                        let connEntity = schema.entities[connEntityName];
                        if (!connEntity) {
                            connEntity = this._addRelationEntity(schema, connEntityName, connectedByField, connectedByField2);
                        } 
                            
                        this._updateRelationEntity(connEntity, entity, destEntity, connectedByField, connectedByField2);

                        let localFieldName = assoc.srcField || pluralize(destEntityName);     

                        entity.addAssociation(
                            localFieldName,
                            {
                                entity: connEntityName,
                                key: connEntity.key,
                                on: this._translateJoinCondition({ ...assocNames, [connEntityName]: localFieldName }, entity.key, localFieldName,
                                    assoc.connectedWith ? {
                                        by: connectedByField,
                                        with: assoc.connectedWith
                                    } : connectedByField
                                ),
                                field: connectedByField,
                                ...(assoc.optional ? { optional: assoc.optional } : {}),                            
                                ...(assoc.type === 'hasMany' ? { list: true } : {}),
                                assoc: connectedByField2
                            }
                        );

                        let remoteFieldName = backRef.srcField || pluralize(entity.name);    

                        destEntity.addAssociation(
                            remoteFieldName, 
                            { 
                                entity: connEntityName,
                                key: connEntity.key,
                                on: this._translateJoinCondition({ ...assocNames, [connEntityName]: remoteFieldName }, destEntity.key, remoteFieldName,
                                    backRef.connectedWith ? {
                                        by: connectedByField2,
                                        with: backRef.connectedWith
                                    } : connectedByField
                                ),
                                field: connectedByField2,
                                ...(backRef.optional ? { optional: backRef.optional } : {}),                            
                                ...(backRef.type === 'hasMany' ? { list: true } : {}),
                                assoc: connectedByField
                            }
                        );

                        this._processedRef.add(tag1);
                        this._processedRef.add(tag2);                        
                    } else if (backRef.type === 'belongsTo') {
                        if (assoc.connectedBy) {
                            throw new Error('todo: belongsTo connectedBy. entity: ' + entity.name);
                        } else {
                            //leave it to the referenced entity  
                            let anchor = assoc.srcField || (assoc.type === 'hasMany' ? pluralize(destEntityName) : destEntityName);                            
                            let remoteField = backRef.srcField || entity.name;
                            
                            entity.addAssociation(
                                anchor,                                 
                                { 
                                    entity: destEntityName,
                                    key: destEntity.key,  
                                    on: this._translateJoinCondition(
                                        { ...assocNames, [destEntityName]: anchor }, 
                                        entity.key, 
                                        anchor,
                                        remoteField
                                    ), 
                                    ...(typeof remoteField === 'string' ? { field: remoteField } : {}) ,
                                    ...(assoc.optional ? { optional: assoc.optional } : {}),                            
                                    ...(assoc.type === 'hasMany' ? { list: true } : {})
                                }
                            );
                            
                        }
                    } else {
                        throw new Error('Unexpected path. Entity: ' + entity.name + ', association: ' + JSON.stringify(assoc, null, 2));                    
                    } 
                } else {  
                    // semi association 

                    let connectedByParts = assoc.connectedBy ? assoc.connectedBy.split('.') : [ OolUtils.prefixNaming(entity.name, destEntityName) ];
                    assert: connectedByParts.length <= 2;

                    let connectedByField = (connectedByParts.length > 1 && connectedByParts[1]) || entity.name;
                    let connEntityName = OolUtils.entityNaming(connectedByParts[0]);

                    assert: connEntityName;

                    let tag1 = `${entity.name}:${ assoc.type === 'hasMany' ? 'm' : '1' }-${destEntityName}:* by ${connEntityName}`;

                    if (assoc.srcField) {
                        tag1 += ' ' + assoc.srcField;
                    }                    

                    assert: !this._processedRef.has(tag1);                    
                    
                    let connectedByField2 = destEntityName;

                    if (connectedByField === connectedByField2) {
                        throw new Error('Cannot use the same "connectedBy" field in a relation entity. Detail: ' + JSON.stringify({
                            src: entity.name,
                            dest: destEntityName,
                            srcField: assoc.srcField,
                            connectedBy: connectedByField
                        }));
                    }

                    let connEntity = schema.entities[connEntityName];
                    if (!connEntity) {
                        connEntity = this._addRelationEntity(schema, connEntityName, connectedByField, connectedByField2);
                    } 
                        
                    this._updateRelationEntity(connEntity, entity, destEntity, connectedByField, connectedByField2);

                    let localFieldName = assoc.srcField || pluralize(destEntityName);

                    entity.addAssociation(
                        localFieldName,
                        {
                            entity: connEntityName,
                            key: connEntity.key,
                            on: this._translateJoinCondition({ ...assocNames, [connEntityName]: localFieldName }, entity.key, localFieldName,
                                assoc.connectedWith ? {
                                    by: connectedByField,
                                    with: assoc.connectedWith
                                } : connectedByField
                            ) ,
                            field: connectedByField,
                            ...(assoc.optional ? { optional: assoc.optional } : {}),                            
                            ...(assoc.type === 'hasMany' ? { list: true } : {}),
                            assoc: connectedByField2
                        }
                    );

                    this._processedRef.add(tag1);            
                }

            break;

            case 'refersTo':
            case 'belongsTo':
                let localField = assoc.srcField || destEntityName;
                let fieldProps = { ..._.omit(destKeyField, ['optional', 'default']), ..._.pick(assoc, ['optional', 'default']) };

                entity.addAssocField(localField, destEntity, fieldProps);
                entity.addAssociation(
                    localField,                      
                    { 
                        entity: destEntityName, 
                        key: destEntity.key,
                        on: { [localField]: this._toColumnReference(localField + '.' + destEntity.key) }
                    }
                );

                /*
                if (assoc.type === 'belongsTo') {
                    let backRef = destEntity.getReferenceTo(
                        entity.name, 
                        { 
                            'remoteField': (remoteField) => {
                                let remoteFields = this._getAllRelatedFields(remoteField);

                                return _.isNil(remoteFields) || (Array.isArray(remoteFields) ? remoteFields.indexOf(localField) > -1 : remoteFields === localField);
                            }
                        },  // includes
                        { types: [ 'refersTo', 'belongsTo' ], association: assoc } // excludes
                    );

                    if (!backRef) {
                        destEntity.addAssociation(
                            pluralize(entity.name),                              
                            { 
                                entity: entity.name, 
                                key: entity.key,
                                on: { [destEntity.key]: localField },
                                list: true, 
                                optional: true
                            }
                        );
                    } 
                }*/

                this._addReference(entity.name, localField, destEntityName, destKeyField.name);
            break;
        }
    }

    _oolConditionToQueryCondition(context, oolCon) {
        assert: oolCon.oolType;

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
                    [left]: { '$eq': right }
                }; 
            }
        }

        throw new Error('Unknown syntax: ' + JSON.stringify(oolCon));
    }

    _translateReference(context, ref, asKey) {
        let [ base, ...other ] = ref.split('.');

        let translated = context[base];
        if (!translated) {
            console.log(context);
            throw new Error(`Referenced object "${ref}" not found in context.`);
        }

        let refName = [ translated, ...other ].join('.');

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
            this._addReference(left, leftField.by, right. rightField);
            return;
        }

        assert: typeof leftField === 'string';

        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            refs4LeftEntity = [];
            this._references[left] = refs4LeftEntity;
        } else {
            let found = _.find(refs4LeftEntity,
                item => (item.leftField === leftField && item.right === right && item.rightField === rightField)
            );
    
            if (found) return;
        }        

        refs4LeftEntity.push({leftField, right, rightField});
    }

    _getReferenceOfField(left, leftField) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            return undefined;
        }

        let reference = _.find(refs4LeftEntity,
            item => (item.leftField === leftField)
        );

        if (!reference) {
            return undefined;
        }

        return reference;
    }

    _hasReferenceOfField(left, leftField) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) return false;

        return (undefined !== _.find(refs4LeftEntity,
            item => (item.leftField === leftField)
        ));
    }

    _getReferenceBetween(left, right) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) {
            return undefined;
        }

        let reference = _.find(refs4LeftEntity,
            item => (item.right === right)
        );

        if (!reference) {
            return undefined;
        }

        return reference;
    }

    _hasReferenceBetween(left, right) {
        let refs4LeftEntity = this._references[left];
        if (!refs4LeftEntity) return false;

        return (undefined !== _.find(refs4LeftEntity,
            item => (item.right === right)
        ));
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
            features: [ 'createTimestamp' ],
            key: [ entity1RefField, entity2RefField ]
        };

        let entity = new Entity(this.linker, relationEntityName, schema.oolModule, entityInfo);
        entity.link();

        schema.addEntity(entity);

        return entity;
    }

    _updateRelationEntity(relationEntity, entity1, entity2, connectedByField, connectedByField2) {
        let relationEntityName = relationEntity.name;

        if (relationEntity.info.associations) {               
            let hasRefToEntity1 = false, hasRefToEntity2 = false;            

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

        relationEntity.addAssociation(
            connectedByField, 
            { entity: entity1.name }
        );
        relationEntity.addAssociation(
            connectedByField2, 
            { entity: entity2.name }
        );

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
                
                let { entityNode, entity, field } = OolUtils.parseReferenceInDocument(schema, doc, ool.name);

                return entityNode.alias + '.' + MySQLModeler.quoteIdentifier(field.name);
            
            default:
                throw new Error('oolToSql to be implemented.'); 
        }
    }

    static _orderByToSql(schema, doc, ool) {
        return MySQLModeler.oolToSql(schema, doc, { oolType: 'ObjectReference', name: ool.field }) + (ool.ascend ? '' : ' DESC');
    }

    _viewDocumentToSQL(modelingSchema, view) {
        let sql = '  ';
        //console.log('view: ' + view.name);
        let doc = _.cloneDeep(view.getDocumentHierarchy(modelingSchema));
        //console.dir(doc, {depth: 8, colors: true});

        //let aliasMapping = {};
        let [ colList, alias, joins ] = this._buildViewSelect(modelingSchema, doc, 0);
        
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
                let [ subColList, subAlias, subJoins, startIndex2 ] = this._buildViewSelect(schema, doc, startIndex);
                startIndex = startIndex2;
                colList = colList.concat(subColList);
                
                joins.push('LEFT JOIN ' + MySQLModeler.quoteIdentifier(doc.entity) + ' AS ' + subAlias
                    + ' ON ' + alias + '.' + MySQLModeler.quoteIdentifier(fieldName) + ' = ' +
                    subAlias + '.' + MySQLModeler.quoteIdentifier(doc.linkWithField));

                if (!_.isEmpty(subJoins)) {
                    joins = joins.concat(subJoins);
                }
            });
        }

        return [ colList, alias, joins, startIndex ];
    }

    _createTableStatement(entityName, entity) {
        let sql = 'CREATE TABLE IF NOT EXISTS `' + entityName + '` (\n';

        //column definitions
        _.each(entity.fields, (field, name) => {
            sql += '  ' + MySQLModeler.quoteIdentifier(name) + ' ' + MySQLModeler.columnDefinition(field) + ',\n';
        });

        //primary key
        sql += '  PRIMARY KEY (' + MySQLModeler.quoteListOrValue(entity.key) + '),\n';

        //other keys
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
            sql = sql.substr(0, sql.length-2);
        }

        sql += '\n)';

        //table options
        let extraProps = {};
        this._events.emit('setTableOptions:' + entityName, extraProps);
        let props = Object.assign({}, this._dbOptions.table, extraProps);

        sql = _.reduce(props, function(result, value, key) {
            return result + ' ' + key + '=' + value;
        }, sql);

        sql += ';\n';

        return sql;
    }
    
    _addForeignKeyStatement(entityName, relation) {
        let sql = 'ALTER TABLE `' + entityName +
            '` ADD FOREIGN KEY (`' + relation.leftField + '`) ' +
            'REFERENCES `' + relation.right + '` (`' + relation.rightField + '`) ';

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
        return _.isArray(obj) ?
            obj.map(v => MySQLModeler.quoteIdentifier(v)).join(', ') :
            MySQLModeler.quoteIdentifier(obj);
    }

    static complianceCheck(entity) {
        let result = { errors: [], warnings: [] };

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
            col =  MySQLModeler.floatColumnDefinition(field);
                break;

            case 'text':
            col =  MySQLModeler.textColumnDefinition(field);
                break;

            case 'boolean':
            col =  MySQLModeler.boolColumnDefinition(field);
                break;

            case 'binary':
            col =  MySQLModeler.binaryColumnDefinition(field);
                break;

            case 'datetime':
            col =  MySQLModeler.datetimeColumnDefinition(field);
                break;

            case 'object':
            col =  MySQLModeler.textColumnDefinition(field);
                break;            

            case 'enum':
            col =  MySQLModeler.enumColumnDefinition(field);
                break;

            case 'array':
            col =  MySQLModeler.textColumnDefinition(field);
                break;

            default:
                throw new Error('Unsupported type "' + field.type + '".');
        }

        let { sql, type } = col;        

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

            sql += `(${info.digits})`
        } else {
            type = sql = 'INT';
        }

        if (info.unsigned) {
            sql += ' UNSIGNED';
        }

        return { sql, type };
    }

    static floatColumnDefinition(info) {
        let sql = '', type;

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
                sql += ', ' +info.decimalDigits;
            }
            sql += ')';

        } else {
            if ('decimalDigits' in info) {
                if (info.decimalDigits > 23) {
                    sql += '(53, ' +info.decimalDigits + ')';
                } else  {
                    sql += '(23, ' +info.decimalDigits + ')';
                }
            }
        }

        return { sql, type };
    }

    static textColumnDefinition(info) {
        let sql = '', type;

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

        return { sql, type };
    }

    static binaryColumnDefinition(info) {
        let sql = '', type;

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

        return { sql, type };
    }

    static boolColumnDefinition() {
        return { sql: 'TINYINT(1)', type: 'TINYINT' };
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

        return { sql, type: sql };
    }

    static enumColumnDefinition(info) {
        return { sql: 'ENUM(' + _.map(info.values, (v) => MySQLModeler.quoteString(v)).join(', ') + ')', type: 'ENUM' };
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

                //todo: other types

            } else if (!info.hasOwnProperty('auto')) {
                if (UNSUPPORTED_DEFAULT_VALUE.has(type)) {
                    return '';
                }

                if (info.type === 'boolean' || info.type === 'integer' || info.type === 'number') {
                    sql += ' DEFAULT 0';
                } else if (info.type === 'datetime') {
                    sql += ' DEFAULT CURRENT_TIMESTAMP';
                } else if (info.type === 'enum') {
                    sql += ' DEFAULT ' +  quote(info.values[0]);
                }  else {
                    sql += ' DEFAULT ""';
                } 

                info.createByDb = true;
            }
        }        
    
        /*
        if (info.hasOwnProperty('default') && typeof info.default === 'object' && info.default.oolType === 'SymbolToken') {
            let defaultValue = info.default;
            let defaultByDb = false;

            switch (defaultValue.name) {
                case 'now':
                sql += ' DEFAULT NOW'
                break;
            }

            if (defaultByDb) {
                delete info.default;
                info.defaultByDb = true;
            }

            if (info.type === 'bool') {
                if (_.isString(defaultValue)) {
                    sql += ' DEFAULT ' + (S(defaultValue).toBoolean() ? '1' : '0');
                } else {
                    sql += ' DEFAULT ' + (defaultValue ? '1' : '0');
                }
            } else if (info.type === 'int') {
                if (_.isInteger(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + parseInt(defaultValue).toString();
                }
            } else if (info.type === 'text') {
                sql += ' DEFAULT ' + Util.quote(defaultValue);
            } else if (info.type === 'float') {
                if (_.isNumber(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + parseFloat(defaultValue).toString();
                }
            } else if (info.type === 'binary') {
                sql += ' DEFAULT ' + Util.bin2Hex(defaultValue);
            } else if (info.type === 'datetime') {
                if (_.isInteger(defaultValue)) {
                    sql += ' DEFAULT ' + defaultValue.toString();
                } else {
                    sql += ' DEFAULT ' + Util.quote(defaultValue);
                }
            } else if (info.type === 'json') {
                if (typeof defaultValue === 'string') {
                    sql += ' DEFAULT ' + Util.quote(defaultValue);
                } else {
                    sql += ' DEFAULT ' + Util.quote(JSON.stringify(defaultValue));
                }
            } else if (info.type === 'xml' || info.type === 'enum' || info.type === 'csv') {
                sql += ' DEFAULT ' + Util.quote(defaultValue);
            } else {
                throw new Error('Unexpected path');
            }            
        }    
        */    
        
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
    };
}

module.exports = MySQLModeler;