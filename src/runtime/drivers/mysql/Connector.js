const { _, eachAsync_, setValueByPath } = require('rk-utils');
const { tryRequire } = require('@k-suite/app/lib/utils/Helpers');
const mysql = tryRequire('mysql2/promise');
const Connector = require('../../Connector');
const { OolongUsageError, BusinessError } = require('../../Errors');
const { isQuoted, isPrimitive } = require('../../../utils/lang');
const ntol = require('number-to-letter');

/**
 * MySQL data storage connector.
 * @class
 * @extends Connector
 */
class MySQLConnector extends Connector {
    /**
     * Transaction isolation level
     * {@link https://dev.mysql.com/doc/refman/8.0/en/innodb-transaction-isolation-levels.html}
     * @member {object}
     */
    static IsolationLevels = Object.freeze({
        RepeatableRead: 'REPEATABLE READ',
        ReadCommitted: 'READ COMMITTED',
        ReadUncommitted: 'READ UNCOMMITTED',
        Rerializable: 'SERIALIZABLE'
    });    
    
    escape = mysql.escape;
    escapeId = mysql.escapeId;
    format = mysql.format;
    raw = mysql.raw;

    /**          
     * @param {string} name 
     * @param {object} options 
     * @property {boolean} [options.usePreparedStatement] - 
     */
    constructor(connectionString, options) {        
        super('mysql', connectionString, options);

        this._pools = {};
        this._acitveConnections = new Map();
    }

    stringFromConnection(conn) {
        post: !conn || it, 'Connection object not found in acitve connections map.'; 
        return this._acitveConnections.get(conn);
    }    

    /**
     * Close all connection initiated by this connector.
     */
    async end_() {
        for (let conn of this._acitveConnections.keys()) {
            await this.disconnect_(conn);
        };

        return eachAsync_(this._pools, async (pool, cs) => {
            await pool.end();
            this.log('debug', 'Closed pool: ' + cs);
        });
    }

    /**
     * Create a database connection based on the default connection string of the connector and given options.     
     * @param {Object} [options] - Extra options for the connection, optional.
     * @property {bool} [options.multipleStatements=false] - Allow running multiple statements at a time.
     * @property {bool} [options.createDatabase=false] - Flag to used when creating a database.
     * @returns {Promise.<MySQLConnection>}
     */
    async connect_(options) {
        let csKey = this.connectionString;

        if (options) {
            let connProps = {};

            if (options.createDatabase) {
                //remove the database from connection
                connProps.database = '';
            }
            
            connProps.options = _.pick(options, ['multipleStatements']);     

            csKey = this.getNewConnectionString(connProps);
        }        

        let pool = this._pools[csKey];

        if (!pool) {                        
            pool = mysql.createPool(csKey);
            this._pools[csKey] = pool;

            this.log('debug', 'Created pool: ' + csKey);
        }        

        let conn = await pool.getConnection();
        this._acitveConnections.set(conn, csKey);

        this.log('debug', 'Create connection: ' + csKey);
        
        return conn;
    }

    /**
     * Close a database connection.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async disconnect_(conn) {        
        let cs = this.stringFromConnection(conn);
        this._acitveConnections.delete(conn);

        this.log('debug', 'Close connection: ' + (cs || '*unknown*'));        
        return conn.release();     
    }

    /**
     * Start a transaction.
     * @param {object} options - Options
     * @property {string} [options.isolationLevel]
     */
    async beginTransaction_(options) {
        let conn = await this.connect_();

        if (options && options.isolationLevel) {
            //only allow valid option value to avoid injection attach
            let isolationLevel = _.find(MySQLConnector.IsolationLevels, (value, key) => options.isolationLevel === key || options.isolationLevel === value);
            if (!isolationLevel) {
                throw new OolongUsageError(`Invalid isolation level: "${isolationLevel}"!"`);
            }

            await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL ' + isolationLevel);            
        }

        await conn.beginTransaction();
        
        this.log('debug', 'Begins a new transaction.');
        return conn;
    }

