"use strict";

const path = require('path');
const { _, fs, eachAsync_, pascalCase, quote } = require('rk-utils');

/**
 * MySQL migration.
 * @class
 */
class MongoDbMigration {
    /**     
     * @param {object} context
     * @param {Connector} connector
     */
    constructor(context, schemaName, connector) {
        this.logger = context.logger;
        this.modelPath = context.modelPath;
        this.scriptSourcePath = context.scriptSourcePath;
        this.schemaName = schemaName;
        this.connector = connector;

        this.dbScriptPath = path.join(this.scriptSourcePath, this.connector.driver, this.connector.database);
    }

    async reset_() {
        return this.connector.execute_(db => db.dropDatabase());
    }

    async create_(extraOptions) {        
        
    }

    async load_(dataFile) {
        let ext = path.extname(dataFile);
        let collection = path.basename(dataFile, ext);

        if (ext === '.json') {
            let docs = fs.readJsonSync(dataFile, {encoding: 'utf8'});

            await this._loadData_(collection, docs);
        } else {
            throw new Error('Unsupported data file format.');
        }
    }

    async _loadData_(collection, docs) { 
        await eachAsync_(docs, doc => this.connector.insertOne_(collection, doc));
    }
}

module.exports = MongoDbMigration;