"use strict";

const Util = require('rk-utils');
const { _, setValueByPath, eachAsync_ } = Util;

const { DateTime } = require('luxon');
const EntityModel = require('../../EntityModel');
const { OolongUsageError, BusinessError } = require('../../Errors');

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
     * @param {object} dataRecord 
     */
    static serialize(dataRecord) {
        _.forOwn(dataRecord, (value, fieldName) => {
            let fieldMeta = this.meta.fields[fieldName];
            
            if (fieldMeta.type === 'datetime') {
                if (typeof value === 'object' && value.oolType === 'SymbolToken') {
                    if (value.name === 'now') {
                        dataRecord[fieldName] = this.db.connector.raw('NOW()');
                    }
                }

                if (value instanceof DateTime) {
                    dataRecord[fieldName] = value.toISO({ includeOffset: false });
                }
            } else if (fieldMeta.type === 'boolean') {
                dataRecord[fieldName] = dataRecord[fieldName] ? 1 : 0;
            }
        });
    }

    static async create_(...args) {
        try {            
            return await super.create_(...args);
        } catch (error) {
            let errorCode = error.code;

            if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
                throw new BusinessError('The new entity is referencing to an unexisting entity.');
            } else if (errorCode === 'ER_DUP_ENTRY') {
                throw new BusinessError(error.message + ` while creating a new "${this.meta.name}".`);
            }

            throw error;
        }
    }

    static async update_(...args) {
        try {            
            return await super.update_(...args);
        } catch (error) {
            let errorCode = error.code;

            if (errorCode === 'ER_NO_REFERENCED_ROW_2') {
                throw new BusinessError('The new entity is referencing to an unexisting entity.');
            } else if (errorCode === 'ER_DUP_ENTRY') {
                throw new BusinessError(error.message);
            }

            throw error;
        }
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
            context.latest = await this.findOne_({ $query: condition, $unboxing: true}, context.connOptions);
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
            context.latest = await this.findOne_({ $query: context.updateOptions.$query, $unboxing: true}, context.connOptions);
        }

        return true;
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
            
            context.existing = await this.findOne_({ $query: context.deleteOptions.$query, $unboxing: true}, context.connOptions);
        }
    }

    /*      entity: <remote entity>
     *      joinType: 'LEFT JOIN|INNER JOIN|FULL OUTER JOIN'
     *      anchor: 'local property to place the remote entity'
     *      localField: <local field to join>
     *      remoteField: <remote field to join>
     *      subAssociations: { ... }  */
    static _prepareAssociations(associations) {   
        associations = associations.concat().sort();
        let cache = {}, hierarchy = [];
        
        associations.forEach(assoc => {
            let [ remoteEntity, base, anchor, assocInfo ] = this._getRelatedEntity(assoc, cache);
            assert: assocInfo;            

            let remoteEntityName = remoteEntity.meta.name;

            let detail = {
                entity: remoteEntityName,
                keyField: remoteEntity.meta.keyField,
                joinType: 'LEFT JOIN',
                anchor
            };

            let toCache = {
                entity: remoteEntity,
                detail
            };

            if (assocInfo.isList) {
                detail.isList = true;
            }

            if (assocInfo.optional) {
                detail.optional = true;
            }
            
            if (assocInfo.connectedBy) {
                detail.localField = cache[base] ? cache[base].entity.meta.keyField : this.meta.keyField;
                detail.remoteField = assocInfo.remoteField || this.meta.name;

                detail.entity = assocInfo.connectedBy;
                detail.keyField = this.db.model(assocInfo.connectedBy).meta.keyField;

                if (assocInfo.connectedWith) {
                    detail.connectedWith = assocInfo.connectedWith;
                }                

                toCache.detail = {
                    entity: remoteEntityName,
                    keyField: remoteEntity.meta.keyField,
                    joinType: 'LEFT JOIN',
                    anchor: assocInfo.refersToField,
                    localField: assocInfo.refersToField,
                    remoteField: remoteEntity.meta.keyField
                };

                detail.subAssociations = [
                    toCache.detail
                ];
            } else if (assocInfo.isList) {
                detail.localField = cache[base] ? cache[base].entity.meta.keyField : this.meta.keyField;
                detail.remoteField = assocInfo.remoteField || this.meta.name;
            } else {
                detail.localField = anchor;
                detail.remoteField = remoteEntity.meta.keyField;
            }

            if (cache[base]) {
                if (cache[base].detail.subAssociations) {
                    cache[base].detail.subAssociations.push(detail);
                } else {
                    cache[base].detail.subAssociations = [ detail ];
                }
            } else {
                hierarchy.push(detail);
            }

            cache[assoc] = toCache;
        });

        return hierarchy;
    }

    static _getRelatedEntity(assocPath, cache) {        
        let parts = assocPath.split('.');        
        let base = parts.slice(0, -1).join('.');        

        let cacheNode = cache[base];
        if (cacheNode) {
            let last = parts.pop();
            let assocInfo = cacheNode.entity.meta.associations[last];
            if (!assocInfo) {
                throw new BusinessError(`Unknown association of "${this.meta.name}" entity: ${assocPath}`);
            }

            return [ this.db.model(assocInfo.entity), base, last, assocInfo ];
        }

        let entity = this, current, currentAssocInfo;

        while (parts.length > 0) {
            current = parts.shift();
            currentAssocInfo = entity.meta.associations[current];
            if (!currentAssocInfo) {
                throw new BusinessError(`Unknown association of "${this.meta.name}" entity: ${assocPath}`);
            }

            entity = this.db.model(currentAssocInfo.entity);
        }

        return [ entity, base, current, currentAssocInfo ];
    }

    static _mapRecordsToObjects([rows, columns, aliasMap], hierarchy) {
        let mainIndex = {};

        function mergeRecord(existingRow, rowObject, associations) {            
            _.each(associations, ({ keyField, anchor, isList, subAssociations }) => {                
                let key = ':' + anchor;                
                let subObj = rowObject[key]
                let subIndexes = existingRow.subIndexes[key];
                
                let rowKey = subObj[keyField];
                if (_.isNil(rowKey)) return;

                let existingSubRow = subIndexes && subIndexes[rowKey];
                if (existingSubRow) {
                    if (subAssociations) {
                        mergeRecord(existingSubRow, subObj, subAssociations);
                    }
                } else {       
                    assert: isList;
                                     
                    if (existingRow.rowObject[key]) {
                        existingRow.rowObject[key].push(subObj);
                    } else {
                        existingRow.rowObject[key] = [ subObj ];
                    }
                    
                    let subIndex = { 
                        rowObject: subObj                        
                    };

                    if (subAssociations) {
                        subIndex.subIndexes = buildSubIndexes(subObj, subAssociations)
                    } 

                    subIndexes[rowKey] = subIndex;                
                }                
            });
        }

        function buildSubIndexes(rowObject, associations) {
            return associations.reduce((indexes, { keyField, anchor, isList, subAssociations }) => {
                let key = ':'+anchor;
                let subObject = rowObject[key];                                  
                let subIndex = { 
                    rowObject: subObject 
                };

                if (isList) {                    
                    if (_.isNil(subObject[keyField])) {
                        rowObject[key] = [];
                        subObject = null;
                    } else {
                        rowObject[key] = [ subObject ];
                    }
                } else if (_.isNil(subObject[keyField])) {
                    subObject = rowObject[key] = null;
                }

                if (subObject) {
                    if (subAssociations) {
                        subIndex.subIndexes = buildSubIndexes(subObject, subAssociations);
                    }

                    indexes[key] = {
                        [subObject[keyField]]: subIndex
                    };
                }

                return indexes;
            }, {});       
        }

        let arrayOfObjs = [];

        rows.forEach(row => {
            let rowObject = {}; // hash-style data row
            let tableCache = {}; // from alias to child prop of rowObject

            row.reduce((result, value, i) => {
                let col = columns[i];
                if (col.table === 'A') {
                    result[col.name] = value;
                } else {    
                    let bucket = tableCache[col.table];                    
                    if (bucket) {
                        bucket[col.name] = value;                                
                    } else {
                        let nodePath = aliasMap[col.table];
                        let subObject = { [col.name]: value };
                        tableCache[col.table] = subObject;
                        setValueByPath(result, nodePath, subObject);
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
                throw new BusinessError(`Unknown association "${anchor}" of entity "${this.meta.name}".`);
            }

            if (!assocMeta.connectedBy) {
                throw new BusinessError(`Unsupported association type, "${anchor}" of entity "${this.meta.name}". Currently only supports many-to-many association.`);
            }

            let assocModel = this.db.model(assocMeta.connectedBy);
            console.log(data);

            return assocModel.create_({ ...data, [assocMeta.remoteField]: keyValue }, context.createOptions, context.connOptions);  
        });
    }
}

module.exports = MySQLEntityModel;