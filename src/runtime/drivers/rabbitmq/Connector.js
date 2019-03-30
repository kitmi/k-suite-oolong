const { _ } = require('rk-utils');
const { tryRequire } = require('@k-suite/app/lib/utils/Helpers');
const AmqpNode = tryRequire('amqplib');
const Connector = require('../../Connector');

/**
 * Rabbitmq data storage connector.
 * @class
 * @extends Connector
 */
class RabbitmqConnector extends Connector {
    /**          
     * @param {string} name 
     * @param {object} options 
     * @property {boolean} [options.usePreparedStatement] - 
     */
    constructor(connectionString, options) {        
        super('rabbitmq', connectionString, options);         
    }

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {
        if (this.ch) {
            await this.ch.close();
        }

        delete this.ch;

        if (this.conn) {
            await this.conn.close();
        }

        delete this.conn;
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<Db>}
     */
    async connect_() {
        if (!this.conn) {
            this.conn = await AmqpNode.connect(this.connectionString);
        }        

        if (!this.ch) {
            this.ch = await this.conn.createChannel();
        }

        return this.ch;
    }

    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(conn) {

    }
  
    async sendToQueue_(queueName, obj) {
        if (typeof obj !== 'string') {
            obj = JSON.stringify(obj);
        }

        let ch = await this.connect_();
        await ch.assertQueue(queueName);
        return ch.sendToQueue(queueName, Buffer.from(obj));
    }   
}

module.exports = RabbitmqConnector;