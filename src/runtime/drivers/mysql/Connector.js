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
        }        

        let conn = await pool.getConnection();
        this._acitveConnections.set(conn, csKey);
        
        return conn;
    }

    /**
     * Close a database connection.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async disconnect_(conn) {        
        let cs = this.stringFromConnection(conn);
        this._acitveConnections.delete(conn);
        
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
        
        this.log('verbose', 'Begins a new transaction.');
        return conn;
    }

    /**
     * Commit a transaction.
     * @param {MySQLConnection} conn - MySQL connection.
     */
    async commit_(conn) {
        await conn.commit();
        
        this.log('verbose', 'Commits a transaction.');
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
                    this.log('verbose', conn.format(sql, params));
                }

                if (options && options.rowsAsArray) {
                    return await conn.execute({ sql, rowsAsArray: true }, params);
                }

                let [ rows1 ] = await conn.execute(sql, params);                    

                return rows1;
            }

            if (this.options.logSQLStatement) {
                this.log('verbose', conn.format(sql, params));
            }

            if (options && options.rowsAsArray) {
                return await conn.query({ sql, rowsAsArray: true }, params);
            }                

            let [ rows2 ] = await conn.query(sql, params);                    

            return rows2;
        } catch (err) {      
            err.extraInfo || (err.extraInfo = {});
            err.extraInfo.sql = _.truncate(sql, { length: 200 });
            err.extraInfo.params = params;

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
        if (!data || _.isEmpty(data)) {
            throw new OolongUsageError(`Creating with empty "${model}" data.`);
        }

        let sql = 'INSERT INTO ?? SET ?';
        let params = [ model ];
        params.push(data);

        return this.execute_(sql, params, options); 
    }

    insertOne_ = this.create_;

    /**
     * Update an existing entity.
     * @param {string} model 
     * @param {object} data 
     * @param {*} query 
     * @param {*} queryOptions  
     * @param {*} connOptions 
     */
    async update_(model, data, query, queryOptions, connOptions) {    
        if (_.isEmpty(data)) {
            throw new BusinessError('Empty data to update.');
        }
        
        let params = [], aliasMap = { [model]: 'A' }, joinings, hasJoining = false, joiningParams = []; 

        if (queryOptions && queryOptions.$relationships) {                                        
            joinings = this._joinAssociations(queryOptions.$relationships, model, 'A', aliasMap, 1, joiningParams);             
            hasJoining = model;
        }

        let sql = 'UPDATE ' + mysql.escapeId(model);

        if (hasJoining) {
            joiningParams.forEach(p => params.push(p));
            sql += ' A ' + joinings.join(' ');
        }

        if (queryOptions.$requireSplitColumns) {
            sql += ' SET ' + this._splitColumnsAsInput(data, params, hasJoining, aliasMap).join(',');
        } else {
            params.push(data);
            sql += ' SET ?';
        }        

        if (query) {            
            let whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);   
            if (whereClause) {
                sql += ' WHERE ' + whereClause;                
            }                             
        }    

        return this.execute_(sql, params, connOptions);
    }

    updateOne_ = this.update_;

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
     * @param {*} connOptions 
     */
    async find_(model, condition, connOptions) {
        let sqlInfo = this.buildQuery(model, condition);

        let result, totalCount;

        if (sqlInfo.countSql) {            
            let [ countResult ] = await this.execute_(sqlInfo.countSql, sqlInfo.params, connOptions);              
            totalCount = countResult['count'];
        }

        if (sqlInfo.hasJoining) {
            connOptions = { ...connOptions, rowsAsArray: true };
            result = await this.execute_(sqlInfo.sql, sqlInfo.params, connOptions);  
            let reverseAliasMap = _.reduce(sqlInfo.aliasMap, (result, alias, nodePath) => {
                result[alias] = nodePath.split('.').slice(1).map(n => ':' + n);
                return result;
            }, {});
            
            if (sqlInfo.countSql) {
                return result.concat(reverseAliasMap, totalCount);
            }
            
            return result.concat(reverseAliasMap);
        } 

        result = await this.execute_(sqlInfo.sql, sqlInfo.params, connOptions);

        if (sqlInfo.countSql) {
            return [ result, totalCount ];
        }

        return result;
    }

    /**
     * Build sql statement.
     * @param {*} model 
     * @param {*} condition      
     */
    buildQuery(model, { $relationships, $projection, $query, $groupBy, $orderBy, $offset, $limit, $totalCount }) {
        let params = [], aliasMap = { [model]: 'A' }, joinings, hasJoining = false, joiningParams = [];        

        // build alias map first
        // cache params
        if ($relationships) {                                        
            joinings = this._joinAssociations($relationships, model, 'A', aliasMap, 1, joiningParams);             
            hasJoining = model;
        }

        let selectColomns = $projection ? this._buildColumns($projection, params, hasJoining, aliasMap) : '*';

        let sql = ' FROM ' + mysql.escapeId(model);

        // move cached joining params into params
        // should according to the place of clause in a sql        

        if (hasJoining) {
            joiningParams.forEach(p => params.push(p));
            sql += ' A ' + joinings.join(' ');
        }

        if ($query) {            
            let whereClause = this._joinCondition($query, params, null, hasJoining, aliasMap);   
            if (whereClause) {
                sql += ' WHERE ' + whereClause;
            }                             
        }    

        if ($groupBy) {
            sql += ' ' + this._buildGroupBy($groupBy, params, hasJoining, aliasMap);
        }

        if ($orderBy) {
            sql += ' ' + this._buildOrderBy($orderBy, hasJoining, aliasMap);
        }

        let result = { params, hasJoining, aliasMap };        

        if ($totalCount) {
            let countSubject;

            if (typeof $totalCount === 'string') {
                countSubject = 'DISTINCT(' + this._escapeIdWithAlias($totalCount, hasJoining, aliasMap) + ')';
            } else {
                countSubject = '*';
            }

            result.countSql = `SELECT COUNT(${countSubject}) AS count` + sql;
        }

        sql = 'SELECT ' + selectColomns + sql;        

        if (_.isInteger($limit) && $limit > 0) {
            
            if (_.isInteger($offset) && $offset > 0) {            
                sql += ' LIMIT ?, ?';
                params.push($offset);
                params.push($limit);
            } else {
                sql += ' LIMIT ?';
                params.push($limit);
            }            
        } else if (_.isInteger($offset) && $offset > 0) {            
            sql += ' LIMIT ?, 1000';
            params.push($offset);
        }

        result.sql = sql;

        //console.dir(result, { depth: 10, colors: true });
        
        return result;
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

    _generateAlias(index, anchor) {
        let alias = ntol(index);

        if (this.options.verboseAlias) {
            return _.snakeCase(anchor).toUpperCase() + '_' + alias;
        }

        return alias;
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
    _joinAssociations(associations, parentAliasKey, parentAlias, aliasMap, startId, params) {
        let joinings = [];

        //console.log('associations:', Object.keys(associations));

        _.each(associations, (assocInfo, anchor) => { 
            let alias = assocInfo.alias || this._generateAlias(startId++, anchor); 
            let { joinType, on } = assocInfo;

            joinType || (joinType = 'LEFT JOIN');

            if (assocInfo.sql) {
                if (assocInfo.output) {                    
                    aliasMap[parentAliasKey + '.' + alias] = alias; 
                }

                assocInfo.params.forEach(p => params.push(p)); 
                joinings.push(`${joinType} (${assocInfo.sql}) ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);                             
                
                return;
            }

            let { entity, subAssocs } = assocInfo;            
            let aliasKey = parentAliasKey + '.' + anchor;
            aliasMap[aliasKey] = alias; 

            joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
            
            if (subAssocs) {                
                let subJoinings = this._joinAssociations(subAssocs, aliasKey, alias, aliasMap, startId, params);
                startId += subJoinings.length;
                joinings = joinings.concat(subJoinings);
            }
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
     * @param {array} params 
     */
    _joinCondition(condition, params, joinOperator, hasJoining, aliasMap) {
        if (Array.isArray(condition)) {
            if (!joinOperator) {
                joinOperator = 'OR';
            }
            return condition.map(c => '(' + this._joinCondition(c, params, null, hasJoining, aliasMap) + ')').join(` ${joinOperator} `);
        }

        if (_.isPlainObject(condition)) { 
            if (!joinOperator) {
                joinOperator = 'AND';
            }
            
            return _.map(condition, (value, key) => {
                if (key === '$all' || key === '$and') {
                    assert: Array.isArray(value) || _.isPlainObject(value), '"$and" operator value should be an array or plain object.';                    

                    return '(' + this._joinCondition(value, params, 'AND', hasJoining, aliasMap) + ')';
                }
    
                if (key === '$any' || key === '$or' || key.startsWith('$or_')) {
                    assert: Array.isArray(value) || _.isPlainObject(value), '"$or" operator value should be an array or plain object.';       
                    
                    return '(' + this._joinCondition(value, params, 'OR', hasJoining, aliasMap) + ')';
                }

                if (key === '$not') {                    
                    if (Array.isArray(value)) {
                        assert: value.length > 0, '"$not" operator value should be non-empty.';                     

                        return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
                    } 
                    
                    if (_.isPlainObject(value)) {
                        let numOfElement = Object.keys(value).length;   
                        assert: numOfElement > 0, '"$not" operator value should be non-empty.';                     

                        return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
                    } 

                    assert: typeof value === 'string', 'Unsupported condition!';

                    return 'NOT (' + condition + ')';                    
                }                

                return this._wrapCondition(key, value, params, hasJoining, aliasMap);
            }).join(` ${joinOperator} `);
        }

        if (typeof condition !== 'string') {
            throw new Error('Unsupported condition!\n Value: ' + JSON.stringify(condition));
        }

        return condition;
    }

    _replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) {
        let parts = fieldName.split('.');
        if (parts.length > 1) {
            let actualFieldName = parts.pop();
            let alias = aliasMap[mainEntity + '.' + parts.join('.')];
            if (!alias) {
                let msg = `Unknown column reference: ${fieldName}`;
                this.log('debug', msg, aliasMap);
                throw new BusinessError(msg);
            }            

            return alias + '.' + mysql.escapeId(actualFieldName);
        }

        return aliasMap[mainEntity] + '.' + (fieldName === '*' ? fieldName : mysql.escapeId(fieldName));
    }

    _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {   

        if (mainEntity) {
            return this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap); 
        }

        return fieldName === '*' ? fieldName : mysql.escapeId(fieldName);
    }

    _splitColumnsAsInput(data, params, hasJoining, aliasMap) {
        return _.map(data, (v, fieldName) => {
            assert: fieldName.indexOf('.') === -1, 'Column of direct input data cannot be a dot-separated name.';
            
            return mysql.escapeId(fieldName) + '=' + this._packValue(v, params, hasJoining, aliasMap);
        });
    }

    _packArray(array, params, hasJoining, aliasMap) {
        return array.map(value => this._packValue(value, params, hasJoining, aliasMap)).join(',');
    }

    _packValue(value, params, hasJoining, aliasMap) {
        if (_.isPlainObject(value)) {
            if (value.oorType) {
                switch (value.oorType) {
                    case 'ColumnReference':
                        return this._escapeIdWithAlias(value.name, hasJoining, aliasMap);

                    case 'Function':
                        return value.name + '(' + (value.args ? this._packArray(value.args, params, hasJoining, aliasMap) : '') + ')';

                    case 'BinaryExpression':
                        let left = this._packValue(value.left, params, hasJoining, aliasMap);
                        let right = this._packValue(value.right, params, hasJoining, aliasMap);
                        return left + ` ${value.op} ` + right;

                    default:
                        throw new Error(`Unknown oor type: ${value.oorType}`);
                }
            }

            value = JSON.stringify(value);
        }

        params.push(value);
        return '?';
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
     * @param {array} params  
     */
    _wrapCondition(fieldName, value, params, hasJoining, aliasMap, inject) {
        if (_.isNil(value)) {
            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
        }

        if (Array.isArray(value)) {
            return this._wrapCondition(fieldName, { $in: value }, params, hasJoining, aliasMap, inject);
        }       

        if (_.isPlainObject(value)) {
            if (value.oorType) {
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + this._packValue(value, params, hasJoining, aliasMap);
            }            

            let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

            if (hasOperator) {
                return _.map(value, (v, k) => {
                    if (k && k[0] === '$') {
                        // operator
                        switch (k) {
                            case '$eq':
                            case '$equal':
    
                                return this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, inject);
    
                            case '$ne':
                            case '$neq':
                            case '$notEqual':         
    
                                if (_.isNil(v)) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NOT NULL';
                                }          
        
                                if (isPrimitive(v)) {
                                    if (inject) {
                                        return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ' + v;
                                    }

                                    params.push(v);
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';
                                }
    
                                return 'NOT (' + this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, true) + ')';
    
                            case '$>':
                            case '$gt':
                            case '$greaterThan':
    
                                /* // for datetime type
                                if (!_.isFinite(v)) {
                                    v = _.toFinite(v);
                                    if (isNaN(v)) {
                                        throw new Error('Only finite numbers can use "$gt" or "$>" operator.');
                                    }
                                }*/
                                
                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ' + v;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ?';
        
                            case '$>=':
                            case '$gte':
                            case '$greaterThanOrEqual':
                            
                                /* // for datetime type
                                if (!_.isFinite(v)) {
                                    v = _.toFinite(v);
                                    if (isNaN(v)) {
                                        throw new Error('Only finite numbers can use "$gte" or "$>=" operator.');
                                    }
                                }*/

                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ' + v;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ?';
    
                            case '$<':
                            case '$lt':
                            case '$lessThan':
                            
                                /* // for datetime type
                                if (!_.isFinite(v)) {
                                    v = _.toFinite(v);
                                    if (isNaN(v)) {
                                        throw new Error('Only finite numbers can use "$lt" or "$<" operator.');
                                    }
                                }*/

                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ' + v;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ?';
    
                            case '$<=':
                            case '$lte':
                            case '$lessThanOrEqual':
                            
                                /* // for datetime type
                                if (!_.isFinite(v)) {
                                    v = _.toFinite(v);
                                    if (isNaN(v)) {
                                        throw new Error('Only finite numbers can use "$lte" or "$<=" operator.');
                                    }
                                }
                                */

                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ' + v;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ?';
    
                            case '$in':
    
                                if (!Array.isArray(v)) {
                                    throw new Error('The value should be an array when using "$in" operator.');
                                }

                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${v})`;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';
    
                            case '$nin':
                            case '$notIn':
    
                                if (!Array.isArray(v)) {
                                    throw new Error('The value should be an array when using "$in" operator.');
                                }

                                if (inject) {
                                    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${v})`;
                                }
        
                                params.push(v);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';

                            case '$startWith':
                            case '$startsWith':

                                if (typeof v !== 'string') {
                                    throw new Error('The value should be a string when using "$startWith" operator.');
                                }

                                assert: !inject;

                                params.push(`${v}%`);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

                            case '$endWith':
                            case '$endsWith':

                                if (typeof v !== 'string') {
                                    throw new Error('The value should be a string when using "$endWith" operator.');
                                }

                                assert: !inject;

                                params.push(`%${v}`);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

                            case '$like':
                            case '$likes':

                                if (typeof v !== 'string') {
                                    throw new Error('The value should be a string when using "$like" operator.');
                                }

                                assert: !inject;

                                params.push(`%${v}%`);
                                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';
                                /*
                            case '$apply':
                                let args = value.args ? [ fieldName ].concat(value.args) : [ fieldName ];

                                return value.name + '(' + this._buildColumns(col.args, valuesSeq, hasJoining, aliasMap) + ') = '
                                    */
                            default:
                                throw new Error(`Unsupported condition operator: "${k}"!`);
                        }
                    } else {
                        throw new Error('Operator should not be mixed with condition value.');
                    }
                }).join(' AND ');
            }             

            assert: !inject;

            params.push(JSON.stringify(value));
            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
        }

        if (inject) {
            return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + value;
        }
        
        params.push(value);
        return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
    }

    _buildColumns(columns, params, hasJoining, aliasMap) {        
        return _.map(_.castArray(columns), col => this._buildColumn(col, params, hasJoining, aliasMap)).join(', ');
    }

    _buildColumn(col, params, hasJoining, aliasMap) {
        if (typeof col === 'string') {  
            //it's a string if it's quoted when passed in                  
            return isQuoted(col) ? col : this._escapeIdWithAlias(col, hasJoining, aliasMap);
        }

        if (typeof col === 'number') {
            return col;
        }

        if (_.isPlainObject(col)) {                         
            if (col.alias) {
                assert: typeof col.alias === 'string';

                return this._buildColumn(_.omit(col, ['alias']), params, hasJoining, aliasMap) + ' AS ' + mysql.escapeId(col.alias);
            }

            if (col.type === 'function') {
                if (col.name.toUpperCase() === 'COUNT' && col.args.length === 1 && col.args[0] === '*') {
                    return 'COUNT(*)';
                }

                return col.name + '(' + (col.args ? this._buildColumns(col.args, params, hasJoining, aliasMap) : '') + ')';
            }            

            if (col.type === 'expression') {
                return this._joinCondition(col.expr, params, null, hasJoining, aliasMap);
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