    /**
     * Commit a transaction.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async commit_(conn) {
        await conn.commit();
        
        this.log('debug', 'Commits a transaction.');
        return this.disconnect_(conn);
    }

    /**
     * Rollback a transaction.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async rollback_(conn) {
        await conn.rollback();
        
        this.log('debug', 'Rollbacks a transaction.');
        return this.disconnect_(conn);
    }

    /**
     * Execute the sql statement.
     *
     * @param {String} sql - The SQL statement to execute.
     * @param {object} params - Parameters to be placed into the SQL statement.
     * @param {object} [options] - Execution options.
     * @property {boolean} [options.usePreparedStatement] - Whether to use prepared statement which is cached and re-used by connection.
     * @property {boolean} [options.rowsAsArray] - To receive rows as array of columns instead of hash with column name as key.
     * @property {MySQLConnection} [options.connection] - Existing connection.
     */
    async execute_(sql, params, options) {        
        let conn;

        try {
            conn = await this._getConnection_(options);

            if (this.options.usePreparedStatement || (options && options.usePreparedStatement)) {
                if (this.options.logSQLStatement) {
                    this.log('verbose', sql, params);
                }

                if (options && options.rowsAsArray) {
                    return await conn.execute({ sql, rowsAsArray: true }, params);
                }

                let [ rows1 ] = await conn.execute(sql, params);                    

                return rows1;
            }

            let formatedSQL = params ? conn.format(sql, params) : sql;

            if (this.options.logSQLStatement) {
                this.log('verbose', formatedSQL);
            }

            if (options && options.rowsAsArray) {
                return await conn.query({ sql: formatedSQL, rowsAsArray: true });
            }                

            let [ rows2 ] = await conn.query(formatedSQL, params);                    

            return rows2;
        } catch (err) {      
            throw err;
        } finally {
            conn && await this._releaseConnection_(conn, options);
        }
    }

    async ping_() {
        let [ ping ] = await this.execute_('SELECT 1 AS result');
        return ping && ping.result === 1;
    }

    /**
     * Create a new entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async create_(model, data, options) {
        let sql = 'INSERT INTO ?? SET ?';
        let params = [ model ];
        params.push(data);

        return this.execute_(sql, params, options); 
    }

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} condition 
     * @param {*} options 
     */
    async update_(model, data, condition, options) {        
        let params = [ model, data ]; 

        let whereClause = this._joinCondition(condition, params);        

        let sql = 'UPDATE ?? SET ? WHERE ' + whereClause;

        return this.execute_(sql, params, options);
    }

    /**
     * Replace an existing entity or create a new one.
     * @param {string} model 
     * @param {object} data 
     * @param {*} options 
     */
    async replace_(model, data, options) {        
        let params = [ model, data ]; 

        let sql = 'REPLACE ?? SET ?';

        return this.execute_(sql, params, options);
    }

    /**
     * Remove an existing entity.
     * @param {string} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async delete_(model, condition, options) {
        let params = [ model ];

        let whereClause = this._joinCondition(condition, params);        

        let sql = 'DELETE FROM ?? WHERE ' + whereClause;
        
        return this.execute_(sql, params, options);
    }

    /**
     * Perform select operation.
     * @param {*} model 
     * @param {*} condition 
     * @param {*} options 
     */
    async find_(model, { $association, $projection, $query, $groupBy, $orderBy, $offset, $limit }, options) {
        let params = [], aliasMap = { [model]: 'A' }, joinings, hasJoining = false;

        if (!_.isEmpty($association)) {            
            joinings = this._joinAssociations($association, model, 'A', aliasMap, 1);
            hasJoining = model;
        }

        let whereClause = $query && this._joinCondition($query, params, null, hasJoining, aliasMap);
        
        let sql = 'SELECT ' + ($projection ? this._buildColumns($projection, hasJoining, aliasMap) : '*') + ' FROM ' + mysql.escapeId(model);

        if (hasJoining) {
            sql += ' A ' + joinings.join(' ');
        }

        if (whereClause) {
            sql += ' WHERE ' + whereClause;
        }

        if ($groupBy) {
            sql += ' ' + this._buildGroupBy($groupBy, hasJoining, aliasMap);
        }

        if ($orderBy) {
            sql += ' ' + this._buildOrderBy($orderBy, hasJoining, aliasMap);
        }

        if (_.isInteger($limit) && $limit > 0) {
            sql += ' LIMIT ?';
            params.push($limit);
        } 

        if (_.isInteger($offset) && $offset > 0) {            
            sql += ' OFFSET ?';
            params.push($offset);
        }

        if (hasJoining) {
            options = { ...options, rowsAsArray: true };
            let result = await this.execute_(sql, params, options);  
            let reverseAliasMap = _.reduce(aliasMap, (result, alias, nodePath) => {
                result[alias] = nodePath.split('.').slice(1).map(n => ':' + n);
                return result;
            }, {});                 
            
            return result.concat(reverseAliasMap);
        }

        return this.execute_(sql, params, options);
    }

    getInsertedId(result) {
        return result && typeof result.insertId === 'number' ?
            result.insertId : 
            undefined;
    }

    getNumOfAffectedRows(result) {
        return result && typeof result.affectedRows === 'number' ?
            result.affectedRows : 
            undefined;
    }

