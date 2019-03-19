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

    if (queryOptions && queryOptions.$relationships) {
      joinings = this._joinAssociations(queryOptions.$relationships, model, 'A', aliasMap, 1, joiningParams);
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
    $relationships,
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

    if ($relationships) {
      joinings = this._joinAssociations($relationships, model, 'A', aliasMap, 1, joiningParams);
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

    return aliasMap[mainEntity] + '.' + (fieldName === '*' ? fieldName : mysql.escapeId(fieldName));
  }

  _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
    if (mainEntity) {
      return this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap);
    }

    return fieldName === '*' ? fieldName : mysql.escapeId(fieldName);
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
      return isQuoted(col) ? col : this._escapeIdWithAlias(col, hasJoining, aliasMap);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInVwZGF0ZV8iLCJxdWVyeU9wdGlvbnMiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImpvaW5pbmdQYXJhbXMiLCIkcmVsYXRpb25zaGlwcyIsIl9qb2luQXNzb2NpYXRpb25zIiwiZm9yRWFjaCIsInAiLCJqb2luIiwid2hlcmVDbGF1c2UiLCJfam9pbkNvbmRpdGlvbiIsInJlcGxhY2VfIiwiZGVsZXRlXyIsImNvbmRpdGlvbiIsImZpbmRfIiwic3FsSW5mbyIsImJ1aWxkUXVlcnkiLCJ0b3RhbENvdW50IiwiY291bnRTcWwiLCJjb3VudFJlc3VsdCIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsImFsaWFzIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwibWFwIiwibiIsImNvbmNhdCIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCIkdG90YWxDb3VudCIsInNlbGVjdENvbG9tbnMiLCJfYnVpbGRDb2x1bW5zIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc0ludGVnZXIiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsIl9nZW5lcmF0ZUFsaWFzIiwiaW5kZXgiLCJhbmNob3IiLCJ2ZXJib3NlQWxpYXMiLCJzbmFrZUNhc2UiLCJ0b1VwcGVyQ2FzZSIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImFzc29jSW5mbyIsImpvaW5UeXBlIiwib24iLCJvdXRwdXQiLCJlbnRpdHkiLCJzdWJBc3NvY3MiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwibGVuZ3RoIiwiam9pbk9wZXJhdG9yIiwiQXJyYXkiLCJpc0FycmF5IiwiYyIsImlzUGxhaW5PYmplY3QiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwidmFsdWVzU2VxIiwiaW5qZWN0IiwiaXNOaWwiLCJvb3JUeXBlIiwibmFtZSIsImhhc09wZXJhdG9yIiwiayIsInYiLCJpc0Zpbml0ZSIsInRvRmluaXRlIiwiaXNOYU4iLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwib21pdCIsInR5cGUiLCJhcmdzIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBc0NMLE9BQU8sQ0FB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QUFFRCxVQUFNLElBQUlsRixnQkFBSixDQUFzQiw0QkFBMkJ1SixJQUFJLENBQUNDLFNBQUwsQ0FBZWdDLE9BQWYsQ0FBd0IsRUFBekUsQ0FBTjtBQUNIOztBQUVELFFBQU1sSSxlQUFOLENBQXNCOUMsT0FBdEIsRUFBK0I7QUFDM0IsV0FBUUEsT0FBTyxJQUFJQSxPQUFPLENBQUNrTCxVQUFwQixHQUFrQ2xMLE9BQU8sQ0FBQ2tMLFVBQTFDLEdBQXVELEtBQUsvSixRQUFMLENBQWNuQixPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXVELG1CQUFOLENBQTBCOUMsSUFBMUIsRUFBZ0NULE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQ2tMLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS3BLLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDtBQUNKOztBQXAyQmtDOztBQUFqQ1osYyxDQU1LcUMsZSxHQUFrQjBHLE1BQU0sQ0FBQ3VDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQWkyQjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUI1TCxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIWRhdGEgfHwgXy5pc0VtcHR5KGRhdGEpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgQ3JlYXRpbmcgd2l0aCBlbXB0eSBcIiR7bW9kZWx9XCIgZGF0YS5gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnSU5TRVJUIElOVE8gPz8gU0VUID8nO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG4gICAgICAgIHNxbCArPSAnIFNFVCA/JztcblxuICAgICAgICBpZiAocXVlcnkpIHtcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0RFTEVURSBGUk9NID8/IFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgb3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7ICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChzcWxJbmZvLmhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IC4uLm9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7ICBcbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShzcWxJbmZvLmFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS5tYXAobiA9PiAnOicgKyBuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIG9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHtcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgLy9jb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGEgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9YDtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBtc2csIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBmaWVsZE5hbWUgPT09ICcqJyA/IGZpZWxkTmFtZSA6IG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHZhbHVlc1NlcSAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnQ29sdW1uUmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYWRkIG9vclR5cGUgc3VwcG9ydDogJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKSArICcpJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJD49XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDwgPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDw9JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHRlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckaW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElOICg/KSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5pbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBOT1QgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGVuZFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChgJSR7dn1gKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2UnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgdmFsdWVzU2VxLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiBjb2wubmFtZSArICcoJyArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA/ICcnIDogJyBERVNDJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==