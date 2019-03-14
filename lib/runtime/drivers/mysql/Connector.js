"use strict";

require("source-map-support/register");

const {
  _,
  eachAsync_,
  setValueByPath
} = require('rk-utils');

const {
  tryRequire
} = require('@k-suite/app/lib/utils/Helpers');

const mysql = tryRequire('mysql2/promise');

const Connector = require('../../Connector');

const {
  OolongUsageError,
  BusinessError
} = require('../../Errors');

const {
  isQuoted,
  isPrimitive
} = require('../../../utils/lang');

const ntol = require('number-to-letter');

class MySQLConnector extends Connector {
  constructor(connectionString, options) {
    super('mysql', connectionString, options);
    this.escape = mysql.escape;
    this.escapeId = mysql.escapeId;
    this.format = mysql.format;
    this.raw = mysql.raw;
    this._pools = {};
    this._acitveConnections = new Map();
  }

  stringFromConnection(conn) {
    const _checkPostcondition = it => {
      if (!(!conn || it)) {
        throw new Error('Connection object not found in acitve connections map.');
      }

      return it;
    };

    return _checkPostcondition(this._acitveConnections.get(conn));
  }

  async end_() {
    for (let conn of this._acitveConnections.keys()) {
      await this.disconnect_(conn);
    }

    ;
    return eachAsync_(this._pools, async (pool, cs) => {
      await pool.end();
      this.log('debug', 'Closed pool: ' + cs);
    });
  }

