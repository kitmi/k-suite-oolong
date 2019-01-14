const { pascalCase } = require('rk-utils');

const { Connector, getEntityModelOfDriver } = require('@k-suite/oolong');
const BaseEntityModel = getEntityModelOfDriver('mysql');

class Test {
    constructor(connection, options) {     
        if (typeof connection === 'string') {
            this.connector = Connector.createConnector('mysql', connection, options);
            this._connectorOwner = true;
        } else {  
            assert: connection.driver && connection.connectionString;
            
            this.connector = connection;
            this.i18n = options;
        }

        this._modelCache = {};
    }

    model(entityName) {
        if (this._modelCache[entityName]) return this._modelCache[entityName];

        let modelClassName = pascalCase(entityName);
        if (this._modelCache[modelClassName]) return this._modelCache[modelClassName];

        const entitySpecMixin = require(`./test/${modelClassName}`);        
        let modelClass = entitySpecMixin(this, BaseEntityModel);

        this._modelCache[entityName] = modelClass;
        if (modelClassName !== entityName) {
            this._modelCache[modelClassName] = modelClass;
        }
        
        return modelClass;
    }

    async close_() {
        if (this._connectorOwner) {
            await this.connector.end_();
            delete this._connectorOwner;
        }

        delete this._modelCache;
        delete this.connector;
    }
}

Test.driver = 'mysql';
Test.schemaName = 'test';

module.exports = Test;