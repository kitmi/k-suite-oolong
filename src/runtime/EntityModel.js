"use strict";

const HttpCode = require('http-status-codes');
const { _, eachAsync_, getValueByPath, hasKeyByPath } = require('rk-utils');
const Errors = require('./Errors');
const Generators = require('./Generators');
const Types = require('./types');
const { DataValidationError, OolongUsageError, DsOperationError, BusinessError } = Errors;
const Features = require('./entityFeatures');
const Rules = require('../enum/Rules');

const { isNothing } = require('../utils/lang');

const NEED_OVERRIDE = 'Should be overrided by driver-specific subclass.';

function minifyAssocs(assocs) {
    let sorted = _.uniq(assocs).sort().reverse();

    let minified = _.take(sorted, 1), l = sorted.length - 1;

    for (let i = 1; i < l; i++) {
        let k = sorted[i] + '.';

        if (!_.find(minified, a => a.startsWith(k))) {
            minified.push(sorted[i]);
        }
    }

    return minified;
}

const oorTypesToBypass = new Set(['ColumnReference', 'Function', 'BinaryExpression']);

/**
 * Base entity model class.
 * @class
 */
class EntityModel {
    /**     
     * @param {Object} [rawData] - Raw data object 
     */
    constructor(rawData) {
        if (rawData) {
            //only pick those that are fields of this entity
            Object.assign(this, rawData);
        } 
    }    

    static valueOfKey(data) {
        return Array.isArray(this.meta.keyField) ? _.pick(data, this.meta.keyField) : data[this.meta.keyField];
    }

    static queryColumn(name) {
        return {
            oorType: 'ColumnReference',
            name
        }; 
    }

    static queryBinExpr(left, op, right) {
        return {
            oorType: 'BinaryExpression',
            left,
            op,
            right
        }; 
    }

    static queryFunction(name, ...args) {
        return {
            oorType: 'Function',
            name,
            args
        };
    }

    /**
     * Get field names array of a unique key from input data.
     * @param {object} data - Input data.
     */
    static getUniqueKeyFieldsFrom(data) {
        return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
    }

    /**
     * Get key-value pairs of a unique key from input data.
     * @param {object} data - Input data.
     */
    static getUniqueKeyValuePairsFrom(data) {  
        pre: typeof data === 'object';
        
        let ukFields = this.getUniqueKeyFieldsFrom(data);
        return _.pick(data, ukFields);
    }

    /**
     * Get nested object of an entity.
     * @param {*} entityObj 
     * @param {*} keyPath 
     */
    static getNestedObject(entityObj, keyPath, defaultValue) {
        let nodes = (Array.isArray(keyPath) ? keyPath : keyPath.split('.')).map(key => key[0] === ':' ? key : (':' + key));
        return getValueByPath(entityObj, nodes, defaultValue);
    }

    /**
     * Ensure context.latest be the just created entity.
     * @param {*} context 
     * @param {*} customOptions 
     */
    static ensureRetrieveCreated(context, customOptions) {
        if (!context.options.$retrieveCreated) {
            context.options.$retrieveCreated = customOptions ? customOptions : true;
        }
    }

    /**
     * Ensure context.latest be the just updated entity.
     * @param {*} context 
     * @param {*} customOptions 
     */
    static ensureRetrieveUpdated(context, customOptions) {
        if (!context.options.$retrieveUpdated) {
            context.options.$retrieveUpdated = customOptions ? customOptions : true;
        }
    }

    /**
     * Ensure context.exisintg be the just deleted entity.
     * @param {*} context 
     * @param {*} customOptions 
     */
    static ensureRetrieveDeleted(context, customOptions) {
        if (!context.options.$retrieveDeleted) {
            context.options.$retrieveDeleted = customOptions ? customOptions : true;
        }
    }

    /**
     * Ensure the upcoming operations are executed in a transaction.
     * @param {*} context 
     */
    static async ensureTransaction_(context) {
        if (!context.connOptions || !context.connOptions.connection) {                
            context.connOptions || (context.connOptions = {});

            context.connOptions.connection = await this.db.connector.beginTransaction_();                           
        } 
    }

    /**
     * Get value from context, e.g. session, query ...
     * @param {*} context 
     * @param {string} key
     * @returns {*} 
     */
    static getValueFromContext(context, key) {
        return getValueByPath(context, 'options.$variables.' + key);
    }

