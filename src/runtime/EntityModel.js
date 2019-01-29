"use strict";

const Util = require('rk-utils');
const { _ } = Util._;
const Errors = require('./Errors');
const Generators = require('./Generators');
const Types = require('./types');
const { DataValidationError, OolongUsageError, DsOperationError } = Errors;
const Features = require('./entityFeatures');
const Rules = require('../enum/Rules');

const { isNothing } = require('../utils/lang');

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

    /**
     * Get an object of the primary key values.
     */
    get $pkValues() {
        return _.pick(this, _.castArray(this.constructor.meta.keyField));
    }

    /**
     * Populate data from database.
     * @param {*} data 
     * @return {EntityModel}
     */
    static populate(data) {
        let ModelClass = this;
        return new ModelClass(data);
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
        pre: _.isPlainObject(data);    
        
        let ukFields = this.getUniqueKeyFieldsFrom(data);
        return _.pick(data, ukFields);
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
     * @property {bool} [findOptions.$unboxing=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @property {bool} [findOptions.$includeDeleted=false] - Include those marked as logical deleted.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {*}
     */
    static async findOne_(findOptions, connOptions) { 
        pre: findOptions;

        findOptions = this._prepareQueries(findOptions, true /* for single record */);
        
        let context = {             
            findOptions,
            connOptions
        }; 

        await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);  

        if (findOptions.$association) {
            findOptions.$association = this._prepareAssociations(findOptions.$association);
        }

        return this._safeExecute_(async (context) => {            
            let records = await this.db.connector.find_(
                this.meta.name, 
                context.findOptions, 
                context.connOptions
            );
            if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

            if (findOptions.$association) {  
                //rows, coloumns, aliasMap                    
                if (records[0].length === 0) return undefined;

                records = this._mapRecordsToObjects(records, findOptions.$association);
            } else if (records.length === 0) {
                return undefined;
            }

            assert: records.length === 1;
            let result = records[0];

            if (context.findOptions.$unboxing) return result;

            return this.populate(result);
        }, context);
    }

    /**
     * Find records matching the condition, returns an array of model object or an array of records directly if $unboxing = true.     
     * @param {object} [findOptions] - findOptions     
     * @property {object} [findOptions.$association] - Joinings
     * @property {object} [findOptions.$projection] - Selected fields
     * @property {object} [findOptions.$query] - Extra condition
     * @property {object} [findOptions.$groupBy] - Group by fields
     * @property {object} [findOptions.$orderBy] - Order by fields
     * @property {number} [findOptions.$offset] - Offset
     * @property {number} [findOptions.$limit] - Limit     
     * @property {bool} [findOptions.$unboxing=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @property {bool} [findOptions.$includeDeleted=false] - Include those marked as logical deleted.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {array}
     */
    static async findAll_(findOptions, connOptions) {
        findOptions = this._prepareQueries(findOptions);

        let context = {             
            findOptions,
            connOptions
        }; 

        await Features.applyRules_(Rules.RULE_BEFORE_FIND, this, context);  

        if (findOptions.$association) {
            findOptions.$association = this._prepareAssociations(findOptions.$association);
        }

        return this._safeExecute_(async (context) => {             
            let records = await this.db.connector.find_(
                this.meta.name, 
                context.findOptions, 
                context.connOptions
            );

            if (!records) throw new DsOperationError('connector.find_() returns undefined data record.');

            if (findOptions.$association) {                
                records = this._mapRecordsToObjects(records, findOptions.$association);
            }

            if (context.findOptions.$unboxing) return records;

            return records.map(row => this.populate(row));
        }, context);
    }

    /**
     * Create a new entity with given data.
     * @param {object} data - Entity data 
     * @param {object} [createOptions] - Create options     
     * @property {bool} [createOptions.$retrieveCreated=false] - Retrieve the newly created record from db.
     * @property {bool} [createOptions.$unboxing=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {EntityModel}
     */
    static async create_(data, createOptions, connOptions) {
        createOptions || (createOptions = {});

        let context = { 
            raw: data, 
            createOptions,
            connOptions
        };

        return this._safeExecute_(async (context) => {
            await this._prepareEntityData_(context);          

            await Features.applyRules_(Rules.RULE_BEFORE_CREATE, this, context);    

            context.result = await this.db.connector.create_(
                this.meta.name, 
                context.latest, 
                context.connOptions
            );

            await this.afterCreate_(context);
            
            return createOptions.$unboxing ? context.latest : this.populate(context.latest);
        }, context);
    }

    /**
     * Update an existing entity with given data.
     * @param {object} data - Entity data with at least one unique key (pair) given
     * @param {object} [updateOptions] - Update options
     * @property {object} [updateOptions.$query] - Extra condition
     * @property {bool} [updateOptions.$retrieveUpdated=false] - Retrieve the updated entity from database
     * @property {bool} [updateOptions.$unboxing=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection]
     * @returns {object}
     */
    static async update_(data, updateOptions, connOptions) {
        if (updateOptions && updateOptions.$byPassReadOnly) {
            throw new OolongUsageError('Unexpected usage.', { 
                entity: this.meta.name, 
                reason: '$byPassReadOnly option is not allow to be set from public update_ method.',
                updateOptions
            });     
        }

        return this._update_(data, updateOptions, connOptions);
    }
    
    static async _update_(data, updateOptions, connOptions) {
        if (!updateOptions) {
            let conditionFields = this.getUniqueKeyFieldsFrom(data);
            if (_.isEmpty(conditionFields)) {
                throw new OolongUsageError('Primary key value(s) or at least one group of unique key value(s) is required for updating an entity.');
            }
            updateOptions = { $query: _.pick(data, conditionFields) };
            data = _.omit(data, conditionFields);
        }

        updateOptions = this._prepareQueries(updateOptions, true /* for single record */);

        let context = { 
            raw: data, 
            updateOptions,
            connOptions
        };
        
        return this._safeExecute_(async (context) => {
            await this._prepareEntityData_(context, true /* is updating */);          

            await Features.applyRules_(Rules.RULE_BEFORE_UPDATE, this, context);     

            context.result = await this.db.connector.update_(
                this.meta.name, 
                context.latest, 
                context.updateOptions.$query,
                context.connOptions
            );

            await this.afterUpdate_(context);
            
            return updateOptions.$unboxing ? context.latest : this.populate(context.latest);
        }, context);
    }

    /**
     * Remove an existing entity with given data.     
     * @param {object} [deleteOptions] - Update options
     * @property {object} [deleteOptions.$query] - Extra condition
     * @property {bool} [deleteOptions.$retrieveDeleted=false] - Retrieve the updated entity from database
     * @property {bool} [deleteOptions.$unboxing=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @property {bool} [deleteOptions.$physicalDeletion=false] - When fetchArray = true, the result will be returned directly without creating model objects.
     * @param {object} [connOptions]
     * @property {object} [connOptions.connection] 
     */
    static async delete_(deleteOptions, connOptions) {
        pre: deleteOptions;

        deleteOptions = this._prepareQueries(deleteOptions, true /* for single record */);

        if (_.isEmpty(deleteOptions.$query)) {
            throw new OolongUsageError('Empty condition is not allowed for deleting an entity.');
        }

        if (this.meta.features.logicalDeletion && !deleteOptions.$physicalDeletion) {
            let { field, value } = this.meta.features.logicalDeletion;
            return this._update_({ [field]: value }, { 
                $query: deleteOptions.$query, 
                $retrieveUpdated: deleteOptions.$retrieveDeleted,
                $unboxing: deleteOptions.$unboxing,
                $byPassReadOnly: new Set([field])
            });
        }
        
        let context = { 
            deleteOptions,
            connOptions
        };
        
        return this._safeExecute_(async (context) => {
            await this.beforeDelete_(context);

            context.result = await this.db.connector.delete_(
                this.meta.name,                 
                context.deleteOptions.$query,
                context.connOptions
            );
            
            return deleteOptions.$unboxing ? context.existing : this.populate(context.existing);
        }, context);
    }

    /**
     * Check whether a data record contains primary key or at least one unique key pair.
     * @param {object} data 
     */
    static _containsUniqueKey(data) {
        return _.find(this.meta.uniqueKeys, fields => _.every(fields, f => !_.isNil(data[f])));
    }

    /**
     * Ensure the condition contains one of the unique keys.
     * @param {*} condition 
     */
    static _ensureContainsUniqueKey(condition) {
        let containsUniqueKey = this._containsUniqueKey(condition);

        if (!containsUniqueKey) {
            throw new OolongUsageError('Unexpected usage.', { 
                    entity: this.meta.name, 
                    reason: 'Single record operation requires condition to be containing unique key.',
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
    static async _prepareEntityData_(context, isUpdating = false) {
        let meta = this.meta;
        let i18n = this.i18n;
        let { name, fields } = meta;        

        let { raw } = context;
        let latest = {}, existing;
        context.latest = latest;       

        if (!context.i18n) {
            context.i18n = i18n;
        }

        if (isUpdating && this._dependsOnExistingData(raw)) {
            if (!context.connOptions || !context.connOptions.connection) {                
                context.connOptions || (context.connOptions = {});

                context.connOptions.connection = await this.db.connector.beginTransaction_();                           
            } // else already in a transaction                        

            existing = await this.findOne_({ $query: context.updateOptions.$query, $unboxing: true }, context.connOptions);            
            context.existing = existing;                        
        }        

        await Util.eachAsync_(fields, async (fieldInfo, fieldName) => {
            if (fieldName in raw) {
                //field value given in raw data
                if (fieldInfo.readOnly) {
                    if (!isUpdating || !context.updateOptions.$byPassReadOnly.has(fieldName)) {
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

                if (isUpdating && fieldInfo.writeOnce) {     
                    assert: existing, '"writeOnce" qualifier requires existing data.';
                    if (!_.isNil(existing[fieldName])) {
                        throw new DataValidationError(`Write-once field "${fieldName}" is not allowed to be update once it was set.`, {
                            entity: name,
                            fieldInfo: fieldInfo 
                        });
                    }
                } 
                
                //sanitize first
                if (isNothing(raw[fieldName])) {
                    if (!fieldInfo.optional) {
                        throw new DataValidationError(`The "${fieldName}" value of "${name}" entity cannot be null.`, {
                            entity: name,
                            fieldInfo: fieldInfo 
                        });
                    }

                    latest[fieldName] = null;
                } else {
                    latest[fieldName] = Types.sanitize(raw[fieldName], fieldInfo, i18n);
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

        await Features.applyRules_(Rules.RULE_AFTER_VALIDATION, this, context);    

        await this.applyModifiers_(context, isUpdating);

        this.serialize(context.latest);

        return context;
    }

    static async _safeExecute_(executor, context) {
        executor = executor.bind(this);

        if (context.connOptions && context.connOptions.connection) {
             return executor(context);
        } 

        try {
            let result = await executor(context);
            
            //if the executor have initiated a transaction
            context.connOptions && 
                context.connOptions.connection && 
                await this.db.connector.commit_(context.connOptions.connection);                

            return result;
        } catch (error) {
            //we have to rollback if error occurred in a transaction
            context.connOptions && 
                context.connOptions.connection && 
                await this.db.connector.rollback_(context.connOptions.connection);                

            throw error;
        } 
    }

    static _dependsOnExistingData(input) {
        //check modifier dependencies
        let deps = this.meta.fieldDependencies;
        let hasDepends = false;

        if (deps) {            
            hasDepends = _.find(deps, (dep, fieldName) => {
                if (fieldName in input) {
                    return _.find(dep, d => {
                        let [ stage, field ] = d.split('.');
                        return (stage === 'latest' || stage === 'existng') && _.isNil(input[field]);
                    });
                }

                return false;
            });

            if (hasDepends) {
                return true;
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
        if (options && !options.$query && !this._hasReservedKeys(options)) {
            options = { $query: options };
        }

        if (forSingleRecord) {
            if (!_.isPlainObject(options.$query)) {
                if (Array.isArray(this.meta.keyField)) {
                    throw new OolongUsageError('Cannot use a singular value as condition to query against a entity with combined primary key.');
                }
    
                options.$query = { [this.meta.keyField]: options.$query };
            } else {
                this._ensureContainsUniqueKey(options.$query);
            }        
        }        

        return options || {};
    }

    static _prepareAssociations() {
        throw new Error('Should be override by driver-specific subclass.');
    }

    static _mapRecordsToObjects() {
        throw new Error('Should be override by driver-specific subclass.');
    }
}

module.exports = EntityModel;