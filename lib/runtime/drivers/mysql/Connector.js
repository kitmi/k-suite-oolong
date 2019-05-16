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

    return conn;
  }

  async disconnect_(conn) {
    let cs = this.stringFromConnection(conn);

    this._acitveConnections.delete(conn);

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

  async update_(model, data, query, queryOptions, connOptions) {
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

    return this.execute_(sql, params, connOptions);
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

  async find_(model, condition, connOptions) {
    let sqlInfo = this.buildQuery(model, condition);
    let result, totalCount;

    if (sqlInfo.countSql) {
      let [countResult] = await this.execute_(sqlInfo.countSql, sqlInfo.params, connOptions);
      totalCount = countResult['count'];
    }

    if (sqlInfo.hasJoining) {
      connOptions = { ...connOptions,
        rowsAsArray: true
      };
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

        if (key === '$any' || key === '$or' || key.startsWith('$or_')) {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$or" operator value should be an array or plain object.');
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
              case '$startsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$startWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                valuesSeq.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$endWith':
              case '$endsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                valuesSeq.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$like':
              case '$likes':
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInVwZGF0ZV8iLCJxdWVyeU9wdGlvbnMiLCJjb25uT3B0aW9ucyIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiam9pbmluZ1BhcmFtcyIsIiRyZWxhdGlvbnNoaXBzIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJmb3JFYWNoIiwicCIsImpvaW4iLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiY29uZGl0aW9uIiwiZmluZF8iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJtYXAiLCJuIiwiY29uY2F0IiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJsZW5ndGgiLCJqb2luT3BlcmF0b3IiLCJBcnJheSIsImlzQXJyYXkiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwidmFsdWVzU2VxIiwiaW5qZWN0IiwiaXNOaWwiLCJvb3JUeXBlIiwibmFtZSIsImhhc09wZXJhdG9yIiwiayIsInYiLCJpc0Zpbml0ZSIsInRvRmluaXRlIiwiaXNOYU4iLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwib21pdCIsInR5cGUiLCJhcmdzIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMs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RixDQUFNcUYsT0FBTixFQUFlLENBQUNDLEdBQUQsRUFBTVosR0FBTixLQUFjLEtBQUszRCxrQkFBTCxDQUF3QjJELEdBQXhCLEVBQTZCbEcsVUFBN0IsRUFBeUNGLFFBQXpDLEtBQXNEZ0gsR0FBRyxHQUFHLEVBQUgsR0FBUSxPQUFqRSxDQUE3QixFQUF3R3hHLElBQXhHLENBQTZHLElBQTdHLENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJbkYsZ0JBQUosQ0FBc0IsNEJBQTJCeUosSUFBSSxDQUFDQyxTQUFMLENBQWVnQyxPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxRQUFNcEksZUFBTixDQUFzQjlDLE9BQXRCLEVBQStCO0FBQzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDb0wsVUFBcEIsR0FBa0NwTCxPQUFPLENBQUNvTCxVQUExQyxHQUF1RCxLQUFLakssUUFBTCxDQUFjbkIsT0FBZCxDQUE5RDtBQUNIOztBQUVELFFBQU11RCxtQkFBTixDQUEwQjlDLElBQTFCLEVBQWdDVCxPQUFoQyxFQUF5QztBQUNyQyxRQUFJLENBQUNBLE9BQUQsSUFBWSxDQUFDQSxPQUFPLENBQUNvTCxVQUF6QixFQUFxQztBQUNqQyxhQUFPLEtBQUt0SyxXQUFMLENBQWlCTCxJQUFqQixDQUFQO0FBQ0g7QUFDSjs7QUE1MkJrQzs7QUFBakNaLGMsQ0FNS3FDLGUsR0FBa0I0RyxNQUFNLENBQUN1QyxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUF5MkI3QkMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCOUwsY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hcHAvbGliL3V0aWxzL0hlbHBlcnMnKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBPb2xvbmdVc2FnZUVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSByZXF1aXJlKCcuLi8uLi9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLl9wb29scyA9IHt9O1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgICB9XG5cbiAgICBzdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKSB7XG4gICAgICAgIHBvc3Q6ICFjb25uIHx8IGl0LCAnQ29ubmVjdGlvbiBvYmplY3Qgbm90IGZvdW5kIGluIGFjaXR2ZSBjb25uZWN0aW9ucyBtYXAuJzsgXG4gICAgICAgIHJldHVybiB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5nZXQoY29ubik7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmtleXMoKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyh0aGlzLl9wb29scywgYXN5bmMgKHBvb2wsIGNzKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBwb29sLmVuZCgpO1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlZCBwb29sOiAnICsgY3MpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMuZ2V0TmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgcG9vbCA9IHRoaXMuX3Bvb2xzW2NzS2V5XTtcblxuICAgICAgICBpZiAoIXBvb2wpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgICAgIHRoaXMuX3Bvb2xzW2NzS2V5XSA9IHBvb2w7XG5cbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDcmVhdGVkIHBvb2w6ICcgKyBjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgcG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLnNldChjb25uLCBjc0tleSk7XG5cbiAgICAgICAgLy90aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgLy90aGlzLmxvZygnZGVidWcnLCAnQ2xvc2UgY29ubmVjdGlvbjogJyArIChjcyB8fCAnKnVua25vd24qJykpOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBsZXQgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGNvbm4uYmVnaW5UcmFuc2FjdGlvbigpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLmNvbW1pdCgpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NvbW1pdHMgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5yb2xsYmFjaygpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ1JvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LlxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBzcWwsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmb3JtYXRlZFNRTCA9IHBhcmFtcyA/IGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSA6IHNxbDtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGZvcm1hdGVkU1FMKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsOiBmb3JtYXRlZFNRTCwgcm93c0FzQXJyYXk6IHRydWUgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShmb3JtYXRlZFNRTCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdJTlNFUlQgSU5UTyA/PyBTRVQgPyc7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeSBcbiAgICAgKiBAcGFyYW0geyp9IHF1ZXJ5T3B0aW9ucyAgXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBxdWVyeSwgcXVlcnlPcHRpb25zLCBjb25uT3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlLCBqb2luaW5nUGFyYW1zID0gW107IFxuXG4gICAgICAgIGlmIChxdWVyeU9wdGlvbnMgJiYgcXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcywgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpOyAgICAgICAgICAgICBcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICBzcWwgKz0gJyBTRVQgPyc7XG5cbiAgICAgICAgaWYgKHF1ZXJ5KSB7XG4gICAgICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgfSAgICBcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgY29ubk9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkobW9kZWwsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5jb3VudFNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHtcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgLy9jb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InIHx8IGtleS5zdGFydHNXaXRoKCckb3JfJykpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9YDtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBtc2csIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gdmFsdWVzU2VxICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZS5vb3JUeXBlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUgPT09ICdDb2x1bW5SZWZlcmVuY2UnKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXModmFsdWUubmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCB0cnVlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCd0b2RvOiBhZGQgb29yVHlwZSBzdXBwb3J0OiAnICsgdmFsdWUub29yVHlwZSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTk9UIE5VTEwnO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzUHJpbWl0aXZlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ID8nO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndFwiIG9yIFwiJD5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+ID8nO1xuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdFwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHYgPSBfLnRvRmluaXRlKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzTmFOKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkbHRlXCIgb3IgXCIkPD1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgSU4gKCR7dn0pYDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyBgIE5PVCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBOT1QgSU4gKD8pJztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRzdGFydHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRzdGFydFdpdGhcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChgJHt2fSVgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRzV2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2VzJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmYXVsdDpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdmFsdWU7XG4gICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgIHZhbHVlc1NlcS5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gaXNRdW90ZWQoY29sKSA/IGNvbCA6IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gY29sO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb2wpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcykge1xuICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChjb2wuYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICBpZiAoY29sLm5hbWUudG9VcHBlckNhc2UoKSA9PT0gJ0NPVU5UJyAmJiBjb2wuYXJncy5sZW5ndGggPT09IDEgJiYgY29sLmFyZ3NbMF0gPT09ICcqJykge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ0NPVU5UKCopJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gY29sLm5hbWUgKyAnKCcgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdleHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbC5leHByLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPyAnJyA6ICcgREVTQycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=