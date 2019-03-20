const { _ } = require('rk-utils');
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
            this.client = new MongoClient(this.connectionString, {useNewUrlParser: true});
            await this.client.connect();
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
        return this.onCollection_(model, (coll) => coll.insertOne(data, { forceServerObjectId: true, bypassDocumentValidation: true, ...options }));
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
    async upsertOne_(model, data, condition, options) { 
        return this.onCollection_(model, (coll) => coll.updateOne(condition, { $set: data }, { ...options, upsert: true }));
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

            if (condition.$projection) {
                queryOptions.projection = condition.$projection;                
            }

            if (condition.$orderBy) {
                queryOptions.sort = condition.$orderBy;                
            }

            if (condition.$offset) {
                queryOptions.skip = condition.$offset;                
            }

            if (condition.$limit) {
                queryOptions.limit = condition.$limit;                
            }

            let query = condition.$query || {};

            console.log('query', query);

            console.log('queryOptions', queryOptions);

            let result = await coll.find(query, queryOptions).toArray();

            if (condition.$totalCount) {
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