    /**
     * Get a pk-indexed hashtable with all undeleted data
     * {string} [key] - The key field to used by the hashtable.
     * {array} [associations] - With an array of associations.
     * {object} [connOptions] - Connection options, e.g. transaction handle
     */
    static async cached_(key, associations, connOptions) {
        if (key) {
            let combinedKey = key;

            if (!_.isEmpty(associations)) {
                combinedKey += '/' + minifyAssocs(associations).join('&')
            }

            let cachedData;

            if (!this._cachedData) {
                this._cachedData = {};
            } else if (this._cachedData[combinedKey]) {
                cachedData = this._cachedData[combinedKey];
            }

            if (!cachedData) {
                cachedData = this._cachedData[combinedKey] = await this.findAll_({ $association: associations, $toDictionary: key }, connOptions);
            }
    
            return cachedData;
        } 

        return this.cached_(this.meta.keyField, associations, connOptions);
    }

    static toDictionary(entityCollection, key) {
        key || (key = this.meta.keyField);

        return entityCollection.reduce((dict, v) => {
            dict[v[key]] = v;
            return dict;
        }, {});
    }
    
    /**
     * Find one record, returns a model object containing the record or undefined if nothing found.
     * @param {object|array} condition - Query condition, key-value pair will be joined with 'AND', array element will be joined with 'OR'.
     * @param {object} [findOptions] - findOptions     
     * @property {object} [findOptions.$association] - Joinings
     * @property {object} [findOptions.$projection] - Selected fields
     * @property {object} [findOptions.$query] - Extra condition
     * @property {object} [findOptions.$groupBy] - Group by fields
     * @property {object} [findOptions.$orderBy] - Order by fields
     * @property {number} [findOptions.$offset] - Offset
     * @property {number} [findOptions.$limit] - Limit          
     * @property {bool} [findOptions.$includeDeleted=false] - Include those marked as logical deleted.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {*}
     */
    static async findOne_(findOptions, connOptions) { 
        pre: findOptions;

        findOptions = this._prepareQueries(findOptions, true /* for single record */);
        
        let context = {             
            options: findOptions,
            connOptions
        }; 

        await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);  

