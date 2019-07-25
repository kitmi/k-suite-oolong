const { _, waitUntil_ } = require('rk-utils');
const { tryRequire } = require('@k-suite/app/lib/utils/Helpers');
const mongodb = tryRequire('mongodb');
const MongoClient = mongodb.MongoClient;
const Connector = require('../../Connector');

/**
 * Mongodb data storage connector.
 * @class
 * @extends Connector
 */
class MongodbConnector extends Connector {
    /**          
     * @param {string} name 
     * @param {object} options 
     * @property {boolean} [options.usePreparedStatement] - 
     */
    constructor(connectionString, options) {        
        super('mongodb', connectionString, options);         
    }

    findAll_ = this.find_;

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {
        if (this.client && this.client.isConnected()) {
            this.client.close();
        }

        delete this.client;
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<Db>}
     */
    async connect_() {
        if (!this.client || !this.client.isConnected()) {
            let client = new MongoClient(this.connectionString, {useNewUrlParser: true});
            this.client = await client.connect();
        }       

        return this.client.db(this.database);
    }

    async execute_(dbExecutor) {
        let db;
    
        try {
            db = await this.connect_();

            return await dbExecutor(db);
        } catch(err) {            
            throw err;
        } finally {
            db && await this.disconnect_(db);
        }
    }

    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(conn) {
    }
  
    async ping_() {  
        return this.execute_(db => {
            return db.listCollections(null, { nameOnly: true }).toArray();
        });  
    }

    /**
     * Create a new entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async insertOne_(model, data, options) {
        return this.onCollection_(model, (coll) => coll.insertOne(data, { bypassDocumentValidation: true, ...options }));
    }

    /**
     * Create an array of new entity.
     * @param {string} model 
     * @param {array} data 
     * @param {*} options 
     */
    async insertMany_(model, data, options) {
        return this.onCollection_(model, (coll) => coll.insertMany(data, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    /**
     * Replace (insert or update for exsisting) an entity and return original record.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async findOneAndReplace_(model, data, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOneAndReplace(condition, data, options));
    }

    /**
     * Find a document and update it in one atomic operation. Requires a write lock for the duration of the operation.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async findOneAndUpdate_(model, data, condition, options) {     
        return this.onCollection_(model, (coll) => coll.findOneAndUpdate(condition, { $set: data }, options));
    }

    async findOneAndDelete_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOneAndDelete(condition, options));
    }

    async findOne_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.findOne(condition, options));
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async updateOne_(model, data, condition, options) { 
        return this.onCollection_(model, (coll) => coll.updateOne(condition, { $set: data }, options));
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async upsertOne_(model, data, condition, options, retry) { 
        //walk around mongodb failed to setOnInsert with _id

        return this.onCollection_(model, async (coll) => {
            
            let current = await coll.findOneAndUpdate(condition, { $set: { __lock: true } });
            
            if (current.value) {
                return coll.updateOne({ _id: current.value._id }, { $set: _.omit(data, [ '_id' ]) }, { bypassDocumentValidation: true, ...options });    
            } else {
                try { 
                    return await coll.insertOne(data, { bypassDocumentValidation: true, ...options });
                } catch (error) {                    
                    if (!retry && error.message.startsWith('E11000 duplicate key error')) {
                        return this.upsertOne_(model, data, condition, options, true);
                    }

                    throw error;
                }
            }
            

            /*           

            //if (current.lastErrorObject && current.lastErrorObject.updatedExisting)

            let { _id, ...updateData } = data;
    
            let updateOp = {
                $set: updateData
            };

            if (_id) {
                updateOp.$setOnInsert = { _id };
            }

            console.log(updateOp);

            let ops = [{
                updateOne: { filter: { _id: current._id }, update: updateOp, upsert: true }
            }];
                
            return coll.bulkWrite(ops, { bypassDocumentValidation: true, ordered: false, ...options });
            */
        });        
    }

    /**
    async _spinLock_(model, condition) {
        return waitUntil_(async () => {
            let current = await coll.findOneAndUpdate(condition, { $set: { __lock: true } });
            if (current.)


        }, 1, 5000);        
    } */

    /**
     * Update many entities.
     * @param {string} model 
     * @param {object} data - Array of record with _id
     * @param {*} options 
     */
    async upsertMany_(model, data, uniqueKeys, options) { 
        let ops = data.map(record => {
            let { _id, ...updateData } = record;

            let updateOp = {
                $set: updateData
            };

            if (_id) {
                updateOp.$setOnInsert = { _id };
            }

            return {
                updateOne: { filter: { ..._.pick(record, uniqueKeys) }, update: updateOp, upsert: true }
            };
        });

        return this.onCollection_(model, (coll) => coll.bulkWrite(ops, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    /**
     * Insert many entities if not exist.
     * @param {*} model 
     * @param {*} data 
     * @param {*} uniqueKeys 
     * @param {*} options 
     */
    async insertManyIfNotExist_(model, data, uniqueKeys, options) {
        let ops = data.map(record => ({
            updateOne: { filter: { ..._.pick(record, uniqueKeys) }, update: { $setOnInsert: record }, upsert: true }
        }));

        return this.onCollection_(model, (coll) => coll.bulkWrite(ops, { bypassDocumentValidation: true, ordered: false, ...options }));
    }

    /**
     * Update multiple documents.
     * @param {string} model 
     * @param {*} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async updateMany_(model, data, condition, options) { 
        return this.onCollection_(model, (coll) => coll.updateMany(condition, { $set: data }, options));
    }

    /**
     * Replace an existing entity or create a new one.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async replaceOne_(model, data, condition, options) {  
        return this.onCollection_(model, (coll) => coll.replaceOne(condition, data, options));
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async deleteOne_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.deleteOne(condition, options));
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async deleteMany_(model, condition, options) {
        return this.onCollection_(model, (coll) => coll.deleteMany(condition, options));
    }

    /**
     * Perform select operation.
     * @param {*} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async find_(model, condition, options) {
        return this.onCollection_(model, async coll => {
            let queryOptions = {...options};
            let query = {};

            if (condition) {
                let { $projection, $orderBy, $offset, $limit, $query, ...others } = condition;

                if ($projection) {
                    queryOptions.projection = $projection;                
                }

                if ($orderBy) {
                    queryOptions.sort = $orderBy;                
                }

                if ($offset) {
                    queryOptions.skip = $offset;                
                }

                if ($limit) {
                    queryOptions.limit = $limit;                
                }

                Object.assign(query, _.pickBy(others, (v,k) => k[0] !== '$'));

                if ($query) {
                    Object.assign(query, $query);
                } 
            }

            let result = await coll.find(query, queryOptions).toArray();

            if (condition && condition.$totalCount) {
                let totalCount = await coll.find(query).count();
                return [ result, totalCount ];
            }

            return result;
        });
    }   

    async onCollection_(model, executor) {
        return this.execute_(db => executor(db.collection(model)));
    }
}

module.exports = MongodbConnector;