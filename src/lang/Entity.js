"use strict";

const EventEmitter = require('events');
const path = require('path');

const { _ } = require('rk-utils');
const { generateDisplayName, deepCloneField, deepClone, Clonable, entityNaming } = require('./OolUtils');

const Field = require('./Field');
const { FunctionalQualifiers } = require('../runtime/types');

/**
 * Entity event listener
 * @callback OolongEntity.eventListener
 * returns {*}
 */

/**
 * Oolong entity
 * @class OolongEntity
 */
class Entity extends Clonable {
    _events = new EventEmitter();

    /**
     * Fields of the entity, map of <fieldName, fieldObject>
     * @member {object.<string, OolongField>}
     */
    fields = {};

    /**     
     * @param {Linker} linker
     * @param {string} name
     * @param {*} oolModule
     * @param {object} info
     */
    constructor(linker, name, oolModule, info) {
        super();

        /**
         * Linker to process this entity
         * @member {OolongLinker}
         */
        this.linker = linker;

        /**
         * Name of this entity
         * @member {string}
         */
        this.name = entityNaming(name);

        /**
         * Owner oolong module
         * @member {object}
         */
        this.oolModule = oolModule;

        /**
         * Raw metadata
         * @member {Object}
         */
        this.info = info;        
    }

    /**
     * Listen on an event
     * @param {string} eventName
     * @param {OolongEntity.eventListener} listener
     * @returns {EventEmitter}
     */
    on(eventName, listener) {
        return this._events.on(eventName, listener);
    }

    /**
     * Start linking this entity
     * @returns {Entity}
     */
    link() {
        pre: !this.linked;

        //1.inherit from base entity if any
        //2.initialize features
        //3.add fields        
        //4.api

        //indexes will processed after processing foreign relationship

        this.linker.log('debug', 'Linking entity [' + this.name + '] ...');

        if (this.info.code) {
            this.code = this.info.code || this.name;
        }

        if (this.info.base) {
            //inherit fields, processed features, key and indexes
            let baseClasses = _.castArray(this.info.base);
            baseClasses.forEach(base => {
                let baseEntity = this.linker.loadEntity(this.oolModule, base);
                assert: baseEntity.linked;

                this._inherit(baseEntity);
            });            

            this.baseClasses = baseClasses;
        }

        if (this.info.comment) {
            /**
             * @member {string}
             */
            this.comment = this.info.comment;
        }

        /**
         * @member {string}
         */
        this.displayName = generateDisplayName(this.name);

        /**
         * @fires OolongEntity#featuresMixingIn
         */
        this._events.emit('featuresMixingIn');

        // load features
        if (this.info.features) {
            this.info.features.forEach(feature => {
                let featureName;

                if (typeof feature === 'string') {
                    featureName = feature;
                } else {
                    featureName = feature.name;
                }

                let fn;
                
                try {
                    fn = require(path.resolve(__dirname, `./entityFeatures/${featureName}.js`));
                } catch (err) {
                    if (err.code === 'MODULE_NOT_FOUND') {
                        throw new Error(`Unknow feature "${featureName}" reference in entity "${this.name}"`);
                    }
                }
                fn(this, this.linker.translateOolValue(this.oolModule, feature.args));
            });
        }

        /**
         * @fires OolongEntity#beforeAddingFields
         */
        this._events.emit('beforeAddingFields');

        // process fields
        if (this.info.fields) {
            _.each(this.info.fields, (fieldInfo, fieldName) => this.addField(fieldName, fieldInfo));
        }

        /**
         * @fires OolongEntity#afterAddingFields
         */
        this._events.emit('afterAddingFields');   

        if (this.info.key) {
            this.key = this.info.key;

            if (Array.isArray(this.key) && this.key.length === 1) {
                this.key = this.key[0];
            }
        }

        /**
         * @fires OolongEntity#beforeAddingInterfaces
         */
        this._events.emit('beforeAddingInterfaces');        
        
        if (!_.isEmpty(this.info.interfaces)) {
            this.interfaces = _.cloneDeep(this.info.interfaces);

            _.forOwn(this.interfaces, (intf) => {
                if (!_.isEmpty(intf.accept)) {
                    intf.accept = _.map(intf.accept, param => {
                        return this.linker.trackBackType(this.oolModule, param);
                    });
                }
            });
        }

        /**
         * @fires OolongEntity#afterAddingInterfaces
         */
        this._events.emit('afterAddingInterfaces');        

        this.linked = true;

        return this;
    }

