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

    let whereClause = $query && this._joinCondition($query, params, null, hasJoining, aliasMap);

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

  _joinAssociations(associations, parentAliasKey, parentAlias, aliasMap, startId, params) {
    let joinings = [];

    _.each(associations, assocInfo => {
      let alias = assocInfo.alias || ntol(startId++);
      let {
        joinType,
        localField,
        remoteField
      } = assocInfo;

      if (assocInfo.sql) {
        joinings.push(`${joinType} (${assocInfo.sql}) ${alias} ON ${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`);
        assocInfo.params.forEach(p => params.push(p));

        if (assocInfo.output) {
          aliasMap[parentAliasKey + '.:' + alias] = alias;
        }

        return;
      }

      let {
        entity,
        anchor,
        remoteFields,
        subAssociations,
        connectedWith
      } = assocInfo;
      let aliasKey = parentAliasKey + '.' + anchor;
      aliasMap[aliasKey] = alias;

      if (connectedWith) {
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ` + this._joinCondition([`${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`, connectedWith], params, 'AND', parentAliasKey, aliasMap));
      } else if (remoteFields) {
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ` + remoteFields.map(remoteField => `${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`).join(' OR '));
      } else {
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`);
      }

      if (subAssociations) {
        let subJoinings = this._joinAssociations(subAssociations, aliasKey, alias, aliasMap, startId, params);

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

      return condition.map(c => this._joinCondition(c, params, null, hasJoining, aliasMap)).join(` ${joinOperator} `);
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

    return 'A.' + mysql.escapeId(fieldName);
  }

  _escapeIdWithAlias(fieldName, mainEntity, aliasMap) {
    if (mainEntity) {
      return this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap);
    }

    return mysql.escapeId(fieldName);
  }

  _wrapCondition(fieldName, value, valuesSeq, hasJoining, aliasMap) {
    if (_.isNil(value)) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
    }

    if (_.isPlainObject(value)) {
      let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

      if (hasOperator) {
        return _.map(value, (v, k) => {
          if (k && k[0] === '$') {
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
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';

              case '$nin':
              case '$notIn':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                valuesSeq.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';

              case '$startWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$startWith" operator.');
                }

                valuesSeq.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$endWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }

                valuesSeq.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$like':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$like" operator.');
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

      valuesSeq.push(JSON.stringify(value));
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsInNxbEluZm8iLCJidWlsZFF1ZXJ5IiwidG90YWxDb3VudCIsImNvdW50U3FsIiwiY291bnRSZXN1bHQiLCJoYXNKb2luaW5nIiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXNNYXAiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm1hcCIsIm4iLCJjb25jYXQiLCIkYXNzb2NpYXRpb24iLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJqb2luaW5ncyIsImpvaW5pbmdQYXJhbXMiLCJfam9pbkFzc29jaWF0aW9ucyIsInNlbGVjdENvbG9tbnMiLCJfYnVpbGRDb2x1bW5zIiwiZm9yRWFjaCIsInAiLCJqb2luIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc0ludGVnZXIiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImFzc29jSW5mbyIsImpvaW5UeXBlIiwibG9jYWxGaWVsZCIsInJlbW90ZUZpZWxkIiwib3V0cHV0IiwiZW50aXR5IiwiYW5jaG9yIiwicmVtb3RlRmllbGRzIiwic3ViQXNzb2NpYXRpb25zIiwiY29ubmVjdGVkV2l0aCIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJsZW5ndGgiLCJqb2luT3BlcmF0b3IiLCJBcnJheSIsImlzQXJyYXkiLCJjIiwiaXNQbGFpbk9iamVjdCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsIl93cmFwQ29uZGl0aW9uIiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJtc2ciLCJ2YWx1ZXNTZXEiLCJpc05pbCIsImhhc09wZXJhdG9yIiwiayIsInYiLCJpc0Zpbml0ZSIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJvbWl0IiwidHlwZSIsIm5hbWUiLCJhcmdzIiwiZXhwciIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBc0NMLE9BQU8sQ0FBQyxjQUFELENBQW5EOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsUUFBRjtBQUFZQyxFQUFBQTtBQUFaLElBQTRCUCxPQUFPLENB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LENBQXJCO0FBQ0g7O0FBRUQsVUFBTSxJQUFJN0csZ0JBQUosQ0FBc0IsNEJBQTJCZ0ssSUFBSSxDQUFDQyxTQUFMLENBQWVlLE9BQWYsQ0FBd0IsRUFBekUsQ0FBTjtBQUNIOztBQUVELFFBQU0xSCxlQUFOLENBQXNCOUMsT0FBdEIsRUFBK0I7QUFDM0IsV0FBUUEsT0FBTyxJQUFJQSxPQUFPLENBQUMwSyxVQUFwQixHQUFrQzFLLE9BQU8sQ0FBQzBLLFVBQTFDLEdBQXVELEtBQUt2SixRQUFMLENBQWNuQixPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXVELG1CQUFOLENBQTBCOUMsSUFBMUIsRUFBZ0NULE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQzBLLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBSzVKLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDtBQUNKOztBQXZ3QmtDOztBQUFqQ1osYyxDQU1LcUMsZSxHQUFrQnNHLE1BQU0sQ0FBQ21DLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQW93QjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUJwTCxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsID0gJ0lOU0VSVCBJTlRPID8/IFNFVCA/JztcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgY29uZGl0aW9uLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSA/PyBTRVQgPyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWxJbmZvID0gdGhpcy5idWlsZFF1ZXJ5KG1vZGVsLCBjb25kaXRpb24pO1xuXG4gICAgICAgIGxldCByZXN1bHQsIHRvdGFsQ291bnQ7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBbIGNvdW50UmVzdWx0IF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uY291bnRTcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRhc3NvY2lhdGlvbiwgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRhc3NvY2lhdGlvbikgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRhc3NvY2lhdGlvbiwgbW9kZWwsICdBJywgYWxpYXNNYXAsIDEsIGpvaW5pbmdQYXJhbXMpO1xuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsIFxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gJHF1ZXJ5ICYmIHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICAgICAgIFxuICAgICAgICBcbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7XG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICBfLmVhY2goYXNzb2NpYXRpb25zLCBhc3NvY0luZm8gPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCBudG9sKHN0YXJ0SWQrKyk7IFxuICAgICAgICAgICAgbGV0IHsgam9pblR5cGUsIGxvY2FsRmllbGQsIHJlbW90ZUZpZWxkIH0gPSBhc3NvY0luZm87XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gKCR7YXNzb2NJbmZvLnNxbH0pICR7YWxpYXN9IE9OICR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCk7XG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLjonICsgYWxpYXNdID0gYWxpYXM7IFxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgYW5jaG9yLCByZW1vdGVGaWVsZHMsIHN1YkFzc29jaWF0aW9ucywgY29ubmVjdGVkV2l0aCB9ID0gYXNzb2NJbmZvOyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgXG5cbiAgICAgICAgICAgIGlmIChjb25uZWN0ZWRXaXRoKSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiBgICsgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2pvaW5Db25kaXRpb24oWyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWAsXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgIF0sIHBhcmFtcywgJ0FORCcsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZW1vdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OIGAgKyBcbiAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGRzLm1hcChyZW1vdGVGaWVsZCA9PiBgJHthbGlhc30uJHtteXNxbC5lc2NhcGVJZChyZW1vdGVGaWVsZCl9ID0gJHtwYXJlbnRBbGlhc30uJHtteXNxbC5lc2NhcGVJZChsb2NhbEZpZWxkKX1gKS5qb2luKCcgT1IgJylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NpYXRpb25zLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYSBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29uZGl0aW9uID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW21haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gO1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIG1zZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKG1zZyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ0EuJyArIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKG1haW5FbnRpdHkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxpa2UnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRsaWtlXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlc1NlcS5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1uKGNvbCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIChpc1F1b3RlZChjb2wpIHx8IGNvbCA9PT0gJyonKSA/IGNvbCA6IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdudW1iZXInKSB7XG4gICAgICAgICAgICByZXR1cm4gY29sO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb2wpKSB7ICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcykge1xuICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZyc7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChjb2wuYWxpYXMpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29sLm5hbWUgKyAnKCcgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdleHByZXNzaW9uJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbC5leHByLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPyAnJyA6ICcgREVTQycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=