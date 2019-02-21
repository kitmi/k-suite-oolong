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
    let sql = 'INSERT INTO ?? SET ?';
    let params = [model];
    params.push(data);
    return this.execute_(sql, params, options);
  }

  async update_(model, data, condition, options) {
    let params = [model, data];

    let whereClause = this._joinCondition(condition, params);

    let sql = 'UPDATE ?? SET ? WHERE ' + whereClause;
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

    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
    }

    let whereClause;

    if ($query) {
      whereClause = this._joinCondition($query, params, null, hasJoining, aliasMap);
    }

    let sql = ' FROM ' + mysql.escapeId(model);

    if (hasJoining) {
      sql += ' A ' + joinings.join(' ');
    }

    if (whereClause) {
      sql += ' WHERE ' + whereClause;
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
      sql += ' LIMIT ?';
      params.push($limit);
    }

    if (_.isInteger($offset) && $offset > 0) {
      sql += ' OFFSET ?';
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
          aliasMap[parentAliasKey + '.:' + alias] = alias;
        }

        joinings.push(`${joinType} (${assocInfo.sql}) ${alias} ON ${this._joinCondition(on, params, null, parentAliasKey, aliasMap)}`);
        assocInfo.params.forEach(p => params.push(p));
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

    if (!(typeof condition === 'string')) {
      throw new Error('Unsupported condition!');
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
                  throw new Error('Only finite numbers can use "$gt" or "$>" operator.');
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
                  throw new Error('Only finite numbers can use "$gte" or "$>=" operator.');
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
                  throw new Error('Only finite numbers can use "$gte" or "$<" operator.');
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
                  throw new Error('Only finite numbers can use "$lte" or "$<=" operator.');
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsInNxbEluZm8iLCJidWlsZFF1ZXJ5IiwidG90YWxDb3VudCIsImNvdW50U3FsIiwiY291bnRSZXN1bHQiLCJoYXNKb2luaW5nIiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXNNYXAiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm1hcCIsIm4iLCJjb25jYXQiLCIkYXNzb2NpYXRpb24iLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJqb2luaW5ncyIsImpvaW5pbmdQYXJhbXMiLCJfam9pbkFzc29jaWF0aW9ucyIsInNlbGVjdENvbG9tbnMiLCJfYnVpbGRDb2x1bW5zIiwiZm9yRWFjaCIsInAiLCJqb2luIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc0ludGVnZXIiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsIl9nZW5lcmF0ZUFsaWFzIiwiaW5kZXgiLCJhbmNob3IiLCJ2ZXJib3NlQWxpYXMiLCJzbmFrZUNhc2UiLCJ0b1VwcGVyQ2FzZSIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImFzc29jSW5mbyIsImpvaW5UeXBlIiwib24iLCJvdXRwdXQiLCJlbnRpdHkiLCJzdWJBc3NvY3MiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwibGVuZ3RoIiwiam9pbk9wZXJhdG9yIiwiQXJyYXkiLCJpc0FycmF5IiwiYyIsImlzUGxhaW5PYmplY3QiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwidmFsdWVzU2VxIiwiaW5qZWN0IiwiaXNOaWwiLCJvb3JUeXBlIiwibmFtZSIsIkVycm9yIiwiaGFzT3BlcmF0b3IiLCJrIiwidiIsImlzRmluaXRlIiwiSlNPTiIsInN0cmluZ2lmeSIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJvbWl0IiwidHlwZSIsImFyZ3MiLCJleHByIiwiZ3JvdXBCeSIsImJ5IiwiaGF2aW5nIiwiZ3JvdXBCeUNsYXVzZSIsImhhdmluZ0NsdXNlIiwib3JkZXJCeSIsImFzYyIsImNvbm5lY3Rpb24iLCJmcmVlemUiLCJSZXBlYXRhYmxlUmVhZCIsIlJlYWRDb21taXR0ZWQiLCJSZWFkVW5jb21taXR0ZWQiLCJSZXJpYWxpemFibGUiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DQyxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBaUJELE9BQU8sQ0FBQyxnQ0FBRCxDQUE5Qjs7QUFDQSxNQUFNRSxLQUFLLEdBQUdELFVBQVUsQ0FBQyxnQkFBRCxDQUF4Qjs7QUFDQSxNQUFNRSxTQUFTLEdBQUdILE9BQU8sQ0FBQyxpQkFBRCxDQUF6Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFzQ0wsT0FBTyxDQUFDLGNBQUQsQ0FBbkQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxxQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQXVCbkNPLEVBQUFBLFdBQVcsQ0FBQ0MsZ0JBQUQsRUFBbUJDLE9BQW5CLEVBQTRCO0FBQ25DLFVBQU0sT0FBTixFQUFlRCxnQkFBZixFQUFpQ0MsT0FBakM7QUFEbUMsU0FWdkNDLE1BVXVDLEdBVjlCWCxLQUFLLENBQUNXLE1BVXdCO0FBQUEsU0FUdkNDLFFBU3VDLEdBVDVCWixLQUFLLENBQUNZLFFBU3NCO0FBQUEsU0FSdkNDLE1BUXVDLEdBUjlCYixLQUFLLENBQUNhLE1BUXdCO0FBQUEsU0FQdkNDLEdBT3VDLEdBUGpDZCxLQUFLLENBQUNjLEdBTzJCO0FBR25DLFNBQUtDLE1BQUwsR0FBYyxFQUFkO0FBQ0EsU0FBS0Msa0JBQUwsR0FBMEIsSUFBSUMsR0FBSixFQUExQjtBQUNIOztBQUVEQyxFQUFBQSxvQkFBb0IsQ0FBQ0MsSUFBRCxFQUFPO0FBQUE7QUFBQSxZQUNqQixDQUFDQSxJQUFELElBQVNDLEVBRFE7QUFBQSx3QkFDSix3REFESTtBQUFBOztBQUFBO0FBQUE7O0FBRXZCLCtCQUFPLEtBQUtKLGtCQUFMLENBQXdCSyxHQUF4QixDQUE0QkYsSUFBNUIsQ0FBUDtBQUNIOztBQUtELFFBQU1HLElBQU4sR0FBYTtBQUNULFNBQUssSUFBSUgsSUFBVCxJQUFpQixLQUFLSCxrQkFBTCxDQUF3Qk8sSUFBeEIsRUFBakIsRUFBaUQ7QUFDN0MsWUFBTSxLQUFLQyxXQUFMLENBQWlCTCxJQUFqQixDQUFOO0FBQ0g7O0FBQUE7QUFFRCxXQUFPdkIsVUFBVSxDQUFDLEtBQUttQixNQUFOLEVBQWMsT0FBT1UsSUFBUCxFQUFhQyxFQUFiLEtBQW9CO0FBQy9DLFlBQU1ELElBQUksQ0FBQ0UsR0FBTCxFQUFOO0FBQ0EsV0FBS0MsR0FBTCxDQUFTLE9BQVQsRUFBa0Isa0JBQWtCRixFQUFwQztBQUNILEtBSGdCLENBQWpCO0FBSUg7O0FBU0QsUUFBTUcsUUFBTixDQUFlbkIsT0FBZixFQUF3QjtBQUNwQixRQUFJb0IsS0FBSyxHQUFHLEtBQUtyQixnQkFBakI7O0FBRUEsUUFBSUMsT0FBSixFQUFhO0FBQ1QsVUFBSXFCLFNBQVMsR0FBRyxFQUFoQjs7QUFFQSxVQUFJckIsT0FBTyxDQUFDc0IsY0FBWixFQUE0QjtBQUV4QkQsUUFBQUEsU0FBUyxDQUFDRSxRQUFWLEdBQXFCLEVBQXJCO0FBQ0g7O0FBRURGLE1BQUFBLFNBQVMsQ0FBQ3JCLE9BQVYsR0FBb0JmLENBQUMsQ0FBQ3VDLElBQUYsQ0FBT3hCLE9BQVAsRUFBZ0IsQ0FBQyxvQkFBRCxDQUFoQixDQUFwQjtBQUVBb0IsTUFBQUEsS0FBSyxHQUFHLEtBQUtLLHNCQUFMLENBQTRCSixTQUE1QixDQUFSO0FBQ0g7O0FBRUQsUUFBSU4sSUFBSSxHQUFHLEtBQUtWLE1BQUwsQ0FBWWUsS0FBWixDQUFYOztBQUVBLFFBQUksQ0FBQ0wsSUFBTCxFQUFXO0FBQ1BBLE1BQUFBLElBQUksR0FBR3pCLEtBQUssQ0FBQ29DLFVBQU4sQ0FBaUJOLEtBQWpCLENBQVA7QUFDQSxXQUFLZixNQUFMLENBQVllLEtBQVosSUFBcUJMLElBQXJCO0FBRUEsV0FBS0csR0FBTCxDQUFTLE9BQVQsRUFBa0IsbUJBQW1CRSxLQUFyQztBQUNIOztBQUVELFFBQUlYLElBQUksR0FBRyxNQUFNTSxJQUFJLENBQUNZLGFBQUwsRUFBakI7O0FBQ0EsU0FBS3JCLGtCQUFMLENBQXdCc0IsR0FBeEIsQ0FBNEJuQixJQUE1QixFQUFrQ1csS0FBbEM7O0FBRUEsU0FBS0YsR0FBTCxDQUFTLE9BQVQsRUFBa0Isd0JBQXdCRSxLQUExQztBQUVBLFdBQU9YLElBQVA7QUFDSDs7QUFNRCxRQUFNSyxXQUFOLENBQWtCTCxJQUFsQixFQUF3QjtBQUNwQixRQUFJTyxFQUFFLEdBQUcsS0FBS1Isb0JBQUwsQ0FBMEJDLElBQTFCLENBQVQ7O0FBQ0EsU0FBS0gsa0JBQUwsQ0FBd0J1QixNQUF4QixDQUErQnBCLElBQS9COztBQUVBLFNBQUtTLEdBQUwsQ0FBUyxPQUFULEVBQWtCLHdCQUF3QkYsRUFBRSxJQUFJLFdBQTlCLENBQWxCO0FBQ0EsV0FBT1AsSUFBSSxDQUFDcUIsT0FBTCxFQUFQO0FBQ0g7O0FBT0QsUUFBTUMsaUJBQU4sQ0FBd0IvQixPQUF4QixFQUFpQztBQUM3QixRQUFJUyxJQUFJLEdBQUcsTUFBTSxLQUFLVSxRQUFMLEVBQWpCOztBQUVBLFFBQUluQixPQUFPLElBQUlBLE9BQU8sQ0FBQ2dDLGNBQXZCLEVBQXVDO0FBRW5DLFVBQUlBLGNBQWMsR0FBRy9DLENBQUMsQ0FBQ2dELElBQUYsQ0FBT3BDLGNBQWMsQ0FBQ3FDLGVBQXRCLEVBQXVDLENBQUNDLEtBQUQsRUFBUUMsR0FBUixLQUFnQnBDLE9BQU8sQ0FBQ2dDLGNBQVIsS0FBMkJJLEdBQTNCLElBQWtDcEMsT0FBTyxDQUFDZ0MsY0FBUixLQUEyQkcsS0FBcEgsQ0FBckI7O0FBQ0EsVUFBSSxDQUFDSCxjQUFMLEVBQXFCO0FBQ2pCLGNBQU0sSUFBSXhDLGdCQUFKLENBQXNCLDZCQUE0QndDLGNBQWUsS0FBakUsQ0FBTjtBQUNIOztBQUVELFlBQU12QixJQUFJLENBQUM0QixLQUFMLENBQVcsNkNBQTZDTCxjQUF4RCxDQUFOO0FBQ0g7O0FBRUQsVUFBTXZCLElBQUksQ0FBQzZCLGdCQUFMLEVBQU47QUFFQSxTQUFLcEIsR0FBTCxDQUFTLE9BQVQsRUFBa0IsMkJBQWxCO0FBQ0EsV0FBT1QsSUFBUDtBQUNIOztBQU1ELFFBQU04QixPQUFOLENBQWM5QixJQUFkLEVBQW9CO0FBQ2hCLFVBQU1BLElBQUksQ0FBQytCLE1BQUwsRUFBTjtBQUVBLFNBQUt0QixHQUFMLENBQVMsT0FBVCxFQUFrQix3QkFBbEI7QUFDQSxXQUFPLEtBQUtKLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDs7QUFNRCxRQUFNZ0MsU0FBTixDQUFnQmhDLElBQWhCLEVBQXNCO0FBQ2xCLFVBQU1BLElBQUksQ0FBQ2lDLFFBQUwsRUFBTjtBQUVBLFNBQUt4QixHQUFMLENBQVMsT0FBVCxFQUFrQiwwQkFBbEI7QUFDQSxXQUFPLEtBQUtKLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDs7QUFZRCxRQUFNa0MsUUFBTixDQUFlQyxHQUFmLEVBQW9CQyxNQUFwQixFQUE0QjdDLE9BQTVCLEVBQXFDO0FBQ2pDLFFBQUlTLElBQUo7O0FBRUEsUUFBSTtBQUNBQSxNQUFBQSxJQUFJLEdBQUcsTUFBTSxLQUFLcUMsZUFBTCxDQUFxQjlDLE9BQXJCLENBQWI7O0FBRUEsVUFBSSxLQUFLQSxPQUFMLENBQWErQyxvQkFBYixJQUFzQy9DLE9BQU8sSUFBSUEsT0FBTyxDQUFDK0Msb0JBQTdELEVBQW9GO0FBQ2hGLFlBQUksS0FBSy9DLE9BQUwsQ0FBYWdELGVBQWpCLEVBQWtDO0FBQzlCLGVBQUs5QixHQUFMLENBQVMsU0FBVCxFQUFvQjBCLEdBQXBCLEVBQXlCQyxNQUF6QjtBQUNIOztBQUVELFlBQUk3QyxPQUFPLElBQUlBLE9BQU8sQ0FBQ2lELFdBQXZCLEVBQW9DO0FBQ2hDLGlCQUFPLE1BQU14QyxJQUFJLENBQUN5QyxPQUFMLENBQWE7QUFBRU4sWUFBQUEsR0FBRjtBQUFPSyxZQUFBQSxXQUFXLEVBQUU7QUFBcEIsV0FBYixFQUF5Q0osTUFBekMsQ0FBYjtBQUNIOztBQUVELFlBQUksQ0FBRU0sS0FBRixJQUFZLE1BQU0xQyxJQUFJLENBQUN5QyxPQUFMLENBQWFOLEdBQWIsRUFBa0JDLE1BQWxCLENBQXRCO0FBRUEsZUFBT00sS0FBUDtBQUNIOztBQUVELFVBQUlDLFdBQVcsR0FBR1AsTUFBTSxHQUFHcEMsSUFBSSxDQUFDTixNQUFMLENBQVl5QyxHQUFaLEVBQWlCQyxNQUFqQixDQUFILEdBQThCRCxHQUF0RDs7QUFFQSxVQUFJLEtBQUs1QyxPQUFMLENBQWFnRCxlQUFqQixFQUFrQztBQUM5QixhQUFLOUIsR0FBTCxDQUFTLFNBQVQsRUFBb0JrQyxXQUFwQjtBQUNIOztBQUVELFVBQUlwRCxPQUFPLElBQUlBLE9BQU8sQ0FBQ2lELFdBQXZCLEVBQW9DO0FBQ2hDLGVBQU8sTUFBTXhDLElBQUksQ0FBQzRCLEtBQUwsQ0FBVztBQUFFTyxVQUFBQSxHQUFHLEVBQUVRLFdBQVA7QUFBb0JILFVBQUFBLFdBQVcsRUFBRTtBQUFqQyxTQUFYLENBQWI7QUFDSDs7QUFFRCxVQUFJLENBQUVJLEtBQUYsSUFBWSxNQUFNNUMsSUFBSSxDQUFDNEIsS0FBTCxDQUFXZSxXQUFYLEVBQXdCUCxNQUF4QixDQUF0QjtBQUVBLGFBQU9RLEtBQVA7QUFDSCxLQTlCRCxDQThCRSxPQUFPQyxHQUFQLEVBQVk7QUFDVixZQUFNQSxHQUFOO0FBQ0gsS0FoQ0QsU0FnQ1U7QUFDTjdDLE1BQUFBLElBQUksS0FBSSxNQUFNLEtBQUs4QyxtQkFBTCxDQUF5QjlDLElBQXpCLEVBQStCVCxPQUEvQixDQUFWLENBQUo7QUFDSDtBQUNKOztBQUVELFFBQU13RCxLQUFOLEdBQWM7QUFDVixRQUFJLENBQUVDLElBQUYsSUFBVyxNQUFNLEtBQUtkLFFBQUwsQ0FBYyxvQkFBZCxDQUFyQjtBQUNBLFdBQU9jLElBQUksSUFBSUEsSUFBSSxDQUFDQyxNQUFMLEtBQWdCLENBQS9CO0FBQ0g7O0FBUUQsUUFBTUMsT0FBTixDQUFjQyxLQUFkLEVBQXFCQyxJQUFyQixFQUEyQjdELE9BQTNCLEVBQW9DO0FBQ2hDLFFBQUk0QyxHQUFHLEdBQUcsc0JBQVY7QUFDQSxRQUFJQyxNQUFNLEdBQUcsQ0FBRWUsS0FBRixDQUFiO0FBQ0FmLElBQUFBLE1BQU0sQ0FBQ2lCLElBQVAsQ0FBWUQsSUFBWjtBQUVBLFdBQU8sS0FBS2xCLFFBQUwsQ0FBY0MsR0FBZCxFQUFtQkMsTUFBbkIsRUFBMkI3QyxPQUEzQixDQUFQO0FBQ0g7O0FBU0QsUUFBTStELE9BQU4sQ0FBY0gsS0FBZCxFQUFxQkMsSUFBckIsRUFBMkJHLFNBQTNCLEVBQXNDaEUsT0FBdEMsRUFBK0M7QUFDM0MsUUFBSTZDLE1BQU0sR0FBRyxDQUFFZSxLQUFGLEVBQVNDLElBQVQsQ0FBYjs7QUFFQSxRQUFJSSxXQUFXLEdBQUcsS0FBS0MsY0FBTCxDQUFvQkYsU0FBcEIsRUFBK0JuQixNQUEvQixDQUFsQjs7QUFFQSxRQUFJRCxHQUFHLEdBQUcsMkJBQTJCcUIsV0FBckM7QUFFQSxXQUFPLEtBQUt0QixRQUFMLENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCN0MsT0FBM0IsQ0FBUDtBQUNIOztBQVFELFFBQU1tRSxRQUFOLENBQWVQLEtBQWYsRUFBc0JDLElBQXRCLEVBQTRCN0QsT0FBNUIsRUFBcUM7QUFDakMsUUFBSTZDLE1BQU0sR0FBRyxDQUFFZSxLQUFGLEVBQVNDLElBQVQsQ0FBYjtBQUVBLFFBQUlqQixHQUFHLEdBQUcsa0JBQVY7QUFFQSxXQUFPLEtBQUtELFFBQUwsQ0FBY0MsR0FBZCxFQUFtQkMsTUFBbkIsRUFBMkI3QyxPQUEzQixDQUFQO0FBQ0g7O0FBUUQsUUFBTW9FLE9BQU4sQ0FBY1IsS0FBZCxFQUFxQkksU0FBckIsRUFBZ0NoRSxPQUFoQyxFQUF5QztBQUNyQyxRQUFJNkMsTUFBTSxHQUFHLENBQUVlLEtBQUYsQ0FBYjs7QUFFQSxRQUFJSyxXQUFXLEdBQUcsS0FBS0MsY0FBTCxDQUFvQkYsU0FBcEIsRUFBK0JuQixNQUEvQixDQUFsQjs7QUFFQSxRQUFJRCxHQUFHLEdBQUcsMEJBQTBCcUIsV0FBcEM7QUFFQSxXQUFPLEtBQUt0QixRQUFMLENBQWNDLEdBQWQsRUFBbUJDLE1BQW5CLEVBQTJCN0MsT0FBM0IsQ0FBUDtBQUNIOztBQVFELFFBQU1xRSxLQUFOLENBQVlULEtBQVosRUFBbUJJLFNBQW5CLEVBQThCaEUsT0FBOUIsRUFBdUM7QUFDbkMsUUFBSXNFLE9BQU8sR0FBRyxLQUFLQyxVQUFMLENBQWdCWCxLQUFoQixFQUF1QkksU0FBdkIsQ0FBZDtBQUVBLFFBQUlOLE1BQUosRUFBWWMsVUFBWjs7QUFFQSxRQUFJRixPQUFPLENBQUNHLFFBQVosRUFBc0I7QUFDbEIsVUFBSSxDQUFFQyxXQUFGLElBQWtCLE1BQU0sS0FBSy9CLFFBQUwsQ0FBYzJCLE9BQU8sQ0FBQ0csUUFBdEIsRUFBZ0NILE9BQU8sQ0FBQ3pCLE1BQXhDLEVBQWdEN0MsT0FBaEQsQ0FBNUI7QUFDQXdFLE1BQUFBLFVBQVUsR0FBR0UsV0FBVyxDQUFDLE9BQUQsQ0FBeEI7QUFDSDs7QUFFRCxRQUFJSixPQUFPLENBQUNLLFVBQVosRUFBd0I7QUFDcEIzRSxNQUFBQSxPQUFPLEdBQUcsRUFBRSxHQUFHQSxPQUFMO0FBQWNpRCxRQUFBQSxXQUFXLEVBQUU7QUFBM0IsT0FBVjtBQUNBUyxNQUFBQSxNQUFNLEdBQUcsTUFBTSxLQUFLZixRQUFMLENBQWMyQixPQUFPLENBQUMxQixHQUF0QixFQUEyQjBCLE9BQU8sQ0FBQ3pCLE1BQW5DLEVBQTJDN0MsT0FBM0MsQ0FBZjs7QUFDQSxVQUFJNEUsZUFBZSxHQUFHM0YsQ0FBQyxDQUFDNEYsTUFBRixDQUFTUCxPQUFPLENBQUNRLFFBQWpCLEVBQTJCLENBQUNwQixNQUFELEVBQVNxQixLQUFULEVBQWdCQyxRQUFoQixLQUE2QjtBQUMxRXRCLFFBQUFBLE1BQU0sQ0FBQ3FCLEtBQUQsQ0FBTixHQUFnQkMsUUFBUSxDQUFDQyxLQUFULENBQWUsR0FBZixFQUFvQkMsS0FBcEIsQ0FBMEIsQ0FBMUIsRUFBNkJDLEdBQTdCLENBQWlDQyxDQUFDLElBQUksTUFBTUEsQ0FBNUMsQ0FBaEI7QUFDQSxlQUFPMUIsTUFBUDtBQUNILE9BSHFCLEVBR25CLEVBSG1CLENBQXRCOztBQUtBLFVBQUlZLE9BQU8sQ0FBQ0csUUFBWixFQUFzQjtBQUNsQixlQUFPZixNQUFNLENBQUMyQixNQUFQLENBQWNULGVBQWQsRUFBK0JKLFVBQS9CLENBQVA7QUFDSDs7QUFFRCxhQUFPZCxNQUFNLENBQUMyQixNQUFQLENBQWNULGVBQWQsQ0FBUDtBQUNIOztBQUVEbEIsSUFBQUEsTUFBTSxHQUFHLE1BQU0sS0FBS2YsUUFBTCxDQUFjMkIsT0FBTyxDQUFDMUIsR0FBdEIsRUFBMkIwQixPQUFPLENBQUN6QixNQUFuQyxFQUEyQzdDLE9BQTNDLENBQWY7O0FBRUEsUUFBSXNFLE9BQU8sQ0FBQ0csUUFBWixFQUFzQjtBQUNsQixhQUFPLENBQUVmLE1BQUYsRUFBVWMsVUFBVixDQUFQO0FBQ0g7O0FBRUQsV0FBT2QsTUFBUDtBQUNIOztBQU9EYSxFQUFBQSxVQUFVLENBQUNYLEtBQUQsRUFBUTtBQUFFMEIsSUFBQUEsWUFBRjtBQUFnQkMsSUFBQUEsV0FBaEI7QUFBNkJDLElBQUFBLE1BQTdCO0FBQXFDQyxJQUFBQSxRQUFyQztBQUErQ0MsSUFBQUEsUUFBL0M7QUFBeURDLElBQUFBLE9BQXpEO0FBQWtFQyxJQUFBQSxNQUFsRTtBQUEwRUMsSUFBQUE7QUFBMUUsR0FBUixFQUFpRztBQUN2RyxRQUFJaEQsTUFBTSxHQUFHLEVBQWI7QUFBQSxRQUFpQmlDLFFBQVEsR0FBRztBQUFFLE9BQUNsQixLQUFELEdBQVM7QUFBWCxLQUE1QjtBQUFBLFFBQThDa0MsUUFBOUM7QUFBQSxRQUF3RG5CLFVBQVUsR0FBRyxLQUFyRTtBQUFBLFFBQTRFb0IsYUFBYSxHQUFHLEVBQTVGOztBQUlBLFFBQUlULFlBQUosRUFBa0I7QUFDZFEsTUFBQUEsUUFBUSxHQUFHLEtBQUtFLGlCQUFMLENBQXVCVixZQUF2QixFQUFxQzFCLEtBQXJDLEVBQTRDLEdBQTVDLEVBQWlEa0IsUUFBakQsRUFBMkQsQ0FBM0QsRUFBOERpQixhQUE5RCxDQUFYO0FBQ0FwQixNQUFBQSxVQUFVLEdBQUdmLEtBQWI7QUFDSDs7QUFFRCxRQUFJcUMsYUFBYSxHQUFHVixXQUFXLEdBQUcsS0FBS1csYUFBTCxDQUFtQlgsV0FBbkIsRUFBZ0MxQyxNQUFoQyxFQUF3QzhCLFVBQXhDLEVBQW9ERyxRQUFwRCxDQUFILEdBQW1FLEdBQWxHOztBQUlBLFFBQUlILFVBQUosRUFBZ0I7QUFDWm9CLE1BQUFBLGFBQWEsQ0FBQ0ksT0FBZCxDQUFzQkMsQ0FBQyxJQUFJdkQsTUFBTSxDQUFDaUIsSUFBUCxDQUFZc0MsQ0FBWixDQUEzQjtBQUNIOztBQUVELFFBQUluQyxXQUFKOztBQUVBLFFBQUl1QixNQUFKLEVBQVk7QUFDUnZCLE1BQUFBLFdBQVcsR0FBRyxLQUFLQyxjQUFMLENBQW9Cc0IsTUFBcEIsRUFBNEIzQyxNQUE1QixFQUFvQyxJQUFwQyxFQUEwQzhCLFVBQTFDLEVBQXNERyxRQUF0RCxDQUFkO0FBQ0g7O0FBRUQsUUFBSWxDLEdBQUcsR0FBRyxXQUFXdEQsS0FBSyxDQUFDWSxRQUFOLENBQWUwRCxLQUFmLENBQXJCOztBQUVBLFFBQUllLFVBQUosRUFBZ0I7QUFDWi9CLE1BQUFBLEdBQUcsSUFBSSxRQUFRa0QsUUFBUSxDQUFDTyxJQUFULENBQWMsR0FBZCxDQUFmO0FBQ0g7O0FBRUQsUUFBSXBDLFdBQUosRUFBaUI7QUFDYnJCLE1BQUFBLEdBQUcsSUFBSSxZQUFZcUIsV0FBbkI7QUFDSDs7QUFFRCxRQUFJd0IsUUFBSixFQUFjO0FBQ1Y3QyxNQUFBQSxHQUFHLElBQUksTUFBTSxLQUFLMEQsYUFBTCxDQUFtQmIsUUFBbkIsRUFBNkI1QyxNQUE3QixFQUFxQzhCLFVBQXJDLEVBQWlERyxRQUFqRCxDQUFiO0FBQ0g7O0FBRUQsUUFBSVksUUFBSixFQUFjO0FBQ1Y5QyxNQUFBQSxHQUFHLElBQUksTUFBTSxLQUFLMkQsYUFBTCxDQUFtQmIsUUFBbkIsRUFBNkJmLFVBQTdCLEVBQXlDRyxRQUF6QyxDQUFiO0FBQ0g7O0FBRUQsUUFBSXBCLE1BQU0sR0FBRztBQUFFYixNQUFBQSxNQUFGO0FBQVU4QixNQUFBQSxVQUFWO0FBQXNCRyxNQUFBQTtBQUF0QixLQUFiOztBQUVBLFFBQUllLFdBQUosRUFBaUI7QUFDYixVQUFJVyxZQUFKOztBQUVBLFVBQUksT0FBT1gsV0FBUCxLQUF1QixRQUEzQixFQUFxQztBQUNqQ1csUUFBQUEsWUFBWSxHQUFHLGNBQWMsS0FBS0Msa0JBQUwsQ0FBd0JaLFdBQXhCLEVBQXFDbEIsVUFBckMsRUFBaURHLFFBQWpELENBQWQsR0FBMkUsR0FBMUY7QUFDSCxPQUZELE1BRU87QUFDSDBCLFFBQUFBLFlBQVksR0FBRyxHQUFmO0FBQ0g7O0FBRUQ5QyxNQUFBQSxNQUFNLENBQUNlLFFBQVAsR0FBbUIsZ0JBQWUrQixZQUFhLFlBQTdCLEdBQTJDNUQsR0FBN0Q7QUFDSDs7QUFFREEsSUFBQUEsR0FBRyxHQUFHLFlBQVlxRCxhQUFaLEdBQTRCckQsR0FBbEM7O0FBRUEsUUFBSTNELENBQUMsQ0FBQ3lILFNBQUYsQ0FBWWQsTUFBWixLQUF1QkEsTUFBTSxHQUFHLENBQXBDLEVBQXVDO0FBQ25DaEQsTUFBQUEsR0FBRyxJQUFJLFVBQVA7QUFDQUMsTUFBQUEsTUFBTSxDQUFDaUIsSUFBUCxDQUFZOEIsTUFBWjtBQUNIOztBQUVELFFBQUkzRyxDQUFDLENBQUN5SCxTQUFGLENBQVlmLE9BQVosS0FBd0JBLE9BQU8sR0FBRyxDQUF0QyxFQUF5QztBQUNyQy9DLE1BQUFBLEdBQUcsSUFBSSxXQUFQO0FBQ0FDLE1BQUFBLE1BQU0sQ0FBQ2lCLElBQVAsQ0FBWTZCLE9BQVo7QUFDSDs7QUFFRGpDLElBQUFBLE1BQU0sQ0FBQ2QsR0FBUCxHQUFhQSxHQUFiO0FBRUEsV0FBT2MsTUFBUDtBQUNIOztBQUVEaUQsRUFBQUEsYUFBYSxDQUFDakQsTUFBRCxFQUFTO0FBQ2xCLFdBQU9BLE1BQU0sSUFBSSxPQUFPQSxNQUFNLENBQUNrRCxRQUFkLEtBQTJCLFFBQXJDLEdBQ0hsRCxNQUFNLENBQUNrRCxRQURKLEdBRUhDLFNBRko7QUFHSDs7QUFFREMsRUFBQUEsb0JBQW9CLENBQUNwRCxNQUFELEVBQVM7QUFDekIsV0FBT0EsTUFBTSxJQUFJLE9BQU9BLE1BQU0sQ0FBQ3FELFlBQWQsS0FBK0IsUUFBekMsR0FDSHJELE1BQU0sQ0FBQ3FELFlBREosR0FFSEYsU0FGSjtBQUdIOztBQUVERyxFQUFBQSxjQUFjLENBQUNDLEtBQUQsRUFBUUMsTUFBUixFQUFnQjtBQUMxQixRQUFJbkMsS0FBSyxHQUFHbkYsSUFBSSxDQUFDcUgsS0FBRCxDQUFoQjs7QUFFQSxRQUFJLEtBQUtqSCxPQUFMLENBQWFtSCxZQUFqQixFQUErQjtBQUMzQixhQUFPbEksQ0FBQyxDQUFDbUksU0FBRixDQUFZRixNQUFaLEVBQW9CRyxXQUFwQixLQUFvQyxHQUFwQyxHQUEwQ3RDLEtBQWpEO0FBQ0g7O0FBRUQsV0FBT0EsS0FBUDtBQUNIOztBQW1CRGlCLEVBQUFBLGlCQUFpQixDQUFDc0IsWUFBRCxFQUFlQyxjQUFmLEVBQStCQyxXQUEvQixFQUE0QzFDLFFBQTVDLEVBQXNEMkMsT0FBdEQsRUFBK0Q1RSxNQUEvRCxFQUF1RTtBQUNwRixRQUFJaUQsUUFBUSxHQUFHLEVBQWY7O0FBRUE3RyxJQUFBQSxDQUFDLENBQUN5SSxJQUFGLENBQU9KLFlBQVAsRUFBcUIsQ0FBQ0ssU0FBRCxFQUFZVCxNQUFaLEtBQXVCO0FBQ3hDLFVBQUluQyxLQUFLLEdBQUc0QyxTQUFTLENBQUM1QyxLQUFWLElBQW1CLEtBQUtpQyxjQUFMLENBQW9CUyxPQUFPLEVBQTNCLEVBQStCUCxNQUEvQixDQUEvQjs7QUFDQSxVQUFJO0FBQUVVLFFBQUFBLFFBQUY7QUFBWUMsUUFBQUE7QUFBWixVQUFtQkYsU0FBdkI7QUFFQUMsTUFBQUEsUUFBUSxLQUFLQSxRQUFRLEdBQUcsV0FBaEIsQ0FBUjs7QUFFQSxVQUFJRCxTQUFTLENBQUMvRSxHQUFkLEVBQW1CO0FBQ2YsWUFBSStFLFNBQVMsQ0FBQ0csTUFBZCxFQUFzQjtBQUNsQmhELFVBQUFBLFFBQVEsQ0FBQ3lDLGNBQWMsR0FBRyxJQUFqQixHQUF3QnhDLEtBQXpCLENBQVIsR0FBMENBLEtBQTFDO0FBQ0g7O0FBRURlLFFBQUFBLFFBQVEsQ0FBQ2hDLElBQVQsQ0FBZSxHQUFFOEQsUUFBUyxLQUFJRCxTQUFTLENBQUMvRSxHQUFJLEtBQUltQyxLQUFNLE9BQU0sS0FBS2IsY0FBTCxDQUFvQjJELEVBQXBCLEVBQXdCaEYsTUFBeEIsRUFBZ0MsSUFBaEMsRUFBc0MwRSxjQUF0QyxFQUFzRHpDLFFBQXRELENBQWdFLEVBQTVIO0FBQ0E2QyxRQUFBQSxTQUFTLENBQUM5RSxNQUFWLENBQWlCc0QsT0FBakIsQ0FBeUJDLENBQUMsSUFBSXZELE1BQU0sQ0FBQ2lCLElBQVAsQ0FBWXNDLENBQVosQ0FBOUI7QUFFQTtBQUNIOztBQUVELFVBQUk7QUFBRTJCLFFBQUFBLE1BQUY7QUFBVUMsUUFBQUE7QUFBVixVQUF3QkwsU0FBNUI7QUFDQSxVQUFJTSxRQUFRLEdBQUdWLGNBQWMsR0FBRyxHQUFqQixHQUF1QkwsTUFBdEM7QUFDQXBDLE1BQUFBLFFBQVEsQ0FBQ21ELFFBQUQsQ0FBUixHQUFxQmxELEtBQXJCO0FBRUFlLE1BQUFBLFFBQVEsQ0FBQ2hDLElBQVQsQ0FBZSxHQUFFOEQsUUFBUyxJQUFHdEksS0FBSyxDQUFDWSxRQUFOLENBQWU2SCxNQUFmLENBQXVCLElBQUdoRCxLQUFNLE9BQU0sS0FBS2IsY0FBTCxDQUFvQjJELEVBQXBCLEVBQXdCaEYsTUFBeEIsRUFBZ0MsSUFBaEMsRUFBc0MwRSxjQUF0QyxFQUFzRHpDLFFBQXRELENBQWdFLEVBQW5JOztBQUVBLFVBQUlrRCxTQUFKLEVBQWU7QUFDWCxZQUFJRSxXQUFXLEdBQUcsS0FBS2xDLGlCQUFMLENBQXVCZ0MsU0FBdkIsRUFBa0NDLFFBQWxDLEVBQTRDbEQsS0FBNUMsRUFBbURELFFBQW5ELEVBQTZEMkMsT0FBN0QsRUFBc0U1RSxNQUF0RSxDQUFsQjs7QUFDQTRFLFFBQUFBLE9BQU8sSUFBSVMsV0FBVyxDQUFDQyxNQUF2QjtBQUNBckMsUUFBQUEsUUFBUSxHQUFHQSxRQUFRLENBQUNULE1BQVQsQ0FBZ0I2QyxXQUFoQixDQUFYO0FBQ0g7QUFDSixLQTVCRDs7QUE4QkEsV0FBT3BDLFFBQVA7QUFDSDs7QUFrQkQ1QixFQUFBQSxjQUFjLENBQUNGLFNBQUQsRUFBWW5CLE1BQVosRUFBb0J1RixZQUFwQixFQUFrQ3pELFVBQWxDLEVBQThDRyxRQUE5QyxFQUF3RDtBQUNsRSxRQUFJdUQsS0FBSyxDQUFDQyxPQUFOLENBQWN0RSxTQUFkLENBQUosRUFBOEI7QUFDMUIsVUFBSSxDQUFDb0UsWUFBTCxFQUFtQjtBQUNmQSxRQUFBQSxZQUFZLEdBQUcsSUFBZjtBQUNIOztBQUNELGFBQU9wRSxTQUFTLENBQUNtQixHQUFWLENBQWNvRCxDQUFDLElBQUksTUFBTSxLQUFLckUsY0FBTCxDQUFvQnFFLENBQXBCLEVBQXVCMUYsTUFBdkIsRUFBK0IsSUFBL0IsRUFBcUM4QixVQUFyQyxFQUFpREcsUUFBakQsQ0FBTixHQUFtRSxHQUF0RixFQUEyRnVCLElBQTNGLENBQWlHLElBQUcrQixZQUFhLEdBQWpILENBQVA7QUFDSDs7QUFFRCxRQUFJbkosQ0FBQyxDQUFDdUosYUFBRixDQUFnQnhFLFNBQWhCLENBQUosRUFBZ0M7QUFDNUIsVUFBSSxDQUFDb0UsWUFBTCxFQUFtQjtBQUNmQSxRQUFBQSxZQUFZLEdBQUcsS0FBZjtBQUNIOztBQUVELGFBQU9uSixDQUFDLENBQUNrRyxHQUFGLENBQU1uQixTQUFOLEVBQWlCLENBQUM3QixLQUFELEVBQVFDLEdBQVIsS0FBZ0I7QUFDcEMsWUFBSUEsR0FBRyxLQUFLLE1BQVIsSUFBa0JBLEdBQUcsS0FBSyxNQUE5QixFQUFzQztBQUFBLGdCQUMxQmlHLEtBQUssQ0FBQ0MsT0FBTixDQUFjbkcsS0FBZCxLQUF3QmxELENBQUMsQ0FBQ3VKLGFBQUYsQ0FBZ0JyRyxLQUFoQixDQURFO0FBQUEsNEJBQ3NCLDJEQUR0QjtBQUFBOztBQUdsQyxpQkFBTyxNQUFNLEtBQUsrQixjQUFMLENBQW9CL0IsS0FBcEIsRUFBMkJVLE1BQTNCLEVBQW1DLEtBQW5DLEVBQTBDOEIsVUFBMUMsRUFBc0RHLFFBQXRELENBQU4sR0FBd0UsR0FBL0U7QUFDSDs7QUFFRCxZQUFJMUMsR0FBRyxLQUFLLE1BQVIsSUFBa0JBLEdBQUcsS0FBSyxLQUE5QixFQUFxQztBQUFBLGdCQUN6QmlHLEtBQUssQ0FBQ0MsT0FBTixDQUFjbkcsS0FBZCxLQUF3QmxELENBQUMsQ0FBQ3VKLGFBQUYsQ0FBZ0JyRyxLQUFoQixDQURDO0FBQUEsNEJBQ3VCLGdEQUR2QjtBQUFBOztBQUdqQyxpQkFBTyxNQUFNLEtBQUsrQixjQUFMLENBQW9CL0IsS0FBcEIsRUFBMkJVLE1BQTNCLEVBQW1DLElBQW5DLEVBQXlDOEIsVUFBekMsRUFBcURHLFFBQXJELENBQU4sR0FBdUUsR0FBOUU7QUFDSDs7QUFFRCxZQUFJMUMsR0FBRyxLQUFLLE1BQVosRUFBb0I7QUFDaEIsY0FBSWlHLEtBQUssQ0FBQ0MsT0FBTixDQUFjbkcsS0FBZCxDQUFKLEVBQTBCO0FBQUEsa0JBQ2RBLEtBQUssQ0FBQ2dHLE1BQU4sR0FBZSxDQUREO0FBQUEsOEJBQ0ksNENBREo7QUFBQTs7QUFHdEIsbUJBQU8sVUFBVSxLQUFLakUsY0FBTCxDQUFvQi9CLEtBQXBCLEVBQTJCVSxNQUEzQixFQUFtQyxJQUFuQyxFQUF5QzhCLFVBQXpDLEVBQXFERyxRQUFyRCxDQUFWLEdBQTJFLEdBQWxGO0FBQ0g7O0FBRUQsY0FBSTdGLENBQUMsQ0FBQ3VKLGFBQUYsQ0FBZ0JyRyxLQUFoQixDQUFKLEVBQTRCO0FBQ3hCLGdCQUFJc0csWUFBWSxHQUFHQyxNQUFNLENBQUM3SCxJQUFQLENBQVlzQixLQUFaLEVBQW1CZ0csTUFBdEM7O0FBRHdCLGtCQUVoQk0sWUFBWSxHQUFHLENBRkM7QUFBQSw4QkFFRSw0Q0FGRjtBQUFBOztBQUl4QixtQkFBTyxVQUFVLEtBQUt2RSxjQUFMLENBQW9CL0IsS0FBcEIsRUFBMkJVLE1BQTNCLEVBQW1DLElBQW5DLEVBQXlDOEIsVUFBekMsRUFBcURHLFFBQXJELENBQVYsR0FBMkUsR0FBbEY7QUFDSDs7QUFaZSxnQkFjUixPQUFPM0MsS0FBUCxLQUFpQixRQWRUO0FBQUEsNEJBY21CLHdCQWRuQjtBQUFBOztBQWdCaEIsaUJBQU8sVUFBVTZCLFNBQVYsR0FBc0IsR0FBN0I7QUFDSDs7QUFFRCxlQUFPLEtBQUsyRSxjQUFMLENBQW9CdkcsR0FBcEIsRUFBeUJELEtBQXpCLEVBQWdDVSxNQUFoQyxFQUF3QzhCLFVBQXhDLEVBQW9ERyxRQUFwRCxDQUFQO0FBQ0gsT0FqQ00sRUFpQ0p1QixJQWpDSSxDQWlDRSxJQUFHK0IsWUFBYSxHQWpDbEIsQ0FBUDtBQWtDSDs7QUEvQ2lFLFVBaUQxRCxPQUFPcEUsU0FBUCxLQUFxQixRQWpEcUM7QUFBQSxzQkFpRDNCLHdCQWpEMkI7QUFBQTs7QUFtRGxFLFdBQU9BLFNBQVA7QUFDSDs7QUFFRDRFLEVBQUFBLDBCQUEwQixDQUFDQyxTQUFELEVBQVlDLFVBQVosRUFBd0JoRSxRQUF4QixFQUFrQztBQUN4RCxRQUFJaUUsS0FBSyxHQUFHRixTQUFTLENBQUM1RCxLQUFWLENBQWdCLEdBQWhCLENBQVo7O0FBQ0EsUUFBSThELEtBQUssQ0FBQ1osTUFBTixHQUFlLENBQW5CLEVBQXNCO0FBQ2xCLFVBQUlhLGVBQWUsR0FBR0QsS0FBSyxDQUFDRSxHQUFOLEVBQXRCO0FBQ0EsVUFBSWxFLEtBQUssR0FBR0QsUUFBUSxDQUFDZ0UsVUFBVSxHQUFHLEdBQWIsR0FBbUJDLEtBQUssQ0FBQzFDLElBQU4sQ0FBVyxHQUFYLENBQXBCLENBQXBCOztBQUNBLFVBQUksQ0FBQ3RCLEtBQUwsRUFBWTtBQUNSLFlBQUltRSxHQUFHLEdBQUksNkJBQTRCTCxTQUFVLEVBQWpEO0FBQ0EsYUFBSzNILEdBQUwsQ0FBUyxPQUFULEVBQWtCZ0ksR0FBbEIsRUFBdUJwRSxRQUF2QjtBQUNBLGNBQU0sSUFBSXJGLGFBQUosQ0FBa0J5SixHQUFsQixDQUFOO0FBQ0g7O0FBRUQsYUFBT25FLEtBQUssR0FBRyxHQUFSLEdBQWN6RixLQUFLLENBQUNZLFFBQU4sQ0FBZThJLGVBQWYsQ0FBckI7QUFDSDs7QUFFRCxXQUFPbEUsUUFBUSxDQUFDZ0UsVUFBRCxDQUFSLEdBQXVCLEdBQXZCLEdBQTZCeEosS0FBSyxDQUFDWSxRQUFOLENBQWUySSxTQUFmLENBQXBDO0FBQ0g7O0FBRURwQyxFQUFBQSxrQkFBa0IsQ0FBQ29DLFNBQUQsRUFBWUMsVUFBWixFQUF3QmhFLFFBQXhCLEVBQWtDO0FBQ2hELFFBQUlnRSxVQUFKLEVBQWdCO0FBQ1osYUFBTyxLQUFLRiwwQkFBTCxDQUFnQ0MsU0FBaEMsRUFBMkNDLFVBQTNDLEVBQXVEaEUsUUFBdkQsQ0FBUDtBQUNIOztBQUVELFdBQU94RixLQUFLLENBQUNZLFFBQU4sQ0FBZTJJLFNBQWYsQ0FBUDtBQUNIOztBQWFERixFQUFBQSxjQUFjLENBQUNFLFNBQUQsRUFBWTFHLEtBQVosRUFBbUJnSCxTQUFuQixFQUE4QnhFLFVBQTlCLEVBQTBDRyxRQUExQyxFQUFvRHNFLE1BQXBELEVBQTREO0FBQ3RFLFFBQUluSyxDQUFDLENBQUNvSyxLQUFGLENBQVFsSCxLQUFSLENBQUosRUFBb0I7QUFDaEIsYUFBTyxLQUFLc0Usa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxVQUFsRTtBQUNIOztBQUVELFFBQUk3RixDQUFDLENBQUN1SixhQUFGLENBQWdCckcsS0FBaEIsQ0FBSixFQUE0QjtBQUN4QixVQUFJQSxLQUFLLENBQUNtSCxPQUFWLEVBQW1CO0FBQ2YsWUFBSW5ILEtBQUssQ0FBQ21ILE9BQU4sS0FBa0IsaUJBQXRCLEVBQXlDO0FBQ3JDLGlCQUFPLEtBQUtYLGNBQUwsQ0FBb0JFLFNBQXBCLEVBQStCLEtBQUtwQyxrQkFBTCxDQUF3QnRFLEtBQUssQ0FBQ29ILElBQTlCLEVBQW9DNUUsVUFBcEMsRUFBZ0RHLFFBQWhELENBQS9CLEVBQTBGcUUsU0FBMUYsRUFBcUd4RSxVQUFyRyxFQUFpSEcsUUFBakgsRUFBMkgsSUFBM0gsQ0FBUDtBQUNIOztBQUVELGNBQU0sSUFBSTBFLEtBQUosQ0FBVSxnQ0FBZ0NySCxLQUFLLENBQUNtSCxPQUFoRCxDQUFOO0FBQ0g7O0FBRUQsVUFBSUcsV0FBVyxHQUFHeEssQ0FBQyxDQUFDZ0QsSUFBRixDQUFPeUcsTUFBTSxDQUFDN0gsSUFBUCxDQUFZc0IsS0FBWixDQUFQLEVBQTJCdUgsQ0FBQyxJQUFJQSxDQUFDLElBQUlBLENBQUMsQ0FBQyxDQUFELENBQUQsS0FBUyxHQUE5QyxDQUFsQjs7QUFFQSxVQUFJRCxXQUFKLEVBQWlCO0FBQ2IsZUFBT3hLLENBQUMsQ0FBQ2tHLEdBQUYsQ0FBTWhELEtBQU4sRUFBYSxDQUFDd0gsQ0FBRCxFQUFJRCxDQUFKLEtBQVU7QUFDMUIsY0FBSUEsQ0FBQyxJQUFJQSxDQUFDLENBQUMsQ0FBRCxDQUFELEtBQVMsR0FBbEIsRUFBdUI7QUFFbkIsb0JBQVFBLENBQVI7QUFDSSxtQkFBSyxLQUFMO0FBQ0EsbUJBQUssUUFBTDtBQUVJLHVCQUFPLEtBQUtmLGNBQUwsQ0FBb0JFLFNBQXBCLEVBQStCYyxDQUEvQixFQUFrQ1IsU0FBbEMsRUFBNkN4RSxVQUE3QyxFQUF5REcsUUFBekQsRUFBbUVzRSxNQUFuRSxDQUFQOztBQUVKLG1CQUFLLEtBQUw7QUFDQSxtQkFBSyxNQUFMO0FBQ0EsbUJBQUssV0FBTDtBQUVJLG9CQUFJbkssQ0FBQyxDQUFDb0ssS0FBRixDQUFRTSxDQUFSLENBQUosRUFBZ0I7QUFDWix5QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxjQUFsRTtBQUNIOztBQUVELG9CQUFJbkYsV0FBVyxDQUFDZ0ssQ0FBRCxDQUFmLEVBQW9CO0FBQ2hCLHNCQUFJUCxNQUFKLEVBQVk7QUFDUiwyQkFBTyxLQUFLM0Msa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxNQUEzRCxHQUFvRTZFLENBQTNFO0FBQ0g7O0FBRURSLGtCQUFBQSxTQUFTLENBQUNyRixJQUFWLENBQWU2RixDQUFmO0FBQ0EseUJBQU8sS0FBS2xELGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBMkQsT0FBbEU7QUFDSDs7QUFFRCx1QkFBTyxVQUFVLEtBQUs2RCxjQUFMLENBQW9CRSxTQUFwQixFQUErQmMsQ0FBL0IsRUFBa0NSLFNBQWxDLEVBQTZDeEUsVUFBN0MsRUFBeURHLFFBQXpELEVBQW1FLElBQW5FLENBQVYsR0FBcUYsR0FBNUY7O0FBRUosbUJBQUssSUFBTDtBQUNBLG1CQUFLLEtBQUw7QUFDQSxtQkFBSyxjQUFMO0FBRUksb0JBQUksQ0FBQzdGLENBQUMsQ0FBQzJLLFFBQUYsQ0FBV0QsQ0FBWCxDQUFMLEVBQW9CO0FBQ2hCLHdCQUFNLElBQUlILEtBQUosQ0FBVSxxREFBVixDQUFOO0FBQ0g7O0FBRUQsb0JBQUlKLE1BQUosRUFBWTtBQUNSLHlCQUFPLEtBQUszQyxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELEtBQTNELEdBQW1FNkUsQ0FBMUU7QUFDSDs7QUFFRFIsZ0JBQUFBLFNBQVMsQ0FBQ3JGLElBQVYsQ0FBZTZGLENBQWY7QUFDQSx1QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxNQUFsRTs7QUFFSixtQkFBSyxLQUFMO0FBQ0EsbUJBQUssTUFBTDtBQUNBLG1CQUFLLHFCQUFMO0FBRUksb0JBQUksQ0FBQzdGLENBQUMsQ0FBQzJLLFFBQUYsQ0FBV0QsQ0FBWCxDQUFMLEVBQW9CO0FBQ2hCLHdCQUFNLElBQUlILEtBQUosQ0FBVSx1REFBVixDQUFOO0FBQ0g7O0FBRUQsb0JBQUlKLE1BQUosRUFBWTtBQUNSLHlCQUFPLEtBQUszQyxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELE1BQTNELEdBQW9FNkUsQ0FBM0U7QUFDSDs7QUFFRFIsZ0JBQUFBLFNBQVMsQ0FBQ3JGLElBQVYsQ0FBZTZGLENBQWY7QUFDQSx1QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxPQUFsRTs7QUFFSixtQkFBSyxJQUFMO0FBQ0EsbUJBQUssS0FBTDtBQUNBLG1CQUFLLFdBQUw7QUFFSSxvQkFBSSxDQUFDN0YsQ0FBQyxDQUFDMkssUUFBRixDQUFXRCxDQUFYLENBQUwsRUFBb0I7QUFDaEIsd0JBQU0sSUFBSUgsS0FBSixDQUFVLHNEQUFWLENBQU47QUFDSDs7QUFFRCxvQkFBSUosTUFBSixFQUFZO0FBQ1IseUJBQU8sS0FBSzNDLGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBMkQsS0FBM0QsR0FBbUU2RSxDQUExRTtBQUNIOztBQUVEUixnQkFBQUEsU0FBUyxDQUFDckYsSUFBVixDQUFlNkYsQ0FBZjtBQUNBLHVCQUFPLEtBQUtsRCxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELE1BQWxFOztBQUVKLG1CQUFLLEtBQUw7QUFDQSxtQkFBSyxNQUFMO0FBQ0EsbUJBQUssa0JBQUw7QUFFSSxvQkFBSSxDQUFDN0YsQ0FBQyxDQUFDMkssUUFBRixDQUFXRCxDQUFYLENBQUwsRUFBb0I7QUFDaEIsd0JBQU0sSUFBSUgsS0FBSixDQUFVLHVEQUFWLENBQU47QUFDSDs7QUFFRCxvQkFBSUosTUFBSixFQUFZO0FBQ1IseUJBQU8sS0FBSzNDLGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBMkQsTUFBM0QsR0FBb0U2RSxDQUEzRTtBQUNIOztBQUVEUixnQkFBQUEsU0FBUyxDQUFDckYsSUFBVixDQUFlNkYsQ0FBZjtBQUNBLHVCQUFPLEtBQUtsRCxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELE9BQWxFOztBQUVKLG1CQUFLLEtBQUw7QUFFSSxvQkFBSSxDQUFDdUQsS0FBSyxDQUFDQyxPQUFOLENBQWNxQixDQUFkLENBQUwsRUFBdUI7QUFDbkIsd0JBQU0sSUFBSUgsS0FBSixDQUFVLHlEQUFWLENBQU47QUFDSDs7QUFFRCxvQkFBSUosTUFBSixFQUFZO0FBQ1IseUJBQU8sS0FBSzNDLGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBNEQsUUFBTzZFLENBQUUsR0FBNUU7QUFDSDs7QUFFRFIsZ0JBQUFBLFNBQVMsQ0FBQ3JGLElBQVYsQ0FBZTZGLENBQWY7QUFDQSx1QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxTQUFsRTs7QUFFSixtQkFBSyxNQUFMO0FBQ0EsbUJBQUssUUFBTDtBQUVJLG9CQUFJLENBQUN1RCxLQUFLLENBQUNDLE9BQU4sQ0FBY3FCLENBQWQsQ0FBTCxFQUF1QjtBQUNuQix3QkFBTSxJQUFJSCxLQUFKLENBQVUseURBQVYsQ0FBTjtBQUNIOztBQUVELG9CQUFJSixNQUFKLEVBQVk7QUFDUix5QkFBTyxLQUFLM0Msa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUE0RCxZQUFXNkUsQ0FBRSxHQUFoRjtBQUNIOztBQUVEUixnQkFBQUEsU0FBUyxDQUFDckYsSUFBVixDQUFlNkYsQ0FBZjtBQUNBLHVCQUFPLEtBQUtsRCxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELGFBQWxFOztBQUVKLG1CQUFLLFlBQUw7QUFFSSxvQkFBSSxPQUFPNkUsQ0FBUCxLQUFhLFFBQWpCLEVBQTJCO0FBQ3ZCLHdCQUFNLElBQUlILEtBQUosQ0FBVSxnRUFBVixDQUFOO0FBQ0g7O0FBSkwscUJBTVksQ0FBQ0osTUFOYjtBQUFBO0FBQUE7O0FBUUlELGdCQUFBQSxTQUFTLENBQUNyRixJQUFWLENBQWdCLEdBQUU2RixDQUFFLEdBQXBCO0FBQ0EsdUJBQU8sS0FBS2xELGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBMkQsU0FBbEU7O0FBRUosbUJBQUssVUFBTDtBQUVJLG9CQUFJLE9BQU82RSxDQUFQLEtBQWEsUUFBakIsRUFBMkI7QUFDdkIsd0JBQU0sSUFBSUgsS0FBSixDQUFVLDhEQUFWLENBQU47QUFDSDs7QUFKTCxxQkFNWSxDQUFDSixNQU5iO0FBQUE7QUFBQTs7QUFRSUQsZ0JBQUFBLFNBQVMsQ0FBQ3JGLElBQVYsQ0FBZ0IsSUFBRzZGLENBQUUsRUFBckI7QUFDQSx1QkFBTyxLQUFLbEQsa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxTQUFsRTs7QUFFSixtQkFBSyxPQUFMO0FBRUksb0JBQUksT0FBTzZFLENBQVAsS0FBYSxRQUFqQixFQUEyQjtBQUN2Qix3QkFBTSxJQUFJSCxLQUFKLENBQVUsMkRBQVYsQ0FBTjtBQUNIOztBQUpMLHFCQU1ZLENBQUNKLE1BTmI7QUFBQTtBQUFBOztBQVFJRCxnQkFBQUEsU0FBUyxDQUFDckYsSUFBVixDQUFnQixJQUFHNkYsQ0FBRSxHQUFyQjtBQUNBLHVCQUFPLEtBQUtsRCxrQkFBTCxDQUF3Qm9DLFNBQXhCLEVBQW1DbEUsVUFBbkMsRUFBK0NHLFFBQS9DLElBQTJELFNBQWxFOztBQUVKO0FBQ0ksc0JBQU0sSUFBSTBFLEtBQUosQ0FBVyxvQ0FBbUNFLENBQUUsSUFBaEQsQ0FBTjtBQWxKUjtBQW9KSCxXQXRKRCxNQXNKTztBQUNILGtCQUFNLElBQUlGLEtBQUosQ0FBVSxvREFBVixDQUFOO0FBQ0g7QUFDSixTQTFKTSxFQTBKSm5ELElBMUpJLENBMEpDLE9BMUpELENBQVA7QUEySkg7O0FBdkt1QixXQXlLaEIsQ0FBQytDLE1BektlO0FBQUE7QUFBQTs7QUEyS3hCRCxNQUFBQSxTQUFTLENBQUNyRixJQUFWLENBQWUrRixJQUFJLENBQUNDLFNBQUwsQ0FBZTNILEtBQWYsQ0FBZjtBQUNBLGFBQU8sS0FBS3NFLGtCQUFMLENBQXdCb0MsU0FBeEIsRUFBbUNsRSxVQUFuQyxFQUErQ0csUUFBL0MsSUFBMkQsTUFBbEU7QUFDSDs7QUFFRCxRQUFJc0UsTUFBSixFQUFZO0FBQ1IsYUFBTyxLQUFLM0Msa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxLQUEzRCxHQUFtRTNDLEtBQTFFO0FBQ0g7O0FBRURnSCxJQUFBQSxTQUFTLENBQUNyRixJQUFWLENBQWUzQixLQUFmO0FBQ0EsV0FBTyxLQUFLc0Usa0JBQUwsQ0FBd0JvQyxTQUF4QixFQUFtQ2xFLFVBQW5DLEVBQStDRyxRQUEvQyxJQUEyRCxNQUFsRTtBQUNIOztBQUVEb0IsRUFBQUEsYUFBYSxDQUFDNkQsT0FBRCxFQUFVbEgsTUFBVixFQUFrQjhCLFVBQWxCLEVBQThCRyxRQUE5QixFQUF3QztBQUNqRCxXQUFPN0YsQ0FBQyxDQUFDa0csR0FBRixDQUFNbEcsQ0FBQyxDQUFDK0ssU0FBRixDQUFZRCxPQUFaLENBQU4sRUFBNEJFLEdBQUcsSUFBSSxLQUFLQyxZQUFMLENBQWtCRCxHQUFsQixFQUF1QnBILE1BQXZCLEVBQStCOEIsVUFBL0IsRUFBMkNHLFFBQTNDLENBQW5DLEVBQXlGdUIsSUFBekYsQ0FBOEYsSUFBOUYsQ0FBUDtBQUNIOztBQUVENkQsRUFBQUEsWUFBWSxDQUFDRCxHQUFELEVBQU1wSCxNQUFOLEVBQWM4QixVQUFkLEVBQTBCRyxRQUExQixFQUFvQztBQUM1QyxRQUFJLE9BQU9tRixHQUFQLEtBQWUsUUFBbkIsRUFBNkI7QUFFekIsYUFBUXZLLFFBQVEsQ0FBQ3VLLEdBQUQsQ0FBUixJQUFpQkEsR0FBRyxLQUFLLEdBQTFCLEdBQWlDQSxHQUFqQyxHQUF1QyxLQUFLeEQsa0JBQUwsQ0FBd0J3RCxHQUF4QixFQUE2QnRGLFVBQTdCLEVBQXlDRyxRQUF6QyxDQUE5QztBQUNIOztBQUVELFFBQUksT0FBT21GLEdBQVAsS0FBZSxRQUFuQixFQUE2QjtBQUN6QixhQUFPQSxHQUFQO0FBQ0g7O0FBRUQsUUFBSWhMLENBQUMsQ0FBQ3VKLGFBQUYsQ0FBZ0J5QixHQUFoQixDQUFKLEVBQTBCO0FBQ3RCLFVBQUlBLEdBQUcsQ0FBQ2xGLEtBQVIsRUFBZTtBQUFBLGNBQ0gsT0FBT2tGLEdBQUcsQ0FBQ2xGLEtBQVgsS0FBcUIsUUFEbEI7QUFBQTtBQUFBOztBQUdYLGVBQU8sS0FBS21GLFlBQUwsQ0FBa0JqTCxDQUFDLENBQUNrTCxJQUFGLENBQU9GLEdBQVAsRUFBWSxDQUFDLE9BQUQsQ0FBWixDQUFsQixFQUEwQ3BILE1BQTFDLEVBQWtEOEIsVUFBbEQsRUFBOERHLFFBQTlELElBQTBFLE1BQTFFLEdBQW1GeEYsS0FBSyxDQUFDWSxRQUFOLENBQWUrSixHQUFHLENBQUNsRixLQUFuQixDQUExRjtBQUNIOztBQUVELFVBQUlrRixHQUFHLENBQUNHLElBQUosS0FBYSxVQUFqQixFQUE2QjtBQUN6QixlQUFPSCxHQUFHLENBQUNWLElBQUosR0FBVyxHQUFYLElBQWtCVSxHQUFHLENBQUNJLElBQUosR0FBVyxLQUFLbkUsYUFBTCxDQUFtQitELEdBQUcsQ0FBQ0ksSUFBdkIsRUFBNkJ4SCxNQUE3QixFQUFxQzhCLFVBQXJDLEVBQWlERyxRQUFqRCxDQUFYLEdBQXdFLEVBQTFGLElBQWdHLEdBQXZHO0FBQ0g7O0FBRUQsVUFBSW1GLEdBQUcsQ0FBQ0csSUFBSixLQUFhLFlBQWpCLEVBQStCO0FBQzNCLGVBQU8sS0FBS2xHLGNBQUwsQ0FBb0IrRixHQUFHLENBQUNLLElBQXhCLEVBQThCekgsTUFBOUIsRUFBc0MsSUFBdEMsRUFBNEM4QixVQUE1QyxFQUF3REcsUUFBeEQsQ0FBUDtBQUNIO0FBQ0o7O0FBRUQsVUFBTSxJQUFJdEYsZ0JBQUosQ0FBc0IseUJBQXdCcUssSUFBSSxDQUFDQyxTQUFMLENBQWVHLEdBQWYsQ0FBb0IsRUFBbEUsQ0FBTjtBQUNIOztBQUVEM0QsRUFBQUEsYUFBYSxDQUFDaUUsT0FBRCxFQUFVMUgsTUFBVixFQUFrQjhCLFVBQWxCLEVBQThCRyxRQUE5QixFQUF3QztBQUNqRCxRQUFJLE9BQU95RixPQUFQLEtBQW1CLFFBQXZCLEVBQWlDLE9BQU8sY0FBYyxLQUFLOUQsa0JBQUwsQ0FBd0I4RCxPQUF4QixFQUFpQzVGLFVBQWpDLEVBQTZDRyxRQUE3QyxDQUFyQjtBQUVqQyxRQUFJdUQsS0FBSyxDQUFDQyxPQUFOLENBQWNpQyxPQUFkLENBQUosRUFBNEIsT0FBTyxjQUFjQSxPQUFPLENBQUNwRixHQUFSLENBQVlxRixFQUFFLElBQUksS0FBSy9ELGtCQUFMLENBQXdCK0QsRUFBeEIsRUFBNEI3RixVQUE1QixFQUF3Q0csUUFBeEMsQ0FBbEIsRUFBcUV1QixJQUFyRSxDQUEwRSxJQUExRSxDQUFyQjs7QUFFNUIsUUFBSXBILENBQUMsQ0FBQ3VKLGFBQUYsQ0FBZ0IrQixPQUFoQixDQUFKLEVBQThCO0FBQzFCLFVBQUk7QUFBRVIsUUFBQUEsT0FBRjtBQUFXVSxRQUFBQTtBQUFYLFVBQXNCRixPQUExQjs7QUFFQSxVQUFJLENBQUNSLE9BQUQsSUFBWSxDQUFDMUIsS0FBSyxDQUFDQyxPQUFOLENBQWN5QixPQUFkLENBQWpCLEVBQXlDO0FBQ3JDLGNBQU0sSUFBSXZLLGdCQUFKLENBQXNCLDRCQUEyQnFLLElBQUksQ0FBQ0MsU0FBTCxDQUFlUyxPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxVQUFJRyxhQUFhLEdBQUcsS0FBS3BFLGFBQUwsQ0FBbUJ5RCxPQUFuQixDQUFwQjs7QUFDQSxVQUFJWSxXQUFXLEdBQUdGLE1BQU0sSUFBSSxLQUFLdkcsY0FBTCxDQUFvQnVHLE1BQXBCLEVBQTRCNUgsTUFBNUIsRUFBb0MsSUFBcEMsRUFBMEM4QixVQUExQyxFQUFzREcsUUFBdEQsQ0FBNUI7O0FBQ0EsVUFBSTZGLFdBQUosRUFBaUI7QUFDYkQsUUFBQUEsYUFBYSxJQUFJLGFBQWFDLFdBQTlCO0FBQ0g7O0FBRUQsYUFBT0QsYUFBUDtBQUNIOztBQUVELFVBQU0sSUFBSWxMLGdCQUFKLENBQXNCLDRCQUEyQnFLLElBQUksQ0FBQ0MsU0FBTCxDQUFlUyxPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRGhFLEVBQUFBLGFBQWEsQ0FBQ3FFLE9BQUQsRUFBVWpHLFVBQVYsRUFBc0JHLFFBQXRCLEVBQWdDO0FBQ3pDLFFBQUksT0FBTzhGLE9BQVAsS0FBbUIsUUFBdkIsRUFBaUMsT0FBTyxjQUFjLEtBQUtuRSxrQkFBTCxDQUF3Qm1FLE9BQXhCLEVBQWlDakcsVUFBakMsRUFBNkNHLFFBQTdDLENBQXJCO0FBRWpDLFFBQUl1RCxLQUFLLENBQUNDLE9BQU4sQ0FBY3NDLE9BQWQsQ0FBSixFQUE0QixPQUFPLGNBQWNBLE9BQU8sQ0FBQ3pGLEdBQVIsQ0FBWXFGLEVBQUUsSUFBSSxLQUFLL0Qsa0JBQUwsQ0FBd0IrRCxFQUF4QixFQUE0QjdGLFVBQTVCLEVBQXdDRyxRQUF4QyxDQUFsQixFQUFxRXVCLElBQXJFLENBQTBFLElBQTFFLENBQXJCOztBQUU1QixRQUFJcEgsQ0FBQyxDQUFDdUosYUFBRixDQUFnQm9DLE9BQWhCLENBQUosRUFBOEI7QUFDMUIsYUFBTyxjQUFjM0wsQ0FBQyxDQUFDa0csR0FBRixDQUFNeUYsT0FBTixFQUFlLENBQUNDLEdBQUQsRUFBTVosR0FBTixLQUFjLEtBQUt4RCxrQkFBTCxDQUF3QndELEdBQXhCLEVBQTZCdEYsVUFBN0IsRUFBeUNHLFFBQXpDLEtBQXNEK0YsR0FBRyxHQUFHLEVBQUgsR0FBUSxPQUFqRSxDQUE3QixFQUF3R3hFLElBQXhHLENBQTZHLElBQTdHLENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJN0csZ0JBQUosQ0FBc0IsNEJBQTJCcUssSUFBSSxDQUFDQyxTQUFMLENBQWVjLE9BQWYsQ0FBd0IsRUFBekUsQ0FBTjtBQUNIOztBQUVELFFBQU05SCxlQUFOLENBQXNCOUMsT0FBdEIsRUFBK0I7QUFDM0IsV0FBUUEsT0FBTyxJQUFJQSxPQUFPLENBQUM4SyxVQUFwQixHQUFrQzlLLE9BQU8sQ0FBQzhLLFVBQTFDLEdBQXVELEtBQUszSixRQUFMLENBQWNuQixPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXVELG1CQUFOLENBQTBCOUMsSUFBMUIsRUFBZ0NULE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQzhLLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS2hLLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDtBQUNKOztBQTN6QmtDOztBQUFqQ1osYyxDQU1LcUMsZSxHQUFrQndHLE1BQU0sQ0FBQ3FDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQXd6QjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUJ4TCxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsID0gJ0lOU0VSVCBJTlRPID8/IFNFVCA/JztcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgY29uZGl0aW9uLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSA/PyBTRVQgPyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRhc3NvY2lhdGlvbiwgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRhc3NvY2lhdGlvbikgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJGFzc29jaWF0aW9uLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICAvLyBtb3ZlIGNhY2hlZCBqb2luaW5nIHBhcmFtcyBpbnRvIHBhcmFtc1xuICAgICAgICAvLyBzaG91bGQgYWNjb3JkaW5nIHRvIHRoZSBwbGFjZSBvZiBjbGF1c2UgaW4gYSBzcWwgXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZTtcbiAgICAgICAgXG4gICAgICAgIGlmICgkcXVlcnkpIHtcbiAgICAgICAgICAgIHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7XG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuOicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgICAgIGFzc29jSW5mby5wYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTsgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGEgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGNvbmRpdGlvbiA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9YDtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBtc2csIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHZhbHVlc1NlcSAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnQ29sdW1uUmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYWRkIG9vclR5cGUgc3VwcG9ydDogJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKSArICcpJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZXNTZXEucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiAoaXNRdW90ZWQoY29sKSB8fCBjb2wgPT09ICcqJykgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID8gJycgOiAnIERFU0MnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19