    /**
     * Check whether the entity has an index on the given fields
     * @param {array} fields
     * @returns {boolean}
     */
    hasIndexOn(fields) {
        fields = fields.concat();
        fields.sort();

        return _.findIndex(this.indexes, index => {
                return _.findIndex(index.fields, (f, idx) => (fields.length <= idx || fields[idx] !== f)) === -1;
            }) != -1;
    }

    /**
     * Add all indexes
     */
    addIndexes() {
        if (this.info.indexes) {
            _.each(this.info.indexes, index => {
                this.addIndex(index);
            });
        }
    }

    /**
     * Add an index
     * @param {object} index
     * @property {array} index.fields - Fields of the index
     * @property {bool} index.unique - Flag of uniqueness of the index
     * @returns {Entity}
     */
    addIndex(index) {
        if (!this.indexes) {
            this.indexes = [];
        }

        index = _.cloneDeep(index);

        assert: index.fields;

        if (!_.isArray(index.fields)) {
            index.fields = [ index.fields ];
        }

        let fields = index.fields; 

        index.fields = _.map(fields, field => {

            let normalizedField = _.camelCase(field);

            if (!this.hasField(normalizedField)) {

                throw new Error(`Index references non-exist field: ${field}, entity: ${this.name}.`);
            }

            return normalizedField;
        });

        index.fields.sort();

        if (this.hasIndexOn(index.fields)) {
            throw new Error(`Index on [${index.fields.join(', ')}] already exist in entity [${this.name}].`);
        }

        this.indexes.push(index);

        return this;
    }

    /**
     * Get a field object by field name or field accesor.
     * @param fieldId
     * @returns {OolongField}
     */
    getEntityAttribute(fieldId) {
        if (fieldId[0] === '$') {
            let token = fieldId.substr(1);

            switch (token) {
                case "key":
                    return this.fields[this.key];

                case 'feature':
                    return this.features;

                default:
                    throw new Error(`Filed accessor "${token}" not supported!`);
            }
        } else {
            if (!this.hasField(fieldId)) {
                throw new Error(`Field "${fieldId}" not exists in entity "${this.name}".`)
            }

            return this.fields[fieldId];
        }
    }

    /**
     * Check whether the entity has a field with given name
     * @param {string} name
     * @returns {boolean}
     */
    hasField(name) {
        if (Array.isArray(name)) {
            return _.every(name, fn => this.hasField(fn));
        }

        return name in this.fields;
    }

    /**
     * Add association, dbms-specific
     * @param {*} name 
     * @param {*} props 
     * @example
     * e.g. mysql
     *  entity - Associated entity name
     *  join - Join type, e.g. INNER, LEFT, RIGHT, OUTER
     *  exclude - Exclude in output columns
     *  alias - Alias 
     *  on - On conditions
     *  dataset - Sub query
     *  assocs - Child associations
     *  optional - Optional
     *  'default' - Default value
     *  list - Is a list
     */
    addAssociation(name, props) {
        if (!this.associations) {
            this.associations = {};
        }    

        if (name in this.associations) {
            throw new Error(`Association "${name}" already exists in entity "${this.name}". Props: ` + JSON.stringify(props));
        }

        this.associations[name] = props;
    }

    /**
     * Add a association field.
     * @param {string} name
     * @param {OolongEntity} destEntity
     * @param {OolongField} destField
     */
    addAssocField(name, destEntity, destField, extraProps) {
        let localField = this.fields[name];

        if (localField) {            
            throw new Error(`Field "${name}" already exists in entity "${this.name}".`);
        }

        let destFieldInfo = _.omit(destField.toJSON(), FunctionalQualifiers);
        Object.assign(destFieldInfo, extraProps);       

        this.addField(name, destFieldInfo);    
        //this.fields[name].displayName = fieldNaming(prefixNaming(destEntity.name, destField.name));   
    }

    /**
     * Add a field into the entity
     * @param {string} name
     * @param {object} rawInfo
     * @returns {Entity}
     */
    addField(name, rawInfo) {        
        if (this.hasField(name)) {
            throw new Error(`Field name [${name}] conflicts in entity [${this.name}].`);
        }

        assert: rawInfo.type;

        let field;

        if (rawInfo instanceof Field) {
            field = rawInfo.clone();
            field.name = name; // todo: displayName
        } else {
            let fullRawInfo = this.linker.trackBackType(this.oolModule, rawInfo);

            field = new Field(name, fullRawInfo);
            field.link();
        }                
        
        this.fields[name] = field;

        if (!this.key) {
            //make the first field as the default key
            this.key = name;
        }

        return this;
    }