  async connect_(options) {
    let csKey = this.connectionString;

    if (options) {
      let connProps = {};

      if (options.createDatabase) {
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

  async disconnect_(conn) {
    let cs = this.stringFromConnection(conn);

    this._acitveConnections.delete(conn);

    this.log('debug', 'Close connection: ' + (cs || '*unknown*'));
    return conn.release();
  }

  async beginTransaction_(options) {
    let conn = await this.connect_();

    if (options && options.isolationLevel) {
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

  async commit_(conn) {
    await conn.commit();
    this.log('debug', 'Commits a transaction.');
    return this.disconnect_(conn);
  }

  async rollback_(conn) {
    await conn.rollback();
    this.log('debug', 'Rollbacks a transaction.');
    return this.disconnect_(conn);
  }

  async execute_(sql, params, options) {
    let conn;

    try {
      conn = await this._getConnection_(options);

      if (this.options.usePreparedStatement || options && options.usePreparedStatement) {
        if (this.options.logSQLStatement) {
          this.log('verbose', sql, params);
        }

        if (options && options.rowsAsArray) {
          return await conn.execute({
            sql,
            rowsAsArray: true
          }, params);
        }

        let [rows1] = await conn.execute(sql, params);
        return rows1;
      }

      let formatedSQL = params ? conn.format(sql, params) : sql;

      if (this.options.logSQLStatement) {
        this.log('verbose', formatedSQL);
      }

      if (options && options.rowsAsArray) {
        return await conn.query({
          sql: formatedSQL,
          rowsAsArray: true
        });
      }

      let [rows2] = await conn.query(formatedSQL, params);
      return rows2;
    } catch (err) {
      throw err;
    } finally {
      conn && (await this._releaseConnection_(conn, options));
    }
  }

  async ping_() {
    let [ping] = await this.execute_('SELECT 1 AS result');
    return ping && ping.result === 1;
  }

  async create_(model, data, options) {
    if (!data || _.isEmpty(data)) {
      throw new OolongUsageError(`Creating with empty "${model}" data.`);
    }

    let sql = 'INSERT INTO ?? SET ?';
    let params = [model];
    params.push(data);
    return this.execute_(sql, params, options);
  }

  async update_(model, data, query, queryOptions, options) {
    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false,
        joiningParams = [];

    if (queryOptions && queryOptions.$association) {
      joinings = this._joinAssociations(queryOptions.$association, model, 'A', aliasMap, 1, joiningParams);
      hasJoining = model;
    }

    let sql = 'UPDATE ' + mysql.escapeId(model);

    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
      sql += ' A ' + joinings.join(' ');
    }

    params.push(data);
    sql += ' SET ?';

    if (query) {
      let whereClause = this._joinCondition(query, params, null, hasJoining, aliasMap);

      if (whereClause) {
        sql += ' WHERE ' + whereClause;
      }
    }

    return this.execute_(sql, params, options);
  }

  async replace_(model, data, options) {
    let params = [model, data];
    let sql = 'REPLACE ?? SET ?';
    return this.execute_(sql, params, options);
  }

  async delete_(model, condition, options) {
    let params = [model];

    let whereClause = this._joinCondition(condition, params);

    let sql = 'DELETE FROM ?? WHERE ' + whereClause;
    return this.execute_(sql, params, options);
  }

  async find_(model, condition, options) {
    let sqlInfo = this.buildQuery(model, condition);
    let result, totalCount;

    if (sqlInfo.countSql) {
      let [countResult] = await this.execute_(sqlInfo.countSql, sqlInfo.params, options);
      totalCount = countResult['count'];
    }

    if (sqlInfo.hasJoining) {
      options = { ...options,
        rowsAsArray: true
      };
      result = await this.execute_(sqlInfo.sql, sqlInfo.params, options);

      let reverseAliasMap = _.reduce(sqlInfo.aliasMap, (result, alias, nodePath) => {
        result[alias] = nodePath.split('.').slice(1).map(n => ':' + n);
        return result;
      }, {});

      if (sqlInfo.countSql) {
        return result.concat(reverseAliasMap, totalCount);
      }

      return result.concat(reverseAliasMap);
    }

    result = await this.execute_(sqlInfo.sql, sqlInfo.params, options);

    if (sqlInfo.countSql) {
      return [result, totalCount];
    }

    return result;
  }

  buildQuery(model, {
    $association,
    $projection,
    $query,
    $groupBy,
    $orderBy,
    $offset,
    $limit,
    $totalCount
  }) {
    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false,
        joiningParams = [];

    if ($association) {
      joinings = this._joinAssociations($association, model, 'A', aliasMap, 1, joiningParams);
      hasJoining = model;
    }

    let selectColomns = $projection ? this._buildColumns($projection, params, hasJoining, aliasMap) : '*';
    let sql = ' FROM ' + mysql.escapeId(model);

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

    let result = {
      params,
      hasJoining,
      aliasMap
    };

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
    return result;
  }

  getInsertedId(result) {
    return result && typeof result.insertId === 'number' ? result.insertId : undefined;
  }

  getNumOfAffectedRows(result) {
    return result && typeof result.affectedRows === 'number' ? result.affectedRows : undefined;
  }

  _generateAlias(index, anchor) {
    let alias = ntol(index);

    if (this.options.verboseAlias) {
      return _.snakeCase(anchor).toUpperCase() + '_' + alias;
    }

    return alias;
  }

  _joinAssociations(associations, parentAliasKey, parentAlias, aliasMap, startId, params) {
    let joinings = [];

    _.each(associations, (assocInfo, anchor) => {
      let alias = assocInfo.alias || this._generateAlias(startId++, anchor);

      let {
        joinType,
        on
      } = assocInfo;
      joinType || (joinType = 'LEFT JOIN');

      if (assocInfo.sql) {
        if (assocInfo.output) {
          aliasMap[parentAliasKey + '.' + alias] = alias;
        }

        assocInfo.params.forEach(p => params.push(p));
        joinings.push(`${joinType} (${assocInfo.sql}) ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
        return;
      }

      let {
        entity,
        subAssocs
      } = assocInfo;
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
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$and" operator value should be an array or plain object.');
          }

          return '(' + this._joinCondition(value, params, 'AND', hasJoining, aliasMap) + ')';
        }

        if (key === '$any' || key === '$or') {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$or" operator value should be a plain object.');
          }

          return '(' + this._joinCondition(value, params, 'OR', hasJoining, aliasMap) + ')';
        }

        if (key === '$not') {
          if (Array.isArray(value)) {
            if (!(value.length > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }

          if (_.isPlainObject(value)) {
            let numOfElement = Object.keys(value).length;

            if (!(numOfElement > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, params, null, hasJoining, aliasMap) + ')';
          }

          if (!(typeof value === 'string')) {
            throw new Error('Unsupported condition!');
          }

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

    return aliasMap[mainEntity] + '.' + mysql.escapeId(fieldName);
  }

  _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
    if (mainEntity) {
      return this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap);
    }

    return mysql.escapeId(fieldName);
  }

  _wrapCondition(fieldName, value, valuesSeq, hasJoining, aliasMap, inject) {
    if (_.isNil(value)) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
    }

    if (_.isPlainObject(value)) {
      if (value.oorType) {
        if (value.oorType === 'ColumnReference') {
          return this._wrapCondition(fieldName, this._escapeIdWithAlias(value.name, hasJoining, aliasMap), valuesSeq, hasJoining, aliasMap, true);
        }

        throw new Error('todo: add oorType support: ' + value.oorType);
      }

      let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

      if (hasOperator) {
        return _.map(value, (v, k) => {
          if (k && k[0] === '$') {
            switch (k) {
              case '$eq':
              case '$equal':
                return this._wrapCondition(fieldName, v, valuesSeq, hasJoining, aliasMap, inject);

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

                  valuesSeq.push(v);
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';
                }

                return 'NOT (' + this._wrapCondition(fieldName, v, valuesSeq, hasJoining, aliasMap, true) + ')';

              case '$>':
              case '$gt':
              case '$greaterThan':
                if (!_.isFinite(v)) {
                  v = _.toFinite(v);

                  if (isNaN(v)) {
                    throw new Error('Only finite numbers can use "$gt" or "$>" operator.');
                  }
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ' + v;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' > ?';

              case '$>=':
              case '$gte':
              case '$greaterThanOrEqual':
                if (!_.isFinite(v)) {
                  v = _.toFinite(v);

                  if (isNaN(v)) {
                    throw new Error('Only finite numbers can use "$gte" or "$>=" operator.');
                  }
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ' + v;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' >= ?';

              case '$<':
              case '$lt':
              case '$lessThan':
                if (!_.isFinite(v)) {
                  v = _.toFinite(v);

                  if (isNaN(v)) {
                    throw new Error('Only finite numbers can use "$lt" or "$<" operator.');
                  }
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ' + v;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' < ?';

              case '$<=':
              case '$lte':
              case '$lessThanOrEqual':
                if (!_.isFinite(v)) {
                  v = _.toFinite(v);

                  if (isNaN(v)) {
                    throw new Error('Only finite numbers can use "$lte" or "$<=" operator.');
                  }
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ' + v;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ?';

              case '$in':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${v})`;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';

              case '$nin':
              case '$notIn':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${v})`;
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';

              case '$startWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$startWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                valuesSeq.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$endWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                valuesSeq.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$like':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$like" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                valuesSeq.push(`%${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              default:
                throw new Error(`Unsupported condition operator: "${k}"!`);
            }
          } else {
            throw new Error('Operator should not be mixed with condition value.');
          }
        }).join(' AND ');
      }

      if (!!inject) {
        throw new Error("Assertion failed: !inject");
      }

      valuesSeq.push(JSON.stringify(value));
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
    }

    if (inject) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + value;
    }

    valuesSeq.push(value);
    return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
  }

  _buildColumns(columns, params, hasJoining, aliasMap) {
    return _.map(_.castArray(columns), col => this._buildColumn(col, params, hasJoining, aliasMap)).join(', ');
  }

  _buildColumn(col, params, hasJoining, aliasMap) {
    if (typeof col === 'string') {
      return isQuoted(col) || col === '*' ? col : this._escapeIdWithAlias(col, hasJoining, aliasMap);
    }

    if (typeof col === 'number') {
      return col;
    }

    if (_.isPlainObject(col)) {
      if (col.alias) {
        if (!(typeof col.alias === 'string')) {
          throw new Error("Assertion failed: typeof col.alias === 'string'");
        }

        return this._buildColumn(_.omit(col, ['alias']), params, hasJoining, aliasMap) + ' AS ' + mysql.escapeId(col.alias);
      }

      if (col.type === 'function') {
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
      let {
        columns,
        having
      } = groupBy;

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
    return options && options.connection ? options.connection : this.connect_(options);
  }

  async _releaseConnection_(conn, options) {
    if (!options || !options.connection) {
      return this.disconnect_(conn);
    }
  }

}

MySQLConnector.IsolationLevels = Object.freeze({
  RepeatableRead: 'REPEATABLE READ',
  ReadCommitted: 'READ COMMITTED',
  ReadUncommitted: 'READ UNCOMMITTED',
  Rerializable: 'SERIALIZABLE'
});
module.exports = MySQLConnector;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInVwZGF0ZV8iLCJxdWVyeU9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkYXNzb2NpYXRpb24iLCJfam9pbkFzc29jaWF0aW9ucyIsImZvckVhY2giLCJwIiwiam9pbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJjb25kaXRpb24iLCJmaW5kXyIsInNxbEluZm8iLCJidWlsZFF1ZXJ5IiwidG90YWxDb3VudCIsImNvdW50U3FsIiwiY291bnRSZXN1bHQiLCJyZXZlcnNlQWxpYXNNYXAiLCJyZWR1Y2UiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm1hcCIsIm4iLCJjb25jYXQiLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImxlbmd0aCIsImpvaW5PcGVyYXRvciIsIkFycmF5IiwiaXNBcnJheSIsImMiLCJpc1BsYWluT2JqZWN0IiwibnVtT2ZFbGVtZW50IiwiT2JqZWN0IiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsImZpZWxkTmFtZSIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsIm1zZyIsInZhbHVlc1NlcSIsImluamVjdCIsImlzTmlsIiwib29yVHlwZSIsIm5hbWUiLCJoYXNPcGVyYXRvciIsImsiLCJ2IiwiaXNGaW5pdGUiLCJ0b0Zpbml0ZSIsImlzTmFOIiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsIm9taXQiLCJ0eXBlIiwiYXJncyIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXNDTCxPQUFPLENBQUMs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ZWdDLE9BQWYsQ0FBd0IsRUFBekUsQ0FBTjtBQUNIOztBQUVELFFBQU1sSSxlQUFOLENBQXNCOUMsT0FBdEIsRUFBK0I7QUFDM0IsV0FBUUEsT0FBTyxJQUFJQSxPQUFPLENBQUNrTCxVQUFwQixHQUFrQ2xMLE9BQU8sQ0FBQ2tMLFVBQTFDLEdBQXVELEtBQUsvSixRQUFMLENBQWNuQixPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXVELG1CQUFOLENBQTBCOUMsSUFBMUIsRUFBZ0NULE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQ2tMLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS3BLLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDtBQUNKOztBQXAyQmtDOztBQUFqQ1osYyxDQU1LcUMsZSxHQUFrQjBHLE1BQU0sQ0FBQ3VDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQWkyQjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI1TCxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnSU5TRVJUIElOVE8gPz8gU0VUID8nO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJGFzc29jaWF0aW9uKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuXG4gICAgICAgIGlmIChxdWVyeSkge1xuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRhc3NvY2lhdGlvbiwgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRhc3NvY2lhdGlvbikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkge1xuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihyZXN1bHQsIHsgZGVwdGg6IDEwLCBjb2xvcnM6IHRydWUgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICAvL2NvbnNvbGUubG9nKCdhc3NvY2lhdGlvbnM6JywgT2JqZWN0LmtleXMoYXNzb2NpYXRpb25zKSk7XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7IFxuXG4gICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NzLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYSBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW21haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gO1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIG1zZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKG1zZyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIF9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gdmFsdWVzU2VxICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdDb2x1bW5SZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBhZGQgb29yVHlwZSBzdXBwb3J0OiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ID8nO1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdFwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZXNTZXEucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiAoaXNRdW90ZWQoY29sKSB8fCBjb2wgPT09ICcqJykgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID8gJycgOiAnIERFU0MnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19