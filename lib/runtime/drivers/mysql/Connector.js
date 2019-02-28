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
      console.log(joinings);
      console.log(joiningParams);
      hasJoining = model;
    }

    let selectColomns = $projection ? this._buildColumns($projection, params, hasJoining, aliasMap) : '*';

    if (hasJoining) {
      joiningParams.forEach(p => params.push(p));
    }

    let sql = ' FROM ' + mysql.escapeId(model);

    if (hasJoining) {
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
    console.dir(result, {
      depth: 10,
      colors: true
    });
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
    console.log('associations:', Object.keys(associations));

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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInVwZGF0ZV8iLCJjb25kaXRpb24iLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiZmluZF8iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwiaGFzSm9pbmluZyIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsImFsaWFzTWFwIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJtYXAiLCJuIiwiY29uY2F0IiwiJGFzc29jaWF0aW9uIiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwiam9pbmluZ3MiLCJqb2luaW5nUGFyYW1zIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJjb25zb2xlIiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJmb3JFYWNoIiwicCIsImpvaW4iLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImRpciIsImRlcHRoIiwiY29sb3JzIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsIk9iamVjdCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImxlbmd0aCIsImpvaW5PcGVyYXRvciIsIkFycmF5IiwiaXNBcnJheSIsImMiLCJpc1BsYWluT2JqZWN0IiwibnVtT2ZFbGVtZW50IiwiX3dyYXBDb25kaXRpb24iLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsImZpZWxkTmFtZSIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsIm1zZyIsInZhbHVlc1NlcSIsImluamVjdCIsImlzTmlsIiwib29yVHlwZSIsIm5hbWUiLCJoYXNPcGVyYXRvciIsImsiLCJ2IiwiaXNGaW5pdGUiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwib21pdCIsInR5cGUiLCJhcmdzIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBc0NMLE9BQU8sQ0FBQyxj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QTdHLENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJL0csZ0JBQUosQ0FBc0IsNEJBQTJCMEosSUFBSSxDQUFDQyxTQUFMLENBQWU4QixPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxRQUFNbkksZUFBTixDQUFzQjlDLE9BQXRCLEVBQStCO0FBQzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDbUwsVUFBcEIsR0FBa0NuTCxPQUFPLENBQUNtTCxVQUExQyxHQUF1RCxLQUFLaEssUUFBTCxDQUFjbkIsT0FBZCxDQUE5RDtBQUNIOztBQUVELFFBQU11RCxtQkFBTixDQUEwQjlDLElBQTFCLEVBQWdDVCxPQUFoQyxFQUF5QztBQUNyQyxRQUFJLENBQUNBLE9BQUQsSUFBWSxDQUFDQSxPQUFPLENBQUNtTCxVQUF6QixFQUFxQztBQUNqQyxhQUFPLEtBQUtySyxXQUFMLENBQWlCTCxJQUFqQixDQUFQO0FBQ0g7QUFDSjs7QUExMEJrQzs7QUFBakNaLGMsQ0FNS3FDLGUsR0FBa0I2RixNQUFNLENBQUNxRCxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUF1MEI3QkMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCN0wsY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hcHAvbGliL3V0aWxzL0hlbHBlcnMnKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBPb2xvbmdVc2FnZUVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSByZXF1aXJlKCcuLi8uLi9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLl9wb29scyA9IHt9O1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgICB9XG5cbiAgICBzdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKSB7XG4gICAgICAgIHBvc3Q6ICFjb25uIHx8IGl0LCAnQ29ubmVjdGlvbiBvYmplY3Qgbm90IGZvdW5kIGluIGFjaXR2ZSBjb25uZWN0aW9ucyBtYXAuJzsgXG4gICAgICAgIHJldHVybiB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5nZXQoY29ubik7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmtleXMoKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyh0aGlzLl9wb29scywgYXN5bmMgKHBvb2wsIGNzKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBwb29sLmVuZCgpO1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlZCBwb29sOiAnICsgY3MpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMuZ2V0TmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgcG9vbCA9IHRoaXMuX3Bvb2xzW2NzS2V5XTtcblxuICAgICAgICBpZiAoIXBvb2wpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgICAgIHRoaXMuX3Bvb2xzW2NzS2V5XSA9IHBvb2w7XG5cbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDcmVhdGVkIHBvb2w6ICcgKyBjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgcG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLnNldChjb25uLCBjc0tleSk7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZSBjb25uZWN0aW9uOiAnICsgY3NLZXkpO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNzID0gdGhpcy5zdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDbG9zZSBjb25uZWN0aW9uOiAnICsgKGNzIHx8ICcqdW5rbm93bionKSk7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGxldCBpc29sYXRpb25MZXZlbCA9IF8uZmluZChNeVNRTENvbm5lY3Rvci5Jc29sYXRpb25MZXZlbHMsICh2YWx1ZSwga2V5KSA9PiBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSBrZXkgfHwgb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0gdmFsdWUpO1xuICAgICAgICAgICAgaWYgKCFpc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGlzb2xhdGlvbiBsZXZlbDogXCIke2lzb2xhdGlvbkxldmVsfVwiIVwiYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIFRSQU5TQUNUSU9OIElTT0xBVElPTiBMRVZFTCAnICsgaXNvbGF0aW9uTGV2ZWwpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgY29ubi5iZWdpblRyYW5zYWN0aW9uKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4uY29tbWl0KCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ29tbWl0cyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnJvbGxiYWNrKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnUm9sbGJhY2tzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1NRTFN0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIHNxbCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZvcm1hdGVkU1FMID0gcGFyYW1zID8gY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpIDogc3FsO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1NRTFN0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgZm9ybWF0ZWRTUUwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWw6IGZvcm1hdGVkU1FMLCByb3dzQXNBcnJheTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KGZvcm1hdGVkU1FMLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFkYXRhIHx8IF8uaXNFbXB0eShkYXRhKSkge1xuICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYENyZWF0aW5nIHdpdGggZW1wdHkgXCIke21vZGVsfVwiIGRhdGEuYCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ0lOU0VSVCBJTlRPID8/IFNFVCA/JztcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgY29uZGl0aW9uLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSA/PyBTRVQgPyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRhc3NvY2lhdGlvbiwgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRhc3NvY2lhdGlvbikgeyAgXG4gICAgICAgICAgICAvL2NvbnNvbGUuZGlyKCRhc3NvY2lhdGlvbiwgeyBkZXB0aDogMTYsIGNvbG9yczogdHJ1ZSB9KTsgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhqb2luaW5ncyk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25zb2xlLmxvZyhqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJyonO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCBcbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJHF1ZXJ5KSB7XG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRvcmRlckJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRPcmRlckJ5KCRvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgcmVzdWx0ID0geyBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwIH07ICAgICAgICBcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJlc3VsdC5jb3VudFNxbCA9IGBTRUxFQ1QgQ09VTlQoJHtjb3VudFN1YmplY3R9KSBBUyBjb3VudGAgKyBzcWw7XG4gICAgICAgIH1cblxuICAgICAgICBzcWwgPSAnU0VMRUNUICcgKyBzZWxlY3RDb2xvbW5zICsgc3FsOyAgICAgICAgXG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/JztcbiAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9IGVsc2UgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBzcWwgKz0gJyBMSU1JVCA/LCAxMDAwJztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmVzdWx0LnNxbCA9IHNxbDtcblxuICAgICAgICBjb25zb2xlLmRpcihyZXN1bHQsIHsgZGVwdGg6IDEwLCBjb2xvcnM6IHRydWUgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICBjb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGEgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9YDtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBtc2csIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JhcCBhIGNvbmRpdGlvbiBjbGF1c2UgICAgIFxuICAgICAqIFxuICAgICAqIFZhbHVlIGNhbiBiZSBhIGxpdGVyYWwgb3IgYSBwbGFpbiBjb25kaXRpb24gb2JqZWN0LlxuICAgICAqICAgMS4gZmllbGROYW1lLCA8bGl0ZXJhbD5cbiAgICAgKiAgIDIuIGZpZWxkTmFtZSwgeyBub3JtYWwgb2JqZWN0IH0gXG4gICAgICogXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IGZpZWxkTmFtZSBcbiAgICAgKiBAcGFyYW0geyp9IHZhbHVlIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHZhbHVlc1NlcSAgXG4gICAgICovXG4gICAgX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2YWx1ZSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlID09PSAnQ29sdW1uUmVmZXJlbmNlJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcigndG9kbzogYWRkIG9vclR5cGUgc3VwcG9ydDogJyArIHZhbHVlLm9vclR5cGUpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgaW5qZWN0KTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChfLmlzTmlsKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKSArICcpJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkbGlrZVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICB2YWx1ZXNTZXEucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiAoaXNRdW90ZWQoY29sKSB8fCBjb2wgPT09ICcqJykgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID8gJycgOiAnIERFU0MnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19