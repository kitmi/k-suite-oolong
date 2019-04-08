"use strict";

const Util = require('rk-utils');
const { _, setValueByPath, eachAsync_ } = Util;

const { DateTime } = require('luxon');
const EntityModel = require('../../EntityModel');
const { OolongUsageError, BusinessError } = require('../../Errors');
const Types = require('../../types');

/**
 * MySQL entity model class.
 */
class MySQLEntityModel extends EntityModel {    
    static get hasAutoIncrement() {
        let autoId = this.meta.features.autoId;
        return autoId && this.meta.fields[autoId.field].autoIncrementId;    
    }

    /**
     * Serialize value into database acceptable format.
     * @param {object} name - Name of the symbol token 
     */
    static _translateSymbolToken(name) {
        if (name === 'now') {
            return this.db.connector.raw('NOW()');
        } 
        
        throw new Error('not support');
    }

    static _serialize(value) {
        if (typeof value === 'boolean') return value ? 1 : 0;

        if (value instanceof DateTime) {
            return value.toISO({ includeOffset: false });
        }

        return value;
    }    

    static _serializeByType(value, info) {
        if (info.type === 'boolean') {
            return value ? 1 : 0;
        }

        if (info.type === 'datetime' && value instanceof DateTime) {
            return value.toISO({ includeOffset: false });
        }

        if (info.type === 'array' && Array.isArray(value)) {
            if (info.csv) {
                return Types.ARRAY.toCsv(value);
            } else {
                return Types.ARRAY.serialize(value);
            }
        }

        if (info.type === 'object') {
            return Types.OBJECT.serialize(value);
        }

        return value;
    }    