    /**
     * Add a feature into the entity, e.g. auto increment id
     * @param {string} name
     * @param {*} feature
     * @param {bool} [allowMultiple=false] - Allow multiple occurrence
     * @returns {Entity}
     */
    addFeature(name, feature, allowMultiple) {
        if (!this.features) {
            this.features = {};
        }

        if (allowMultiple) {
            if (!this.features[name]) {
                this.features[name] = [];
            }

            this.features[name].push(feature);
        } else {
            if (feature.name in this.features) {
                throw new Error(`Duplicate feature found: ${name}. Turn on allowMultiple to enable multiple occurrence of a feature.`);
            }

            this.features[name] = feature;
        }

        return this;
    }

    hasFeature(name) {
        return this.features && (name in this.features);
    }

    /**
     * Set key name
     * @param {string|array.<string>} name - Field name to be used as the key
     * @returns {Entity}
     */
    setKey(name) {
        this.key = name;
        return this;
    }

    /**
     * Returns the association info if there is connection to the given destination entity.
     */
    getReferenceTo(entityName, includes, excludes) {
        return this.info.associations && _.find(
            this.info.associations, assoc => {
                if (includes) {
                    if (_.find(includes, (value, prop) => typeof value === 'function' ? !value(assoc[prop]) : !_.isEqual(assoc[prop], value))) return false;
                }

                if (excludes) {
                    if (excludes.association && assoc === excludes.association) return false;
                    if (excludes.type && assoc.type === excludes.type) return false;
                    if (excludes.associations && excludes.associations.indexOf(assoc) > -1) return false;
                    if (excludes.types && excludes.types.indexOf(assoc.type) > -1) return false;
                    if (excludes.props && _.find(excludes.props, prop => assoc[prop])) return false;
                }

                return assoc.destEntity === entityName;
            }
        );
    }

    /**
     * Get key field 
     * @returns {*}
     */
    getKeyField() {
        return Array.isArray(this.key) ? this.key.map(kf => this.fields[kf]) : this.fields[this.key];
    }

    /**
     * Clone the entity
     * @param {Map} [stack] - Reference stack to avoid recurrence copy
     * @returns {Entity}
     */
    clone() {        
        super.clone();

        let entity = new Entity(this.linker, this.name, this.oolModule, this.info);        

        deepCloneField(this, entity, 'code');
        deepCloneField(this, entity, 'displayName');
        deepCloneField(this, entity, 'comment');
        deepCloneField(this, entity, 'features');
        deepCloneField(this, entity, 'fields');    
        deepCloneField(this, entity, 'associations');        
        deepCloneField(this, entity, 'key');        
        deepCloneField(this, entity, 'indexes');        
        deepCloneField(this, entity, 'interfaces');

        entity.linked = true;

        return entity;
    }
 
    /**
     * Translate the entity into a plain JSON object
     * @returns {object}
     */
    toJSON() {
        return {            
            name: this.name,     
            code: this.code,            
            displayName: this.displayName,
            comment: this.comment,            
            ...(this.baseClasses ? { baseClasses: this.baseClasses } : {}),
            features: this.features,            
            fields: _.mapValues(this.fields, field => field.toJSON()),
            associations: this.associations,
            key: this.key,
            indexes: this.indexes
        };
    }

    _inherit(baseEntity) {  
        let overrideInfo = {};

        if (baseEntity.baseClasses) {
            let baseClasses = baseEntity.baseClasses;

            if (this.baseClasses) {
                this.baseClasses = _.uniq(baseClasses.concat(this.baseClasses));
            } else {
                this.baseClasses = baseClasses.concat();
            }
        }

        if (baseEntity.features) {
            let baseFeatures = deepClone(baseEntity.features);
            this.features = { ...this.features, ...baseFeatures };
        }

        if (baseEntity.fields) {
            let fields = deepClone(baseEntity.fields);
            this.fields = { ...this.fields, ...fields };
        }
        
        deepCloneField(baseEntity, this, 'key');            
        
        if (baseEntity.info.indexes) {
            let indexes = deepClone(baseEntity.info.indexes);

            if (this.info.indexes) {
                indexes = indexes.concat(this.info.indexes);
            }

            overrideInfo.indexes = indexes;
        }        

        if (baseEntity.info.associations) {
            let assocs = deepClone(baseEntity.info.associations);

            assocs = assocs.map(assoc => {
                if (assoc.destEntity === baseEntity.name) {
                    return {
                        ...assoc,
                        destEntity: this.name
                    };
                }

                return assoc;
            });        

            if (this.info.associations) {
                assocs = assocs.concat(this.info.associations);
            }       
            
            overrideInfo.associations = assocs;
        }     

        if (!_.isEmpty(overrideInfo)) {        
            this.info = Object.freeze({ ...this.info, ...overrideInfo });
        }
    }
}

module.exports = Entity;