    /**
     * Extract associations into joining clauses.
     *  {
     *      entity: <remote entity>
     *      joinType: 'LEFT JOIN|INNER JOIN|FULL OUTER JOIN'
     *      anchor: 'local property to place the remote entity'
     *      localField: <local field to join>
     *      remoteField: <remote field to join>
     *      subAssociations: { ... }
     *  }
     * 
     * @param {*} associations 
     * @param {*} parentAliasKey 
     * @param {*} parentAlias 
     * @param {*} aliasMap 
     * @param {*} params 
     */
    _joinAssociations(associations, parentAliasKey, parentAlias, aliasMap, startId) {
        let joinings = [];

        _.each(associations, ({ entity, joinType, anchor, localField, remoteField, isList, subAssociations }) => {                
            let alias = ntol(startId++); 
            let aliasKey = parentAliasKey + '.' + anchor;
            aliasMap[aliasKey] = alias; 

            joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`);
            
            let subJoinings = this._joinAssociations(subAssociations, aliasKey, alias, aliasMap, startId);
            startId += subJoinings.length;
            joinings = joinings.concat(subJoinings);
        });

        return joinings;
    }

    /**
     * SQL condition representation
     *   Rules:
     *     default: 
     *        array: OR
     *        kv-pair: AND
     *     $all: 
     *        array: AND
     *     $any:
     *        kv-pair: OR
     *     $not:
     *        array: not ( or )
     *        kv-pair: not ( and )     
     * @param {object} condition 
     * @param {array} valuesSeq 
     */
    _joinCondition(condition, valuesSeq, joinOperator, hasJoining, aliasMap) {
        if (Array.isArray(condition)) {
            if (!joinOperator) {
                joinOperator = 'OR';
            }
            return condition.map(c => this._joinCondition(c, valuesSeq, null, hasJoining, aliasMap)).join(` ${joinOperator} `);
        }

        if (_.isPlainObject(condition)) { 
            if (!joinOperator) {
                joinOperator = 'AND';
            }
            
            return _.map(condition, (value, key) => {
                if (key === '$all' || key === '$and') {
                    assert: Array.isArray(value) || _.isPlainObject(value), '"$and" operator value should be an array or plain object.';                    

                    return this._joinCondition(value, valuesSeq, 'AND', hasJoining, aliasMap);
                }
    
                if (key === '$any' || key === '$or') {
                    assert: Array.isArray(value) || _.isPlainObject(value), '"$or" operator value should be a plain object.';       
                    
                    return this._joinCondition(value, valuesSeq, 'OR', hasJoining, aliasMap);
                }

                if (key === '$not') {                    
                    if (Array.isArray(value)) {
                        assert: value.length > 0, '"$not" operator value should be non-empty.';                     

                        return 'NOT (' + this._joinCondition(value, valuesSeq, null, hasJoining, aliasMap) + ')';
                    } 
                    
                    if (_.isPlainObject(value)) {
                        let numOfElement = Object.keys(value).length;   
                        assert: numOfElement > 0, '"$not" operator value should be non-empty.';                     

                        return 'NOT (' + this._joinCondition(value, valuesSeq, null, hasJoining, aliasMap) + ')';
                    } 

                    assert: typeof value === 'string', 'Unsupported condition!';

                    return 'NOT (' + condition + ')';                    
                }                

                return this._wrapCondition(key, value, valuesSeq, hasJoining, aliasMap);
            }).join(` ${joinOperator} `);
        }

        assert: typeof condition === 'string', 'Unsupported condition!';

        return condition;
    }

    _replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) {
        let parts = fieldName.split('.');
        if (parts.length > 2) {
            let actualFieldName = parts.pop();
            let alias = aliasMap[mainEntity + '.' + parts.join('.')];
            if (!alias) {
                throw new BusinessError(`Unknown column reference: ${fieldName}`);
            }

            return alias + '.' + mysql.escapeId(actualFieldName);
        }

        return 'A.' + mysql.escapeId(fieldName);
    }

    _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
        return (mainEntity ? 
            this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) : 
            mysql.escapeId(fieldName));
    }

    /**
     * Wrap a condition clause     
     * 
     * Value can be a literal or a plain condition object.
     *   1. fieldName, <literal>
     *   2. fieldName, { normal object } 
     * 
     * @param {string} fieldName 
     * @param {*} value 
     * @param {array} valuesSeq  
     */
    _wrapCondition(fieldName, value, valuesSeq, hasJoining, aliasMap) {
        if (_.isNil(value)) {
            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
        }

        if (_.isPlainObject(value)) {
            let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

            if (hasOperator) {
                return _.map(value, (v, k) => {
                    if (k && k[0] === '$') {
                        // operator
                        switch (k) {
                            case '$eq':
                            case '$equal':
    
                            return this._wrapCondition(fieldName, v, valuesSeq, hasJoining, aliasMap);
    
                            case '$ne':
                            case '$neq':
                            case '$notEqual':         
    
                            if (_.isNil(v)) {
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NOT NULL';
                            }          
    
                            if (isPrimitive(v)) {
                                valuesSeq.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';
                            }
    
                            return 'NOT (' + this._wrapCondition(fieldName, v, valuesSeq, hasJoining, aliasMap) + ')';
    
                            case '$>':
                            case '$gt':
                            case '$greaterThan':
    
                            if (!_.isFinite(v)) {
                                throw new Error('Only finite numbers can use "$gt" or "$>" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ?';
    
                            case '$>=':
                            case '$gte':
                            case '$greaterThanOrEqual':
                            
                            if (!_.isFinite(v)) {
                                throw new Error('Only finite numbers can use "$gte" or "$>=" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ?';
    
                            case '$<':
                            case '$lt':
                            case '$lessThan':
                            
                            if (!_.isFinite(v)) {
                                throw new Error('Only finite numbers can use "$gte" or "$<" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ?';
    
                            case '$<=':
                            case '$lte':
                            case '$lessThanOrEqual':
                            
                            if (!_.isFinite(v)) {
                                throw new Error('Only finite numbers can use "$lte" or "$<=" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ?';
    
                            case '$in':
    
                            if (!Array.isArray(v)) {
                                throw new Error('The value should be an array when using "$in" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN ?';
    
                            case '$nin':
                            case '$notIn':
    
                            if (!Array.isArray(v)) {
                                throw new Error('The value should be an array when using "$in" operator.');
                            }
    
                            valuesSeq.push(v);
                            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN ?';
    
                            default:
                            throw new Error(`Unsupported condition operator: "${k}"!`);
                        }
                    } else {
                        throw new Error('Operator should not be mixed with condition value.');
                    }
                }).join(' AND ');
            }  

            valuesSeq.push(JSON.stringify(value));
            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
        }

        valuesSeq.push(value);
        return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
    }

    _buildColumns(columns, hasJoining, aliasMap) {        
        return _.map(_.castArray(columns), col => this._buildColumn(col, hasJoining, aliasMap)).join(', ');
    }

    _buildColumn(col, hasJoining, aliasMap) {
        if (typeof col === 'string') {  
            //it's a string if it's quoted when passed in          
            return (isQuoted(col) || col === '*') ? col : mysql.escapeId(col);
        }

        if (typeof col === 'number') {
            return col;
        }

        if (_.isPlainObject(col)) {
            if (col.alias && typeof col.alias === 'string') {
                return this._buildColumn(_.omit(col, ['alias'])) + ' AS ' + mysql.escapeId(col.alias);
            } 
            
            if (col.type === 'function') {
                return col.name + '(' + (col.args ? this._buildColumns(col.args) : '') + ')';
            }            
        }

        throw new OolongUsageError(`Unknow column syntax: ${JSON.stringify(col)}`);
    }

    _buildGroupBy(groupBy, params, hasJoining, aliasMap) {
        if (typeof groupBy === 'string') return 'GROUP BY ' + this._escapeIdWithAlias(groupBy, hasJoining, aliasMap);

        if (Array.isArray(groupBy)) return 'GROUP BY ' + groupBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');

        if (_.isPlainObject(groupBy)) {
            let { columns, having } = groupBy;

            if (!columns || !Array.isArray(columns)) {
                throw new OolongUsageError(`Invalid group by syntax: ${JSON.stringify(groupBy)}`);
            } 

            let groupByClause = this._buildGroupBy(columns);
            let havingCluse = having && this._joinCondition(having, params, null, hasJoining, aliasMap);
            if (havingCluse) {
                groupByClause += ' HAVING ' + havingCluse;
            }

            return groupByClause;
        }

        throw new OolongUsageError(`Unknown group by syntax: ${JSON.stringify(groupBy)}`);
    }

    _buildOrderBy(orderBy, hasJoining, aliasMap) {
        if (typeof orderBy === 'string') return 'ORDER BY ' + this._escapeIdWithAlias(orderBy, hasJoining, aliasMap);

        if (Array.isArray(orderBy)) return 'ORDER BY ' + orderBy.map(by => this._escapeIdWithAlias(by, hasJoining, aliasMap)).join(', ');

        if (_.isPlainObject(orderBy)) {
            return 'ORDER BY ' + _.map(orderBy, (asc, col) => this._escapeIdWithAlias(col, hasJoining, aliasMap) + (asc ? '' : ' DESC')).join(', '); 
        }

        throw new OolongUsageError(`Unknown order by syntax: ${JSON.stringify(orderBy)}`);
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

module.exports = MySQLConnector;