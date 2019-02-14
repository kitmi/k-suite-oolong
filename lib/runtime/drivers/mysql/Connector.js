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
      let sqlCount = 'SELECT COUNT(*) AS count' + sql;
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
    return mainEntity ? this._replaceFieldNameWithAlias(fieldName, mainEntity, aliasMap) : mysql.escapeId(fieldName);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsIiRhc3NvY2lhdGlvbiIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCIkdG90YWxDb3VudCIsImFsaWFzTWFwIiwiam9pbmluZ3MiLCJoYXNKb2luaW5nIiwiX2pvaW5Bc3NvY2lhdGlvbnMiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsImpvaW4iLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsInRvdGFsQ291bnQiLCJzcWxDb3VudCIsImNvdW50UmVzdWx0IiwiaXNJbnRlZ2VyIiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJtYXAiLCJuIiwiY29uY2F0IiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJlbnRpdHkiLCJqb2luVHlwZSIsImFuY2hvciIsImxvY2FsRmllbGQiLCJyZW1vdGVGaWVsZCIsInJlbW90ZUZpZWxkcyIsInN1YkFzc29jaWF0aW9ucyIsImNvbm5lY3RlZFdpdGgiLCJhbGlhc0tleSIsInN1YkpvaW5pbmdzIiwibGVuZ3RoIiwidmFsdWVzU2VxIiwiam9pbk9wZXJhdG9yIiwiQXJyYXkiLCJpc0FycmF5IiwiYyIsImlzUGxhaW5PYmplY3QiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNOaWwiLCJoYXNPcGVyYXRvciIsImsiLCJ2IiwiaXNGaW5pdGUiLCJFcnJvciIsIkpTT04iLCJzdHJpbmdpZnkiLCJjb2x1bW5zIiwiY2FzdEFycmF5IiwiY29sIiwiX2J1aWxkQ29sdW1uIiwib21pdCIsInR5cGUiLCJuYW1lIiwiYXJncyIsImdyb3VwQnkiLCJieSIsImhhdmluZyIsImdyb3VwQnlDbGF1c2UiLCJoYXZpbmdDbHVzZSIsIm9yZGVyQnkiLCJhc2MiLCJjb25uZWN0aW9uIiwiZnJlZXplIiwiUmVwZWF0YWJsZVJlYWQiLCJSZWFkQ29tbWl0dGVkIiwiUmVhZFVuY29tbWl0dGVkIiwiUmVyaWFsaXphYmxlIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6Ijs7OztBQUFBLE1BQU07QUFBRUEsRUFBQUEsQ0FBRjtBQUFLQyxFQUFBQSxVQUFMO0FBQWlCQyxFQUFBQTtBQUFqQixJQUFvQ0MsT0FBTyxDQUFDLFVBQUQsQ0FBakQ7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQWlCRCxPQUFPLENBQUMsZ0NBQUQsQ0FBOUI7O0FBQ0EsTUFBTUUsS0FBSyxHQUFHRCxVQUFVLENBQUMsZ0JBQUQsQ0FBeEI7O0FBQ0EsTUFBTUUsU0FBUyxHQUFHSCxPQUFPLENBQUMsaUJBQUQsQ0FBekI7O0FBQ0EsTUFBTTtBQUFFSSxFQUFBQSxnQkFBRjtBQUFvQkMsRUFBQUE7QUFBcEIsSUFBc0NMLE9BQU8sQ0FBQyxjQUFELENBQW5EOztBQUNBLE1BQU07QUFBRU0sRUFBQUEsUUFBRjtBQUFZQyxFQUFBQTtBQUFaLElBQTRCUCxPQUFPLENBQUMscUJBQUQsQ0FBekM7O0FBQ0EsTUFBTVEsSUFBSSxHQUFHUixPQUFPLENBQUMsa0JBQUQsQ0FBcEI7O0FBT0EsTUFBTVMsY0FBTixTQUE2Qk4sU0FBN0IsQ0FBdUM7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LENBQWNuQixPQUFkLENBQTlEO0FBQ0g7O0FBRUQsUUFBTXVELG1CQUFOLENBQTBCOUMsSUFBMUIsRUFBZ0NULE9BQWhDLEVBQXlDO0FBQ3JDLFFBQUksQ0FBQ0EsT0FBRCxJQUFZLENBQUNBLE9BQU8sQ0FBQ2lLLFVBQXpCLEVBQXFDO0FBQ2pDLGFBQU8sS0FBS25KLFdBQUwsQ0FBaUJMLElBQWpCLENBQVA7QUFDSDtBQUNKOztBQXZzQmtDOztBQUFqQ1osYyxDQU1LcUMsZSxHQUFrQjhGLE1BQU0sQ0FBQ2tDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQW9zQjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUIzSyxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2VkIHBvb2w6ICcgKyBjcyk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcblxuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZWQgcG9vbDogJyArIGNzS2V5KTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlIGNvbm5lY3Rpb246ICcgKyAoY3MgfHwgJyp1bmtub3duKicpKTsgICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubi5yZWxlYXNlKCk7ICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTdGFydCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIC0gT3B0aW9uc1xuICAgICAqIEBwcm9wZXJ0eSB7c3RyaW5nfSBbb3B0aW9ucy5pc29sYXRpb25MZXZlbF1cbiAgICAgKi9cbiAgICBhc3luYyBiZWdpblRyYW5zYWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgdGhpcy5jb25uZWN0XygpO1xuXG4gICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgIC8vb25seSBhbGxvdyB2YWxpZCBvcHRpb24gdmFsdWUgdG8gYXZvaWQgaW5qZWN0aW9uIGF0dGFjaFxuICAgICAgICAgICAgbGV0IGlzb2xhdGlvbkxldmVsID0gXy5maW5kKE15U1FMQ29ubmVjdG9yLklzb2xhdGlvbkxldmVscywgKHZhbHVlLCBrZXkpID0+IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IGtleSB8fCBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSB2YWx1ZSk7XG4gICAgICAgICAgICBpZiAoIWlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgaXNvbGF0aW9uIGxldmVsOiBcIiR7aXNvbGF0aW9uTGV2ZWx9XCIhXCJgKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgYXdhaXQgY29ubi5xdWVyeSgnU0VUIFNFU1NJT04gVFJBTlNBQ1RJT04gSVNPTEFUSU9OIExFVkVMICcgKyBpc29sYXRpb25MZXZlbCk7ICAgICAgICAgICAgXG4gICAgICAgIH1cblxuICAgICAgICBhd2FpdCBjb25uLmJlZ2luVHJhbnNhY3Rpb24oKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdCZWdpbnMgYSBuZXcgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENvbW1pdCBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBjb21taXRfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5jb21taXQoKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgc3FsLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4uZXhlY3V0ZSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBsZXQgWyByb3dzMSBdID0gYXdhaXQgY29ubi5leGVjdXRlKHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHJvd3MxO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBsZXQgZm9ybWF0ZWRTUUwgPSBwYXJhbXMgPyBjb25uLmZvcm1hdChzcWwsIHBhcmFtcykgOiBzcWw7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBmb3JtYXRlZFNRTCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbDogZm9ybWF0ZWRTUUwsIHJvd3NBc0FycmF5OiB0cnVlIH0pO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IFsgcm93czIgXSA9IGF3YWl0IGNvbm4ucXVlcnkoZm9ybWF0ZWRTUUwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgcmV0dXJuIHJvd3MyO1xuICAgICAgICB9IGNhdGNoIChlcnIpIHsgICAgICBcbiAgICAgICAgICAgIHRocm93IGVycjtcbiAgICAgICAgfSBmaW5hbGx5IHtcbiAgICAgICAgICAgIGNvbm4gJiYgYXdhaXQgdGhpcy5fcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgYXN5bmMgcGluZ18oKSB7XG4gICAgICAgIGxldCBbIHBpbmcgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oJ1NFTEVDVCAxIEFTIHJlc3VsdCcpO1xuICAgICAgICByZXR1cm4gcGluZyAmJiBwaW5nLnJlc3VsdCA9PT0gMTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBuZXcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgY3JlYXRlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsID0gJ0lOU0VSVCBJTlRPID8/IFNFVCA/JztcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcbiAgICAgICAgcGFyYW1zLnB1c2goZGF0YSk7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgY29uZGl0aW9uLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSA/PyBTRVQgPyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgeyAkYXNzb2NpYXRpb24sICRwcm9qZWN0aW9uLCAkcXVlcnksICRncm91cEJ5LCAkb3JkZXJCeSwgJG9mZnNldCwgJGxpbWl0LCAkdG90YWxDb3VudCB9LCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICgkYXNzb2NpYXRpb24pIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBwYXJhbXMpO1xuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gJHF1ZXJ5ICYmIHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzZWxlY3RDb2xvbW5zID0gJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcbiAgICAgICAgXG4gICAgICAgIGxldCBzcWwgPSAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoJHRvdGFsQ291bnQpIHtcbiAgICAgICAgICAgIGxldCBzcWxDb3VudCA9ICdTRUxFQ1QgQ09VTlQoKikgQVMgY291bnQnICsgc3FsO1xuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsQ291bnQsIHBhcmFtcywgb3B0aW9ucyk7ICBcbiAgICAgICAgICAgIHRvdGFsQ291bnQgPSBjb3VudFJlc3VsdFsnY291bnQnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7XG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpOyAgXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2UoYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCwgdG90YWxDb3VudCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH0gXG5cbiAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgZW50aXR5LCBqb2luVHlwZSwgYW5jaG9yLCBsb2NhbEZpZWxkLCByZW1vdGVGaWVsZCwgcmVtb3RlRmllbGRzLCBzdWJBc3NvY2lhdGlvbnMsIGNvbm5lY3RlZFdpdGggfSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJZCsrKTsgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgaWYgKGNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OIGAgKyBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fam9pbkNvbmRpdGlvbihbIFxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgXSwgcGFyYW1zLCAnQU5EJywgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKHJlbW90ZUZpZWxkcykge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gYCArIFxuICAgICAgICAgICAgICAgICAgICByZW1vdGVGaWVsZHMubWFwKHJlbW90ZUZpZWxkID0+IGAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWApLmpvaW4oJyBPUiAnKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2UgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzdWJBc3NvY2lhdGlvbnMpIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgbGV0IHN1YkpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhzdWJBc3NvY2lhdGlvbnMsIGFsaWFzS2V5LCBhbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgc3RhcnRJZCArPSBzdWJKb2luaW5ncy5sZW5ndGg7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MgPSBqb2luaW5ncy5jb25jYXQoc3ViSm9pbmluZ3MpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICByZXR1cm4gam9pbmluZ3M7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU1FMIGNvbmRpdGlvbiByZXByZXNlbnRhdGlvblxuICAgICAqICAgUnVsZXM6XG4gICAgICogICAgIGRlZmF1bHQ6IFxuICAgICAqICAgICAgICBhcnJheTogT1JcbiAgICAgKiAgICAgICAga3YtcGFpcjogQU5EXG4gICAgICogICAgICRhbGw6IFxuICAgICAqICAgICAgICBhcnJheTogQU5EXG4gICAgICogICAgICRhbnk6XG4gICAgICogICAgICAgIGt2LXBhaXI6IE9SXG4gICAgICogICAgICRub3Q6XG4gICAgICogICAgICAgIGFycmF5OiBub3QgKCBvciApXG4gICAgICogICAgICAgIGt2LXBhaXI6IG5vdCAoIGFuZCApICAgICBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7YXJyYXl9IHZhbHVlc1NlcSBcbiAgICAgKi9cbiAgICBfam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHZhbHVlc1NlcSwgam9pbk9wZXJhdG9yLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShjb25kaXRpb24pKSB7XG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdPUic7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gY29uZGl0aW9uLm1hcChjID0+IHRoaXMuX2pvaW5Db25kaXRpb24oYywgdmFsdWVzU2VxLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbmRpdGlvbikpIHsgXG4gICAgICAgICAgICBpZiAoIWpvaW5PcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIGpvaW5PcGVyYXRvciA9ICdBTkQnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gXy5tYXAoY29uZGl0aW9uLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYWxsJyB8fCBrZXkgPT09ICckYW5kJykge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRhbmRcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgdmFsdWVzU2VxLCAnQU5EJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFueScgfHwga2V5ID09PSAnJG9yJykge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhIHBsYWluIG9iamVjdC4nOyAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsICdPUicsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJG5vdCcpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoQXJyYXkuaXNBcnJheSh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogdmFsdWUubGVuZ3RoID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcbiAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgbnVtT2ZFbGVtZW50ID0gT2JqZWN0LmtleXModmFsdWUpLmxlbmd0aDsgICBcbiAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogbnVtT2ZFbGVtZW50ID4gMCwgJ1wiJG5vdFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBub24tZW1wdHkuJzsgICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiB2YWx1ZSA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIGNvbmRpdGlvbiArICcpJzsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihrZXksIHZhbHVlLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0pLmpvaW4oYCAke2pvaW5PcGVyYXRvcn0gYCk7XG4gICAgICAgIH1cblxuICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb25kaXRpb24gPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgcmV0dXJuIGNvbmRpdGlvbjtcbiAgICB9XG5cbiAgICBfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKSB7XG4gICAgICAgIGxldCBwYXJ0cyA9IGZpZWxkTmFtZS5zcGxpdCgnLicpO1xuICAgICAgICBpZiAocGFydHMubGVuZ3RoID4gMSkge1xuICAgICAgICAgICAgbGV0IGFjdHVhbEZpZWxkTmFtZSA9IHBhcnRzLnBvcCgpO1xuICAgICAgICAgICAgbGV0IGFsaWFzID0gYWxpYXNNYXBbbWFpbkVudGl0eSArICcuJyArIHBhcnRzLmpvaW4oJy4nKV07XG4gICAgICAgICAgICBpZiAoIWFsaWFzKSB7XG4gICAgICAgICAgICAgICAgbGV0IG1zZyA9IGBVbmtub3duIGNvbHVtbiByZWZlcmVuY2U6ICR7ZmllbGROYW1lfWA7XG4gICAgICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgbXNnLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IEJ1c2luZXNzRXJyb3IobXNnKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnQS4nICsgbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gKG1haW5FbnRpdHkgPyBcbiAgICAgICAgICAgIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgOiBcbiAgICAgICAgICAgIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTk9UIElOICg/KSc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckc3RhcnRXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkc3RhcnRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZFdpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKHR5cGVvZiB2ICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBMSUtFID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbnN1cHBvcnRlZCBjb25kaXRpb24gb3BlcmF0b3I6IFwiJHtrfVwiIWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPcGVyYXRvciBzaG91bGQgbm90IGJlIG1peGVkIHdpdGggY29uZGl0aW9uIHZhbHVlLicpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSkuam9pbignIEFORCAnKTtcbiAgICAgICAgICAgIH0gIFxuXG4gICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgdmFsdWVzU2VxLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgeyAgICAgICAgXG4gICAgICAgIHJldHVybiBfLm1hcChfLmNhc3RBcnJheShjb2x1bW5zKSwgY29sID0+IHRoaXMuX2J1aWxkQ29sdW1uKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gKGlzUXVvdGVkKGNvbCkgfHwgY29sID09PSAnKicpID8gY29sIDogbXlzcWwuZXNjYXBlSWQoY29sKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkge1xuICAgICAgICAgICAgaWYgKGNvbC5hbGlhcyAmJiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9IFxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLnR5cGUgPT09ICdmdW5jdGlvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY29sLm5hbWUgKyAnKCcgKyAoY29sLmFyZ3MgPyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MpIDogJycpICsgJyknO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA/ICcnIDogJyBERVNDJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==