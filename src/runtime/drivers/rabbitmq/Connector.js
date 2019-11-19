const { Promise } = require('rk-utils');
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
            this.conn.on('close', () => {
                delete this.ch;
                delete this.conn;
            });

            this.conn.on('error', () => {
                delete this.ch;
                delete this.conn;
            });
        }        

        if (!this.ch) {
            this.ch = await this.conn.createChannel();
            this.ch.on('close', () => {
                delete this.ch;
            });
        }

        return this.ch;
    }

    /**
     * Close a database connection.
     * @param {Db} conn - MySQL connection.
     */
    async disconnect_(conn) {
    }
  
    async sendToQueue_(queueName, obj, options) {
        if (typeof obj !== 'string') {
            obj = JSON.stringify(obj);
        }

        let ch = await this.connect_();        
        await ch.assertQueue(queueName, {
            durable: true
        });
        let ret = ch.sendToQueue(queueName, Buffer.from(obj), {
            persistent: true,
            ...options
        });

        this.log('info', `Sent to MQ[${queueName}]`, { msg: obj });

        return ret;
    }   

    async consume_(queueName, consumerMethod, options) {        
        let ch = await this.connect_();
        await ch.assertQueue(queueName, {
            durable: true
        });

        await ch.prefetch(1);

        return ch.consume(queueName, (msg) => consumerMethod(ch, msg), options);
    }
}

module.exports = RabbitmqConnector;