    static async create_(...args) {
        try {            
            return await super.create_(...args);
        } catch (error) {
            let errorCode = error.code;

            if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
                throw new BusinessError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
            } else if (errorCode === 'ER_DUP_ENTRY') {
                throw new BusinessError(error.message + ` while creating a new "${this.meta.name}".`);
            }

            throw error;
        }
    }

    static async updateOne_(...args) {
        try {            
            return await super.updateOne_(...args);
        } catch (error) {
            let errorCode = error.code;

            if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
                throw new BusinessError('The new entity is referencing to an unexisting entity. Detail: ' + error.message);
            } else if (errorCode === 'ER_DUP_ENTRY') {
                throw new BusinessError(error.message + ` while updating an existing "${this.meta.name}".`);
            }

            throw error;
        }
    }

    static async _doReplaceOne_(context) {
        if (!context.connOptions || !context.connOptions.connection) {
            context.connOptions || (context.connOptions = {});

            context.connOptions.connection = await this.db.connector.beginTransaction_();                           
        }
        
        let entity = await this.findOne_({ $query: context.updateOptions.$query }, context.connOptions);

        if (entity) {
            return this.updateOne_(context.raw, { ...context.updateOptions, $query: { [this.meta.keyField]: this.valueOfKey(entity) } }, context.connOptions);
        } else {
            return this.create_(context.raw, { $retrieveCreated: context.updateOptions.$retrieveUpdated }, context.connOptions);
        }
    }

    static async beforeCreate_(context) {
        return true;
    }
    
    /**
     * Post create processing.
     * @param {*} context 
     * @property {object} [context.createOptions] - Create options     
     * @property {bool} [createOptions.$retrieveCreated] - Retrieve the newly created record from db. 
     */
    static async afterCreate_(context) {
        if (this.hasAutoIncrement) {
            let { insertId } = context.result;
            context.latest[this.meta.features.autoId.field] = insertId;
        }

        if (context.createOptions.$retrieveCreated) {
            let condition = this.getUniqueKeyValuePairsFrom(context.latest);
            let retrieveOptions = _.isPlainObject(context.createOptions.$retrieveCreated) ? context.createOptions.$retrieveCreated : {};
            context.latest = await this.findOne_({ ...retrieveOptions, $query: condition }, context.connOptions);
        }

        return true;
    }

    /**
     * Post update processing.
     * @param {*} context 
     * @param {object} [updateOptions] - Update options     
     * @property {bool} [updateOptions.$retrieveUpdated] - Retrieve the newly updated record from db. 
     */
    static async afterUpdate_(context) {
        if (context.updateOptions.$retrieveUpdated) {    
            let condition = { $query: context.updateOptions.$query };
            if (context.updateOptions.$byPassEnsureUnique) {
                condition.$byPassEnsureUnique = context.updateOptions.$byPassEnsureUnique;
            }

            let retrieveOptions = {};
            
            if (_.isPlainObject(context.updateOptions.$retrieveUpdated)) {
                retrieveOptions = context.updateOptions.$retrieveUpdated;
            } else if (context.updateOptions.$relationships) {
                retrieveOptions.$relationships = context.updateOptions.$relationships;
            }
            
            context.latest = await this.findOne_({ ...retrieveOptions, ...condition }, context.connOptions);
        }

        return true;
    }

    /**
     * Post update processing.
     * @param {*} context 
     * @param {object} [updateOptions] - Update options     
     * @property {bool} [updateOptions.$retrieveUpdated] - Retrieve the newly updated record from db. 
     */
    static async afterUpdateMany_(context) {
        if (context.updateOptions.$retrieveUpdated) {    
            let retrieveOptions = {};

            if (_.isPlainObject(context.updateOptions.$retrieveUpdated)) {
                retrieveOptions = context.updateOptions.$retrieveUpdated;
            } else if (context.updateOptions.$relationships) {
                retrieveOptions.$relationships = context.updateOptions.$relationships;
            }
            
            context.latest = await this.findAll_({ ...retrieveOptions, $query: context.updateOptions.$query }, context.connOptions);
        }

        return true;
    }

    /**
     * Post delete processing.
     * @param {*} context      
     */
    static async afterDelete_(context) {
        return true;
    }

    /**
     * Post delete processing.
     * @param {*} context      
     */
    static async afterDeleteMany_(context) {
        return true;
    }

    static async afterFindAll_(context, records) {
        if (context.findOptions.$toDictionary) {
            let keyField = this.meta.keyField;
            
            if (typeof context.findOptions.$toDictionary === 'string') { 
                keyField = context.findOptions.$toDictionary; 

                if (!(keyField in this.meta.fields)) {
                    throw new OolongUsageError(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`);
                }
            }

            return records.reduce((table, v) => {
                table[v[keyField]] = v;
                return table;
            }, {});
        } 

        return records;
    }

    /**
     * Before deleting an entity.
     * @param {*} context 
     * @property {object} [context.deleteOptions] - Delete options     
     * @property {bool} [deleteOptions.$retrieveDeleted] - Retrieve the recently deleted record from db. 
     */
    static async beforeDelete_(context) {
        if (context.deleteOptions.$retrieveDeleted) {            
            if (!context.connOptions || !context.connOptions.connection) {
                context.connOptions || (context.connOptions = {});

                context.connOptions.connection = await this.db.connector.beginTransaction_();                           
            }

            let retrieveOptions = _.isPlainObject(context.deleteOptions.$retrieveDeleted) ? 
                context.deleteOptions.$retrieveDeleted :
                {};
            
            context.existing = await this.findOne_({ ...retrieveOptions, $query: context.deleteOptions.$query }, context.connOptions);
        }
    }

    static async beforeDeleteMany_(context) {
        if (context.deleteOptions.$retrieveDeleted) {            
            if (!context.connOptions || !context.connOptions.connection) {
                context.connOptions || (context.connOptions = {});

                context.connOptions.connection = await this.db.connector.beginTransaction_();                           
            }

            let retrieveOptions = _.isPlainObject(context.deleteOptions.$retrieveDeleted) ? 
                context.deleteOptions.$retrieveDeleted :
                {};
            
            context.existing = await this.findAll_({ ...retrieveOptions, $query: context.deleteOptions.$query }, context.connOptions);
        }
    }

    /**
     * 
     * @param {*} findOptions 
     */
    static _prepareAssociations(findOptions) { 
        let associations = _.uniq(findOptions.$association).sort();        
        let assocTable = {}, counter = 0, cache = {};       

        associations.forEach(assoc => {
            if (_.isPlainObject(assoc)) {
                assoc = this._translateSchemaNameToDb(assoc);

                let alias = assoc.alias;
                if (!assoc.alias) {
                    alias = ':join' + ++counter;
                }

                assocTable[alias] = { 
                    entity: assoc.entity, 
                    joinType: assoc.type, 
                    output: assoc.output,
                    key: assoc.key,
                    alias,
                    on: assoc.on,
                    ...(assoc.dataset ? this.db.connector.buildQuery(
                            assoc.entity, 
                            this._prepareQueries({ ...assoc.dataset, $variables: findOptions.$variables })
                        ) : {})                       
                };
            } else {
                this._loadAssocIntoTable(assocTable, cache, assoc);
            }            
        });        

        return assocTable;
    }

    /**
     * 
     * @param {*} assocTable - Hierarchy with subAssocs
     * @param {*} cache - Dotted path as key
     * @param {*} assoc - Dotted path
     */
    static _loadAssocIntoTable(assocTable, cache, assoc) {
        if (cache[assoc]) return cache[assoc];

        let lastPos = assoc.lastIndexOf('.');        
        let result;  

        if (lastPos === -1) {             
            let assocInfo = { ...this.meta.associations[assoc] };   
            if (_.isEmpty(assocInfo)) {
                throw new BusinessError(`Entity "${this.meta.name}" does not have the association "${assoc}".`)
            }
            
            result = cache[assoc] = assocTable[assoc] = { ...this._translateSchemaNameToDb(assocInfo) };
        } else {
            let base = assoc.substr(0, lastPos);
            let last = assoc.substr(lastPos+1);         
                
            let baseNode = cache[base];
            if (!baseNode) {                
                baseNode = this._loadAssocIntoTable(assocTable, cache, base);                                                
            }            

            let entity = this.db.model(baseNode.entity);
            let assocInfo ={ ...entity.meta.associations[last] };
            if (_.isEmpty(assocInfo)) {
                throw new BusinessError(`Entity "${entity.meta.name}" does not have the association "${assoc}".`);
            }

            result = { ...this._translateSchemaNameToDb(assocInfo) };

            if (!baseNode.subAssocs) {
                baseNode.subAssocs = {};
            } 

            cache[assoc] = baseNode.subAssocs[last] = result;
        }      

        if (result.assoc) {
            this._loadAssocIntoTable(assocTable, cache, assoc + '.' + result.assoc);
        }

        return result;
    }

    static _translateSchemaNameToDb(assoc) {
        if (assoc.entity.indexOf('.') > 0) {
            let [ schemaName, entityName ] = assoc.entity.split('.', 2);

            let app = this.db.app;
            if (!app) {
                throw new OolongUsageError('Cross db association requires the db object have access to other db object.');
            }

            let refDb = app.db(schemaName);
            if (!refDb) {                
                throw new OolongUsageError(`The referenced schema "${schemaName}" does not have db model in the same application.`);
            }

            assoc.entity = refDb.connector.database + '.' + entityName;

            if (!assoc.key) {
                let model = refDb.model(entityName);
                if (!model) {
                    throw new OolongUsageError(`Failed load the entity model "${schemaName}.${entityName}".`);
                }

                assoc.key = model.meta.keyField;
            }
        } else if (!assoc.key) {
            assoc.key = this.db.model(assoc.entity).meta.keyField;    
        }

        return assoc;
    }

    static _mapRecordsToObjects([rows, columns, aliasMap], hierarchy) {
        let mainIndex = {};        

        function mergeRecord(existingRow, rowObject, associations) {            
            _.each(associations, ({ sql, key, list, subAssocs }, anchor) => { 
                if (sql) return;                                 

                let objKey = ':' + anchor;                
                let subObj = rowObject[objKey]
                let subIndexes = existingRow.subIndexes[objKey];
                
                // joined an empty record
                let rowKey = subObj[key];
                if (_.isNil(rowKey)) return;

                let existingSubRow = subIndexes && subIndexes[rowKey];
                if (existingSubRow) {
                    if (subAssocs) {
                        mergeRecord(existingSubRow, subObj, subAssocs);
                    }
                } else {       
                    assert: list;
                                     
                    if (existingRow.rowObject[objKey]) {
                        existingRow.rowObject[objKey].push(subObj);
                    } else {
                        existingRow.rowObject[objKey] = [ subObj ];
                    }
                    
                    let subIndex = { 
                        rowObject: subObj                        
                    };

                    if (subAssocs) {
                        subIndex.subIndexes = buildSubIndexes(subObj, subAssocs)
                    }    

                    subIndexes[rowKey] = subIndex;                
                }                
            });
        }

        function buildSubIndexes(rowObject, associations) {
            let indexes = {};

            _.each(associations, ({ sql, key, list, subAssocs }, anchor) => {
                if (sql) {
                    return;
                }

                assert: key;

                let objKey = ':' + anchor;
                let subObject = rowObject[objKey];                                  
                let subIndex = { 
                    rowObject: subObject 
                };

                if (list) {   
                    //many to *                 
                    if (_.isNil(subObject[key])) {
                        //subObject not exist, just filled with null by joining
                        rowObject[objKey] = [];
                        subObject = null;
                    } else {
                        rowObject[objKey] = [ subObject ];
                    }
                } else if (subObject && _.isNil(subObject[key])) {
                    subObject = rowObject[objKey] = null;
                }

                if (subObject) {
                    if (subAssocs) {
                        subIndex.subIndexes = buildSubIndexes(subObject, subAssocs);
                    }

                    indexes[objKey] = {
                        [subObject[key]]: subIndex
                    };
                }
            });  
            
            return indexes;
        }

        let arrayOfObjs = [];

        //process each row
        rows.forEach((row, i) => {
            let rowObject = {}; // hash-style data row
            let tableCache = {}; // from alias to child prop of rowObject

            row.reduce((result, value, i) => {
                let col = columns[i];
                
                if (col.table === 'A') {
                    result[col.name] = value;
                } else {    
                    let bucket = tableCache[col.table];                    
                    if (bucket) {
                        //already nested inside 
                        bucket[col.name] = value;                                
                    } else {
                        let nodePath = aliasMap[col.table];
                        if (nodePath) {
                            let subObject = { [col.name]: value };
                            tableCache[col.table] = subObject;
                            setValueByPath(result, nodePath, subObject);
                        }
                    }                        
                }

                return result;
            }, rowObject);     
            
            let rowKey = rowObject[this.meta.keyField];
            let existingRow = mainIndex[rowKey];
            if (existingRow) {
                mergeRecord(existingRow, rowObject, hierarchy);
            } else {
                arrayOfObjs.push(rowObject);
                mainIndex[rowKey] = { 
                    rowObject, 
                    subIndexes: buildSubIndexes(rowObject, hierarchy)
                };                
            }
        });

        return arrayOfObjs;
    }

    static _extractAssociations(data) {
        let raw = {}, assocs = {};
        
        _.forOwn(data, (v, k) => {
            if (k.startsWith(':')) {
                assocs[k.substr(1)] = v;
            } else {
                raw[k] = v;
            }
        });
        
        return [ raw, assocs ];        
    }

    static async _createAssocs_(context, assocs) {
        let meta = this.meta.associations;
        let keyValue = context.latest[this.meta.keyField];

        if (_.isNil(keyValue)) {
            throw new OolongUsageError('Missing required primary key field value. Entity: ' + this.meta.name);
        }

        return eachAsync_(assocs, async (data, anchor) => {
            let assocMeta = meta[anchor];
            if (!assocMeta) {
                throw new OolongUsageError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
            }                        

            let assocModel = this.db.model(assocMeta.entity);

            if (assocMeta.list) {
                data = _.castArray(data);

                return eachAsync_(data, item => assocModel.create_({ ...item, ...(assocMeta.field ? { [assocMeta.field]: keyValue } : {}) }, context.createOptions, context.connOptions));
            } else if (!_.isPlainObject(data)) {
                if (Array.isArray(data)) {
                    throw new BusinessError(`Invalid type of associated entity (${assocMeta.entity}) data triggered from "${this.meta.name}" entity. Singular value expected (${anchor}), but an array is given instead.`);
                }

                if (!assocMeta.assoc) {
                    throw new OolongUsageError(`The associated field of relation "${anchor}" does not exist in the entity meta data.`);
                }

                data = { [assocMeta.assoc]: data };
            }

            return assocModel.create_({ ...data, ...(assocMeta.field ? { [assocMeta.field]: keyValue } : {}) }, context.createOptions, context.connOptions);  
        });
    }
}

module.exports = MySQLEntityModel;