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
     * @returns {Promise.<MySQLConnection>}
     */
    async connect_(options) {
        if (!this.client || !this.client.isConnected()) {
            this.client = new MongoClient(this.connectionString, {useNewUrlParser: true});
            await this.client.connect();

            this.log('debug', 'Create connection: ' + this.connectionString);
        }        

        return this.client.db(this.database);
    }

    async execute_(dbExecutor, options) {
        let db;
    
        try {
            db = await this._getConnection_(options);

            return await dbExecutor(db);
        } catch(err) {            
            throw err;
        } finally {
            db && await this._releaseConnection_(db, options);
        }
    }

    /**
     * Close a database connection.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async disconnect_(conn) {
    }
  
    async ping_() {  
        let db;

        try {
            db =  await this.connect_();
            await db.listCollections(null, { nameOnly: true }).toArray();
            return true;
        } catch (err) {
            this.log('error', err.stack);
            return false;
        } finally {
            db && await this.disconnect_(db);
        }       
    }

    /**
     * Create a new entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async insertOne_(model, data, options) {
        return this._execute_(model, options, (coll) => coll.insertOne(data, { forceServerObjectId: true, bypassDocumentValidation: true }));
    }

    /**
     * Replace (insert or update for exsisting) an entity and return original record.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async findAndReplace_(model, data, condition, options) {
        return this._execute_(model, options, (coll) => coll.findAndReplace(condition, data, { upsert: true, returnOriginal: true }));
    }

    async findOne_(model, condition, options) {
        return this._execute_(model, options, (coll) => coll.findOne(condition));
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async updateOne_(model, data, condition, options) { 
        return this._execute_(model, options, (coll) => coll.updateOne(condition, { $set: data }));
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async upsertOne_(model, data, condition, options) { 
        return this._execute_(model, options, (coll) => coll.updateOne(condition, { $set: data }, {upsert: true}));
    }

    /**
     * Replace an existing entity or create a new one.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async replaceOne_(model, data, condition, options) {  
        return this._execute_(model, options, (coll) => coll.replaceOne(condition, data));
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async deleteOne_(model, condition, options) {
        return this._execute_(model, options, (coll) => coll.deleteOne(condition));
    }

    /**
     * Perform select operation.
     * @param {*} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async find_(model, condition, options) {
        let db;

        try {
            db = await this._getConnection_(options);

            let queryOptions = {};

            console.log(condition);

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

            let result = await db.collection(model).find(query, queryOptions).toArray();

            if (condition.$totalCount) {
                let totalCount = await db.collection(model).find(query).count();
                return [ result, totalCount ];
            }

            return result;
        } catch(err) {
            this.log('error', err.message, { stack: err.stack });
        } finally {
            db && await this._releaseConnection_(db, options);
        }
    }   

    async _execute_(model, options, executor) {
        let db;
    
        try {
            db = await this._getConnection_(options);

            return await executor(db.collection(model));
        } catch(err) {            
            throw err;
        } finally {
            db && await this._releaseConnection_(db, options);
        }
    }

    async _getConnection_(options) {
        return (options && options.connection) ? options.connection : this.connect_(options);
    }

    async _releaseConnection_(conn, options) {
        if (!options || !options.connection) {
            return this.disconnect_(conn);
        }
    }
}

module.exports = MongodbConnector;