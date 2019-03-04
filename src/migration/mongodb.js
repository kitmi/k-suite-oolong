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
        
    }

    async _loadData_(data) {
        
    }
}

module.exports = MongoDbMigration;