        return this._safeExecute_(async (context) => {            
            let records = await this.db.connector.find_(
                this.meta.name, 
                context.options, 
                context.connOptions
            );
            if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

            if (findOptions.$relationships && !findOptions.$skipOrm) {  
                //rows, coloumns, aliasMap                    
                if (records[0].length === 0) return undefined;

                records = this._mapRecordsToObjects(records, findOptions.$relationships);
            } else if (records.length === 0) {
                return undefined;
            }

            if (records.length !== 1) {
                this.db.connector.log('error', `findOne() returns more than one record.`, { entity: this.meta.name, options: context.options });
            }

            let result = records[0];

            return result;
        }, context);
    }

    /**
     * Find records matching the condition, returns an array of records.     
     * @param {object} [findOptions] - findOptions     
     * @property {object} [findOptions.$association] - Joinings
     * @property {object} [findOptions.$projection] - Selected fields
     * @property {object} [findOptions.$query] - Extra condition
     * @property {object} [findOptions.$groupBy] - Group by fields
     * @property {object} [findOptions.$orderBy] - Order by fields
     * @property {number} [findOptions.$offset] - Offset
     * @property {number} [findOptions.$limit] - Limit 
     * @property {number} [findOptions.$totalCount] - Return totalCount           
     * @property {bool} [findOptions.$includeDeleted=false] - Include those marked as logical deleted.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {array}
     */
    static async findAll_(findOptions, connOptions) {  
        findOptions = this._prepareQueries(findOptions);

        let context = {             
            options: findOptions,
            connOptions
        }; 

        await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);  

        let totalCount;

        let rows = await this._safeExecute_(async (context) => {             
            let records = await this.db.connector.find_(
                this.meta.name, 
                context.options, 
                context.connOptions
            );

            if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

            if (findOptions.$relationships) {
                if (findOptions.$totalCount) {
                    totalCount = records[3];
                }

                if (!findOptions.$skipOrm) {                                                  
                    records = this._mapRecordsToObjects(records, findOptions.$relationships);
                } else {
                    records = records[0];
                }
            } else {
                if (findOptions.$totalCount) {
                    totalCount = records[1];
                    records = records[0];
                }    
            }

            return this.afterFindAll_(context, records);            
        }, context);

        if (findOptions.$totalCount) {
            let ret = { totalItems: totalCount, items: rows };

            if (!isNothing(findOptions.$offset)) {
                ret.offset = findOptions.$offset;
            }

            if (!isNothing(findOptions.$limit)) {
                ret.limit = findOptions.$limit;
            }

            return ret;
        }

        return rows;
    }

    /**
     * Create a new entity with given data.
     * @param {object} data - Entity data 
     * @param {object} [createOptions] - Create options     
     * @property {bool} [createOptions.$retrieveCreated=false] - Retrieve the newly created record from db.     
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {EntityModel}
     */
    static async create_(data, createOptions, connOptions) {
        let rawOptions = createOptions;

        if (!createOptions) { 
            createOptions = {}; 
        }

        let [ raw, associations ] = this._extractAssociations(data);

        let context = { 
            raw, 
            rawOptions,
            options: createOptions,
            connOptions
        };       
        
        let needCreateAssocs = !_.isEmpty(associations);

        if (!(await this.beforeCreate_(context))) {
            return context.return;
        }

        let success = await this._safeExecute_(async (context) => { 
            if (needCreateAssocs) {
                await this.ensureTransaction_(context);                       
            }

            await this._prepareEntityData_(context);          

            if (!(await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context))) {
                return false;
            }
            
            if (!(await this._internalBeforeCreate_(context))) {
                return false;
            }

            context.latest = Object.freeze(context.latest);

            context.result = await this.db.connector.create_(
                this.meta.name, 
                context.latest, 
                context.connOptions
            );

            context.return = context.latest;

            await this._internalAfterCreate_(context);

            if (!context.queryKey) {
                context.queryKey = this.getUniqueKeyValuePairsFrom(context.latest);
            }            

            await Features.applyRules_(Rules.RULE_AFTER_CREATE, this, context);

            if (needCreateAssocs) {
                await this._createAssocs_(context, associations);
            }
            
            return true;
        }, context);

        if (success) {
            await this.afterCreate_(context);            
        }

        return context.return;
    }

    /**
     * Update an existing entity with given data.
     * @param {object} data - Entity data with at least one unique key (pair) given
     * @param {object} [updateOptions] - Update options
     * @property {object} [updateOptions.$query] - Extra condition
     * @property {bool} [updateOptions.$retrieveUpdated=false] - Retrieve the updated entity from database     
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {object}
     */
    static async updateOne_(data, updateOptions, connOptions) {
        if (updateOptions && updateOptions.$bypassReadOnly) {
            throw new OolongUsageError('Unexpected usage.', { 
                entity: this.meta.name, 
                reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
                updateOptions
            });     
        }

        return this._update_(data, updateOptions, connOptions, true);
    }

    /**
     * Update many existing entites with given data.
     * @param {*} data 
     * @param {*} updateOptions 
     * @param {*} connOptions 
     */
    static async updateMany_(data, updateOptions, connOptions) {
        if (updateOptions && updateOptions.$bypassReadOnly) {
            throw new OolongUsageError('Unexpected usage.', { 
                entity: this.meta.name, 
                reason: '$bypassReadOnly option is not allow to be set from public update_ method.',
                updateOptions
            });     
        }

        return this._update_(data, updateOptions, connOptions, false);
    }
    
    static async _update_(data, updateOptions, connOptions, forSingleRecord) {
        let rawOptions = updateOptions;

        if (!updateOptions) {
            let conditionFields = this.getUniqueKeyFieldsFrom(data);
            if (_.isEmpty(conditionFields)) {
                throw new OolongUsageError('Primary key value(s) or at least one group of unique key value(s) is required for updating an entity.');
            }
            updateOptions = { $query: _.pick(data, conditionFields) };
            data = _.omit(data, conditionFields);
        }

        let [ raw, associations ] = this._extractAssociations(data);

        let context = { 
            raw, 
            rawOptions,
            options: this._prepareQueries(updateOptions, forSingleRecord /* for single record */),            
            connOptions
        };       
        
        let needCreateAssocs = !_.isEmpty(associations);

        let toUpdate;

        if (forSingleRecord) {
            toUpdate = await this.beforeUpdate_(context);
        } else {
            toUpdate = await this.beforeUpdateMany_(context);
        }

        if (!toUpdate) {
            return context.return;
        }
        
        let success = await this._safeExecute_(async (context) => {
            if (needCreateAssocs) {
                await this.ensureTransaction_(context);                       
            }

            await this._prepareEntityData_(context, true /* is updating */, forSingleRecord);          

            if (!(await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context))) {
                return false;
            }

            if (forSingleRecord) {
                toUpdate = await this._internalBeforeUpdate_(context);
            } else {
                toUpdate = await this._internalBeforeUpdateMany_(context);
            }

            if (!toUpdate) {
                return false;
            }

            context.latest = Object.freeze(context.latest);

            context.result = await this.db.connector.update_(
                this.meta.name, 
                context.latest, 
                context.options.$query,
                context.options,
                context.connOptions
            );  

            context.return = context.latest;

            if (forSingleRecord) {
                await this._internalAfterUpdate_(context);
            } else {
                await this._internalAfterUpdateMany_(context);
            }

            if (!context.queryKey) {
                context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
            }

            await Features.applyRules_(Rules.RULE_AFTER_UPDATE, this, context);

            if (needCreateAssocs) {
                await this._updateAssocs_(context, associations);
            }            

            return true;
        }, context);

        if (success) {
            if (forSingleRecord) {
                await this.afterUpdate_(context);
            } else {
                await this.afterUpdateMany_(context);
            }          
        }

        return context.return;
    }

    /**
     * Update an existing entity with given data, or create one if not found.
     * @param {*} data 
     * @param {*} updateOptions 
     * @param {*} connOptions 
     */    
    static async replaceOne_(data, updateOptions, connOptions) {
        let rawOptions = updateOptions;

        if (!updateOptions) {
            let conditionFields = this.getUniqueKeyFieldsFrom(data);
            if (_.isEmpty(conditionFields)) {
                throw new OolongUsageError('Primary key value(s) or at least one group of unique key value(s) is required for replacing an entity.');
            }
            
            updateOptions = { ...updateOptions, $query: _.pick(data, conditionFields) };
        } else {
            updateOptions = this._prepareQueries(updateOptions, true);
        }

        let context = { 
            raw: data, 
            rawOptions,
            options: updateOptions,
            connOptions
        };

        return this._safeExecute_(async (context) => {
            return this._doReplaceOne_(context); // different dbms has different replacing strategy
        }, context);
    }

    /**
     * Remove an existing entity with given data.     
     * @param {object} [deleteOptions] - Update options
     * @property {object} [deleteOptions.$query] - Extra condition
     * @property {bool} [deleteOptions.$retrieveDeleted=false] - Retrieve the deleted entity from database     
     * @property {bool} [deleteOptions.$physicalDeletion=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection] 
     */
    static async deleteOne_(deleteOptions, connOptions) {
        return this._delete_(deleteOptions, connOptions, true);
    }

    /**
     * Remove an existing entity with given data.     
     * @param {object} [deleteOptions] - Update options
     * @property {object} [deleteOptions.$query] - Extra condition
     * @property {bool} [deleteOptions.$retrieveDeleted=false] - Retrieve the deleted entity from database     
     * @property {bool} [deleteOptions.$physicalDeletion=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection] 
     */
    static async deleteMany_(deleteOptions, connOptions) {
        return this._delete_(deleteOptions, connOptions, false);
    }

    /**
     * Remove an existing entity with given data.     
     * @param {object} [deleteOptions] - Update options
     * @property {object} [deleteOptions.$query] - Extra condition
     * @property {bool} [deleteOptions.$retrieveDeleted=false] - Retrieve the deleted entity from database     
     * @property {bool} [deleteOptions.$physicalDeletion=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection] 
     */
    static async _delete_(deleteOptions, connOptions, forSingleRecord) {
        let rawOptions = deleteOptions;

        deleteOptions = this._prepareQueries(deleteOptions, forSingleRecord /* for single record */);

        if (_.isEmpty(deleteOptions.$query)) {
            throw new OolongUsageError('Empty condition is not allowed for deleting an entity.');
        }

        let context = { 
            rawOptions,
            options: deleteOptions,
            connOptions
        };

        let toDelete;

        if (forSingleRecord) {
            toDelete = await this.beforeDelete_(context);
        } else {
            toDelete = await this.beforeDeleteMany_(context);
        }

        if (!toDelete) {
            return context.return;
        }
        
        let success = await this._safeExecute_(async (context) => {
            if (!(await Features.applyRules_(Rules.RULE_BEFORE_DELETE, this, context))) {
                return false;
            }        

            if (forSingleRecord) {
                toDelete = await this._internalBeforeDelete_(context);
            } else {
                toDelete = await this._internalBeforeDeleteMany_(context);
            }

            if (!toDelete) {
                return false;
            }

            context.result = await this.db.connector.delete_(
                this.meta.name,                 
                context.options.$query,
                context.connOptions
            ); 

            if (forSingleRecord) {
                await this._internalAfterDelete_(context);
            } else {
                await this._internalAfterDeleteMany_(context);
            }

            if (!context.queryKey) {
                if (forSingleRecord) {
                    context.queryKey = this.getUniqueKeyValuePairsFrom(context.options.$query);
                } else {
                    context.queryKey = context.options.$query;
                }
            }

            await Features.applyRules_(Rules.RULE_AFTER_DELETE, this, context);
            
            return true;
        }, context);

        if (success) {
            if (forSingleRecord) {
                await this.afterDelete_(context);
            } else {
                await this.afterDeleteMany_(context);
            }    
        }

        return context.return;
    }

    /**
     * Check whether a data record contains primary key or at least one unique key pair.
     * @param {object} data 
     */
    static _containsUniqueKey(data) {
        let hasKeyNameOnly = false;

        let hasNotNullKey = _.find(this.meta.uniqueKeys, fields => {
            let hasKeys = _.every(fields, f => f in data);
            hasKeyNameOnly = hasKeyNameOnly || hasKeys;
            
            return _.every(fields, f => !_.isNil(data[f]));
        });

        return [ hasNotNullKey, hasKeyNameOnly ];
    }

    /**
     * Ensure the condition contains one of the unique keys.
     * @param {*} condition 
     */
    static _ensureContainsUniqueKey(condition) {
        let [ containsUniqueKeyAndValue, containsUniqueKeyOnly ] = this._containsUniqueKey(condition);        

        if (!containsUniqueKeyAndValue) {
            if (containsUniqueKeyOnly) {
                throw new DataValidationError('One of the unique key field as query condition is null. Condition: ' + JSON.stringify(condition));
            }

            throw new OolongUsageError('Single record operation requires at least one unique key value pair in the query condition.', { 
                    entity: this.meta.name,                     
                    condition
                }
            );
        }
    }    

    /**
     * Prepare valid and sanitized entity data for sending to database.
     * @param {object} context - Operation context.
     * @property {object} context.raw - Raw input data.
     * @property {object} [context.connOptions]
     * @param {bool} isUpdating - Flag for updating existing entity.
     */
    static async _prepareEntityData_(context, isUpdating = false, forSingleRecord = true) {
        let meta = this.meta;
        let i18n = this.i18n;
        let { name, fields } = meta;        

        let { raw } = context;
        let latest = {}, existing = context.options.$existing;
        context.latest = latest;       

        if (!context.i18n) {
            context.i18n = i18n;
        }

        let opOptions = context.options;

        if (isUpdating && _.isEmpty(existing) && (this._dependsOnExistingData(raw) || opOptions.$retrieveExisting)) {
            await this.ensureTransaction_(context);          

            if (forSingleRecord) {
                existing = await this.findOne_({ $query: opOptions.$query }, context.connOptions);            
            } else {
                existing = await this.findAll_({ $query: opOptions.$query }, context.connOptions);                      
            }
            context.existing = existing;                     
        }        

        if (opOptions.$retrieveExisting && !context.rawOptions.$existing) {
            context.rawOptions.$existing = existing;
        }

        await eachAsync_(fields, async (fieldInfo, fieldName) => {
            if (fieldName in raw) {
                let value = raw[fieldName];

                //field value given in raw data
                if (fieldInfo.readOnly) {
                    if (!isUpdating || !opOptions.$bypassReadOnly.has(fieldName)) {
                        //read only, not allow to set by input value
                        throw new DataValidationError(`Read-only field "${fieldName}" is not allowed to be set by manual input.`, {
                            entity: name,                        
                            fieldInfo: fieldInfo 
                        });
                    }
                }  

                if (isUpdating && fieldInfo.freezeAfterNonDefault) {
                    assert: existing, '"freezeAfterNonDefault" qualifier requires existing data.';

                    if (existing[fieldName] !== fieldInfo.default) {
                        //freezeAfterNonDefault, not allow to change if value is non-default
                        throw new DataValidationError(`FreezeAfterNonDefault field "${fieldName}" is not allowed to be changed.`, {
                            entity: name,                        
                            fieldInfo: fieldInfo 
                        });
                    }
                }

                /**  todo: fix dependency, check writeProtect 
                if (isUpdating && fieldInfo.writeOnce) {     
                    assert: existing, '"writeOnce" qualifier requires existing data.';
                    if (!_.isNil(existing[fieldName])) {
                        throw new DataValidationError(`Write-once field "${fieldName}" is not allowed to be update once it was set.`, {
                            entity: name,
                            fieldInfo: fieldInfo 
                        });
                    }
                } */
                
                //sanitize first
                if (isNothing(value)) {
                    if (!fieldInfo.optional) {
                        throw new DataValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
                            entity: name,
                            fieldInfo: fieldInfo 
                        });
                    }

                    latest[fieldName] = null;
                } else {
                    if (_.isPlainObject(value) && value.oorType) {
                        latest[fieldName] = value;

                        return;
                    }

                    try {
                        latest[fieldName] = Types.sanitize(value, fieldInfo, i18n);
                    } catch (error) {
                        throw new DataValidationError(`Invalid "${fieldName}" value of "${name}" entity.`, {
                            entity: name,
                            fieldInfo: fieldInfo,
                            error: error.message || error.stack 
                        });
                    }    
                }
                
                return;
            }

            //not given in raw data
            if (isUpdating) {
                if (fieldInfo.forceUpdate) {
                    //has force update policy, e.g. updateTimestamp
                    if (fieldInfo.updateByDb) {
                        return;
                    }

                    //require generator to refresh auto generated value
                    if (fieldInfo.auto) {
                        latest[fieldName] = await Generators.default(fieldInfo, i18n);
                        return;
                    } 

                    throw new DataValidationError(
                        `"${fieldName}" of "${name}" enttiy is required for each update.`, {         
                            entity: name,                                               
                            fieldInfo: fieldInfo
                        }
                    );          
                }

                return;
            } 

            //new record
            if (!fieldInfo.createByDb) {
                if (fieldInfo.hasOwnProperty('default')) {
                    //has default setting in meta data
                    latest[fieldName] = fieldInfo.default;

                } else if (fieldInfo.optional) {
                    return;
                } else if (fieldInfo.auto) {
                    //automatically generated
                    latest[fieldName] = await Generators.default(fieldInfo, i18n);

                } else {
                    //missing required
                    throw new DataValidationError(`"${fieldName}" of "${name}" entity is required.`, {
                        entity: name,
                        fieldInfo: fieldInfo 
                    });
                }
            } // else default value set by database or by rules
        });

        latest = context.latest = this._translateValue(latest, opOptions.$variables, true);

        try {
            await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);    
        } catch (error) {
            if (error.status) {
                throw error;
            }

            throw new DsOperationError(
                `Error occurred during applying feature rules to entity "${this.meta.name}". Detail: ` + error.message,
                { error: error }
            );
        }

        await this.applyModifiers_(context, isUpdating);

        //final round process before entering database
        context.latest = _.mapValues(latest, (value, key) => {
            let fieldInfo = fields[key];
            assert: fieldInfo;

            if (_.isPlainObject(value) && value.oorType) {
                //there is special input column which maybe a function or an expression
                opOptions.$requireSplitColumns = true;
                return value;
            }

            return this._serializeByTypeInfo(value, fieldInfo);
        });        

        return context;
    }

    /**
     * Ensure commit or rollback is called if transaction is created within the executor.
     * @param {*} executor 
     * @param {*} context 
     */
    static async _safeExecute_(executor, context) {
        executor = executor.bind(this);

        if (context.connOptions && context.connOptions.connection) {
             return executor(context);
        } 

        try {
            let result = await executor(context);
            
            //if the executor have initiated a transaction
            if (context.connOptions && context.connOptions.connection) { 
                await this.db.connector.commit_(context.connOptions.connection);
                delete context.connOptions.connection;       
            }

            return result;
        } catch (error) {
            //we have to rollback if error occurred in a transaction
            if (context.connOptions && context.connOptions.connection) { 
                this.db.connector.log('error', `Rollbacked, reason: ${error.message}`, {  
                    entity: this.meta.name,
                    context: context.options,
                    rawData: context.raw,
                    latestData: context.latest
                });
                await this.db.connector.rollback_(context.connOptions.connection);                    
                delete context.connOptions.connection;   
            }     

            throw error;
        } 
    }

    static _dependencyChanged(fieldName, context) {
        let deps = this.meta.fieldDependencies[fieldName];

        return _.find(deps, d => _.isPlainObject(d) ? hasKeyByPath(context, d.reference) : hasKeyByPath(context, d));
    }

    static _referenceExist(input, ref) {
        let pos = ref.indexOf('.');

        if (pos > 0) {
            return ref.substr(pos+1) in input;
        }

        return ref in input;
    }

    static _dependsOnExistingData(input) {
        //check modifier dependencies
        let deps = this.meta.fieldDependencies;
        let hasDepends = false;

        if (deps) {           
            let nullDepends = new Set();
            
            hasDepends = _.find(deps, (dep, fieldName) => 
                _.find(dep, d => {
                    if (_.isPlainObject(d)) {
                        if (d.whenNull) {
                            if (_.isNil(input[fieldName])) {
                                nullDepends.add(dep);
                            }

                            return false;
                        }

                        d = d.reference;
                    }

                    return fieldName in input && !this._referenceExist(input, d);
                })
            );

            if (hasDepends) {
                return true;
            }

            for (let dep of nullDepends) {
                if (_.find(dep, d => !this._referenceExist(input, d.reference))) {
                    return true;
                }
            }
        }

        //check by special rules
        let atLeastOneNotNull = this.meta.features.atLeastOneNotNull;
        if (atLeastOneNotNull) {
            hasDepends = _.find(atLeastOneNotNull, fields => _.find(fields, field => (field in input) && _.isNil(input[field])));
            if (hasDepends) {                
                return true;
            }
        }
        
        return false;
    }

    static _hasReservedKeys(obj) {
        return _.find(obj, (v, k) => k[0] === '$');
    }

    static _prepareQueries(options, forSingleRecord = false) {
        if (!_.isPlainObject(options)) {
            if (forSingleRecord && Array.isArray(this.meta.keyField)) {
                throw new OolongUsageError('Cannot use a singular value as condition to query against a entity with combined primary key.');
            }

            return options ? { $query: { [this.meta.keyField]: this._translateValue(options) } } : {};
        }

        let normalizedOptions = {}, query = {};

        _.forOwn(options, (v, k) => {
            if (k[0] === '$') {
                normalizedOptions[k] = v;
            } else {
                query[k] = v;                
            }
        });

        normalizedOptions.$query = { ...query, ...normalizedOptions.$query };

        if (forSingleRecord && !options.$bypassEnsureUnique) {            
            this._ensureContainsUniqueKey(normalizedOptions.$query);
        }        

        normalizedOptions.$query = this._translateValue(normalizedOptions.$query, normalizedOptions.$variables, null, true);

        if (normalizedOptions.$groupBy) {
            if (_.isPlainObject(normalizedOptions.$groupBy)) {
                if (normalizedOptions.$groupBy.having) {
                    normalizedOptions.$groupBy.having = this._translateValue(normalizedOptions.$groupBy.having, normalizedOptions.$variables);
                }
            }
        }

        if (normalizedOptions.$projection) {
            normalizedOptions.$projection = this._translateValue(normalizedOptions.$projection, normalizedOptions.$variables);
        }

        if (normalizedOptions.$association && !normalizedOptions.$relationships) {
            normalizedOptions.$relationships = this._prepareAssociations(normalizedOptions);
        }

        return normalizedOptions;
    }

    /**
     * Pre create processing, return false to stop upcoming operation.
     * @param {*} context      
     */
    static async beforeCreate_(context) {
        return true;
    }

    /**
     * Pre update processing, return false to stop upcoming operation.
     * @param {*} context      
     */
    static async beforeUpdate_(context) {
        return true;
    }

    /**
     * Pre update processing, multiple records, return false to stop upcoming operation.
     * @param {*} context      
     */
    static async beforeUpdateMany_(context) {
        return true;
    }

    /**
     * Pre delete processing, return false to stop upcoming operation.
     * @param {*} context      
     */
    static async beforeDelete_(context) {
        return true;
    }

    /**
     * Pre delete processing, multiple records, return false to stop upcoming operation.
     * @param {*} context      
     */
    static async beforeDeleteMany_(context) {
        return true;
    }

    /**
     * Post create processing.
     * @param {*} context      
     */
    static async afterCreate_(context) {
    }

    /**
     * Post update processing.
     * @param {*} context      
     */
    static async afterUpdate_(context) {
    }

    /**
     * Post update processing, multiple records 
     * @param {*} context      
     */
    static async afterUpdateMany_(context) {
    }

    /**
     * Post delete processing.
     * @param {*} context      
     */
    static async afterDelete_(context) {
    }

    /**
     * Post delete processing, multiple records 
     * @param {*} context      
     */
    static async afterDeleteMany_(context) {
    }

    /**
     * Post findAll processing
     * @param {*} context 
     * @param {*} records 
     */
    static async afterFindAll_(context, records) {
        if (context.options.$toDictionary) {
            let keyField = this.meta.keyField;
            
            if (typeof context.options.$toDictionary === 'string') { 
                keyField = context.options.$toDictionary; 

                if (!(keyField in this.meta.fields)) {
                    throw new OolongUsageError(`The key field "${keyField}" provided to index the cached dictionary is not a field of entity "${this.meta.name}".`);
                }
            }

            return this.toDictionary(records, keyField);
        } 

        return records;
    }

    static _prepareAssociations() {
        throw new Error(NEED_OVERRIDE);
    }

    static _mapRecordsToObjects() {
        throw new Error(NEED_OVERRIDE);
    }

    static _extractAssociations(data) {
        throw new Error(NEED_OVERRIDE);    
    }

    static async _createAssocs_(context, assocs) {
        throw new Error(NEED_OVERRIDE);
    }

    static async _updateAssocs_(context, assocs) {
        throw new Error(NEED_OVERRIDE);
    }

    static _translateSymbolToken(name) {
        throw new Error(NEED_OVERRIDE);
    }

    static _serialize(value) {
        throw new Error(NEED_OVERRIDE);
    }

    static _serializeByTypeInfo(value, info) {
        throw new Error(NEED_OVERRIDE);
    }

    static _translateValue(value, variables, skipSerialize, arrayToInOperator) {
        if (_.isPlainObject(value)) {
            if (value.oorType) {
                if (oorTypesToBypass.has(value.oorType)) return value;

                if (value.oorType === 'SessionVariable') {
                    if (!variables) {
                        throw new OolongUsageError('Variables context missing.');
                    }

                    if ((!variables.session || !(value.name in  variables.session)) && !value.optional) {
                        let errArgs = [];
                        if (value.missingMessage) {
                            errArgs.push(value.missingMessage);
                        }
                        if (value.missingStatus) {
                            errArgs.push(value.missingStatus || HttpCode.BAD_REQUEST);
                        }

                        throw new BusinessError(...errArgs);
                    }

                    return variables.session[value.name];
                } else if (value.oorType === 'QueryVariable') {
                    if (!variables) {
                        throw new OolongUsageError('Variables context missing.');
                    }

                    if (!variables.query || !(value.name in variables.query)) {                        
                        throw new OolongUsageError(`Query parameter "${value.name}" in configuration not found.`);
                    }
                    
                    return variables.query[value.name];
                } else if (value.oorType === 'SymbolToken') {
                    return this._translateSymbolToken(value.name);
                } 

                throw new Error('Not impletemented yet. ' + value.oorType);
            }

            return _.mapValues(value, (v, k) => this._translateValue(v, variables, skipSerialize, arrayToInOperator && k[0] !== '$'));
        }

        if (Array.isArray(value)) {  
            let ret = value.map(v => this._translateValue(v, variables, skipSerialize, arrayToInOperator));
            return arrayToInOperator ? { $in: ret } : ret;
        }

        if (skipSerialize) return value;

        return this._serialize(value);
    }
}

module.exports = EntityModel;