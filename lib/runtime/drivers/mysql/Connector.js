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

  async find_(model, {
    $association,
    $projection,
    $query,
    $groupBy,
    $orderBy,
    $offset,
    $limit,
    $totalCount
  }, options) {
    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false;

    if ($association) {
      joinings = this._joinAssociations($association, model, 'A', aliasMap, 1, params);
      hasJoining = model;
    }

    let whereClause = $query && this._joinCondition($query, params, null, hasJoining, aliasMap);

    let selectColomns = $projection ? this._buildColumns($projection, hasJoining, aliasMap) : '*';
    let sql = ' FROM ' + mysql.escapeId(model);

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

    let result, totalCount;

    if ($totalCount) {
      let countSubject;

      if (typeof $totalCount === 'string') {
        countSubject = 'DISTINCT(' + this._escapeIdWithAlias($totalCount, hasJoining, aliasMap) + ')';
      } else {
        countSubject = '*';
      }

      let sqlCount = `SELECT COUNT(${countSubject}) AS count` + sql;
      let [countResult] = await this.execute_(sqlCount, params, options);
      totalCount = countResult['count'];
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

    if (hasJoining) {
      options = { ...options,
        rowsAsArray: true
      };
      result = await this.execute_(sql, params, options);

      let reverseAliasMap = _.reduce(aliasMap, (result, alias, nodePath) => {
        result[alias] = nodePath.split('.').slice(1).map(n => ':' + n);
        return result;
      }, {});

      if ($totalCount) {
        return result.concat(reverseAliasMap, totalCount);
      }

      return result.concat(reverseAliasMap);
    }

    result = await this.execute_(sql, params, options);

    if ($totalCount) {
      return [result, totalCount];
    }

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

    _.each(associations, ({
      entity,
      joinType,
      anchor,
      localField,
      remoteField,
      remoteFields,
      subAssociations,
      connectedWith
    }) => {
      let alias = ntol(startId++);
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
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$and" operator value should be an array or plain object.');
          }

          return '(' + this._joinCondition(value, valuesSeq, 'AND', hasJoining, aliasMap) + ')';
        }

        if (key === '$any' || key === '$or') {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$or" operator value should be a plain object.');
          }

          return '(' + this._joinCondition(value, valuesSeq, 'OR', hasJoining, aliasMap) + ')';
        }

        if (key === '$not') {
          if (Array.isArray(value)) {
            if (!(value.length > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, valuesSeq, null, hasJoining, aliasMap) + ')';
          }

          if (_.isPlainObject(value)) {
            let numOfElement = Object.keys(value).length;

            if (!(numOfElement > 0)) {
              throw new Error('"$not" operator value should be non-empty.');
            }

            return 'NOT (' + this._joinCondition(value, valuesSeq, null, hasJoining, aliasMap) + ')';
          }

          if (!(typeof value === 'string')) {
            throw new Error('Unsupported condition!');
          }

          return 'NOT (' + condition + ')';
        }

        return this._wrapCondition(key, value, valuesSeq, hasJoining, aliasMap);
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

    if (!(fieldName in this.meta.fields)) {
      throw new BusinessError(`Unknown column reference: ${fieldName}`);
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
      return isQuoted(col) || col === '*' ? col : mysql.escapeId(col);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsIiRhc3NvY2lhdGlvbiIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCIkdG90YWxDb3VudCIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsImpvaW4iLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsInRvdGFsQ291bnQiLCJjb3VudFN1YmplY3QiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJzcWxDb3VudCIsImNvdW50UmVzdWx0IiwiaXNJbnRlZ2VyIiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJtYXAiLCJuIiwiY29uY2F0IiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJlbnRpdHkiLCJqb2luVHlwZSIsImFuY2hvciIsImxvY2FsRmllbGQiLCJyZW1vdGVGaWVsZCIsInJlbW90ZUZpZWxkcyIsInN1YkFzc29jaWF0aW9ucyIsImNvbm5lY3RlZFdpdGgiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwibGVuZ3RoIiwidmFsdWVzU2VxIiwiam9pbk9wZXJhdG9yIiwiQXJyYXkiLCJpc0FycmF5IiwiYyIsImlzUGxhaW5PYmplY3QiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwibWV0YSIsImZpZWxkcyIsImlzTmlsIiwiaGFzT3BlcmF0b3IiLCJrIiwidiIsImlzRmluaXRlIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsIm9taXQiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXNDTCxPQUFPLENBQUMsY0FBRCxDQUFuRDs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLFFBQUY7QUFBWUMsRUFBQUE7QUFBWixJQUE0QlAsT0FBTyxDQUFDLHFCQUFELENBQXpDOztBQUNBLE1BQU1RLElBQUksR0FBR1IsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQU9B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J3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsID0gJ0lOU0VSVCBJTlRPID8/IFNFVCA/JztcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgY29uZGl0aW9uLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSA/PyBTRVQgPyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgeyAkYXNzb2NpYXRpb24sICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9LCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICgkYXNzb2NpYXRpb24pIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBwYXJhbXMpO1xuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gJHF1ZXJ5ICYmIHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcbiAgICAgICAgXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBjb3VudFN1YmplY3Q7XG5cbiAgICAgICAgICAgIGlmICh0eXBlb2YgJHRvdGFsQ291bnQgPT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJ0RJU1RJTkNUKCcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcygkdG90YWxDb3VudCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnKic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsZXQgc3FsQ291bnQgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsQ291bnQsIHBhcmFtcywgb3B0aW9ucyk7ICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7XG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyAgXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2UoYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgZW50aXR5LCBqb2luVHlwZSwgYW5jaG9yLCBsb2NhbEZpZWxkLCByZW1vdGVGaWVsZCwgcmVtb3RlRmllbGRzLCBzdWJBc3NvY2lhdGlvbnMsIGNvbm5lY3RlZFdpdGggfSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJZCsrKTsgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgaWYgKGNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OIGAgKyBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fam9pbkNvbmRpdGlvbihbIFxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgXSwgcGFyYW1zLCAnQU5EJywgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlbW90ZUZpZWxkcykge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gYCArIFxuICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZHMubWFwKHJlbW90ZUZpZWxkID0+IGAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWApLmpvaW4oJyBPUiAnKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY2lhdGlvbnMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY2lhdGlvbnMsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHZhbHVlc1NlcSBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHZhbHVlc1NlcSwgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+IHRoaXMuX2pvaW5Db25kaXRpb24oYywgdmFsdWVzU2VxLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJykge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgdmFsdWVzU2VxLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJykge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb25kaXRpb24gPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzID0gYWxpYXNNYXBbbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1zZyA9IGBVbmtub3duIGNvbHVtbiByZWZlcmVuY2U6ICR7ZmllbGROYW1lfWA7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgbXNnLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IobXNnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnQS4nICsgbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCEoZmllbGROYW1lIGluIHRoaXMubWV0YS5maWVsZHMpKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFsdWVzU2VxLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gKGlzUXVvdGVkKGNvbCkgfHwgY29sID09PSAnKicpID8gY29sIDogbXlzcWwuZXNjYXBlSWQoY29sKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkge1xuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcyAmJiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9IFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29sLm5hbWUgKyAnKCcgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MpIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA/ICcnIDogJyBERVNDJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==