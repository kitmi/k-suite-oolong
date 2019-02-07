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
    $limit
  }, options) {
    let params = [],
        aliasMap = {
      [model]: 'A'
    },
        joinings,
        hasJoining = false;

    if (!_.isEmpty($association)) {
      joinings = this._joinAssociations($association, model, 'A', aliasMap, 1, params);
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
      options = { ...options,
        rowsAsArray: true
      };
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
      isList,
      subAssociations,
      connectedWith
    }) => {
      let alias = ntol(startId++);
      let aliasKey = parentAliasKey + '.' + anchor;
      aliasMap[aliasKey] = alias;

      if (connectedWith) {
        joinings.push(`${joinType} ${mysql.escapeId(entity)} ${alias} ON ` + this._joinCondition([`${alias}.${mysql.escapeId(remoteField)} = ${parentAlias}.${mysql.escapeId(localField)}`, connectedWith], params, 'AND', parentAliasKey, aliasMap));
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

          return this._joinCondition(value, valuesSeq, 'AND', hasJoining, aliasMap);
        }

        if (key === '$any' || key === '$or') {
          if (!(Array.isArray(value) || _.isPlainObject(value))) {
            throw new Error('"$or" operator value should be a plain object.');
          }

          return this._joinCondition(value, valuesSeq, 'OR', hasJoining, aliasMap);
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
        throw new BusinessError(`Unknown column reference: ${fieldName}`);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsIiRhc3NvY2lhdGlvbiIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsImlzRW1wdHkiLCJfam9pbkFzc29jaWF0aW9ucyIsIl9idWlsZENvbHVtbnMiLCJqb2luIiwiX2J1aWxkR3JvdXBCeSIsIl9idWlsZE9yZGVyQnkiLCJpc0ludGVnZXIiLCJyZXZlcnNlQWxpYXNNYXAiLCJyZWR1Y2UiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm1hcCIsIm4iLCJjb25jYXQiLCJnZXRJbnNlcnRlZElkIiwiaW5zZXJ0SWQiLCJ1bmRlZmluZWQiLCJnZXROdW1PZkFmZmVjdGVkUm93cyIsImFmZmVjdGVkUm93cyIsImFzc29jaWF0aW9ucyIsInBhcmVudEFsaWFzS2V5IiwicGFyZW50QWxpYXMiLCJzdGFydElkIiwiZWFjaCIsImVudGl0eSIsImpvaW5UeXBlIiwiYW5jaG9yIiwibG9jYWxGaWVsZCIsInJlbW90ZUZpZWxkIiwiaXNMaXN0Iiwic3ViQXNzb2NpYXRpb25zIiwiY29ubmVjdGVkV2l0aCIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJsZW5ndGgiLCJ2YWx1ZXNTZXEiLCJqb2luT3BlcmF0b3IiLCJBcnJheSIsImlzQXJyYXkiLCJjIiwiaXNQbGFpbk9iamVjdCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsIl93cmFwQ29uZGl0aW9uIiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJfZXNjYXBlSWRXaXRoQWxpYXMiLCJpc05pbCIsImhhc09wZXJhdG9yIiwiayIsInYiLCJpc0Zpbml0ZSIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJvbWl0IiwidHlwZSIsIm5hbWUiLCJhcmdzIiwiZ3JvdXBCeSIsImJ5IiwiaGF2aW5nIiwiZ3JvdXBCeUNsYXVzZSIsImhhdmluZ0NsdXNlIiwib3JkZXJCeSIsImFzYyIsImNvbm5lY3Rpb24iLCJmcmVlemUiLCJSZXBlYXRhYmxlUmVhZCIsIlJlYWRDb21taXR0ZWQiLCJSZWFkVW5jb21taXR0ZWQiLCJSZXJpYWxpemFibGUiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DQyxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBaUJELE9BQU8sQ0FBQyxnQ0FBRCxDQUE5Qjs7QUFDQSxNQUFNRSxLQUFLLEdBQUdELFVBQVUsQ0FBQyxnQkFBRCxDQUF4Qjs7QUFDQSxNQUFNRSxTQUFTLEdBQUdILE9BQU8sQ0FBQyxpQkFBRCxDQUF6Qjs7QUFDQSxNQUFNO0FBQUVJLEVBQUFBLGdCQUFGO0FBQW9CQyxFQUFBQTtBQUFwQixJQUFzQ0wsT0FBTyxDQUFDLGNBQUQsQ0FBbkQ7O0FBQ0EsTUFBTTtBQUFFTSxFQUFBQSxRQUFGO0FBQVlDLEVBQUFBO0FBQVosSUFBNEJQLE9BQU8sQ0FBQyxxQkFBRCxDQUF6Qzs7QUFDQSxNQUFNUSxJQUFJLEdBQUdSLE9BQU8sQ0FBQyxrQkFBRCxDQUFwQjs7QUFPQSxNQUFNUyxjQUFOLFNBQTZCTixTQUE3QixDQUF1QztBQXVCbkNPLEVBQUFBLFdBQVcsQ0FBQ0MsZ0JBQUQsRUFBbUJDLE9BQW5CLEVBQTRCO0FBQ25DLFVBQU0sT0FBTixFQUFl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LENBQUNDLEdBQUQsRUFBTVosR0FBTixLQUFjLEtBQUtYLGtCQUFMLENBQXdCVyxHQUF4QixFQUE2QmhFLFVBQTdCLEVBQXlDRixRQUF6QyxLQUFzRDhFLEdBQUcsR0FBRyxFQUFILEdBQVEsT0FBakUsQ0FBN0IsRUFBd0d4RSxJQUF4RyxDQUE2RyxJQUE3RyxDQUFyQjtBQUNIOztBQUVELFVBQU0sSUFBSTNGLGdCQUFKLENBQXNCLDRCQUEyQm1KLElBQUksQ0FBQ0MsU0FBTCxDQUFlYyxPQUFmLENBQXdCLEVBQXpFLENBQU47QUFDSDs7QUFFRCxRQUFNNUcsZUFBTixDQUFzQjlDLE9BQXRCLEVBQStCO0FBQzNCLFdBQVFBLE9BQU8sSUFBSUEsT0FBTyxDQUFDNEosVUFBcEIsR0FBa0M1SixPQUFPLENBQUM0SixVQUExQyxHQUF1RCxLQUFLekksUUFBTCxDQUFjbkIsT0FBZCxDQUE5RDtBQUNIOztBQUVELFFBQU11RCxtQkFBTixDQUEwQjlDLElBQTFCLEVBQWdDVCxPQUFoQyxFQUF5QztBQUNyQyxRQUFJLENBQUNBLE9BQUQsSUFBWSxDQUFDQSxPQUFPLENBQUM0SixVQUF6QixFQUFxQztBQUNqQyxhQUFPLEtBQUs5SSxXQUFMLENBQWlCTCxJQUFqQixDQUFQO0FBQ0g7QUFDSjs7QUF6cEJrQzs7QUFBakNaLGMsQ0FNS3FDLGUsR0FBa0IwRixNQUFNLENBQUNpQyxNQUFQLENBQWM7QUFDbkNDLEVBQUFBLGNBQWMsRUFBRSxpQkFEbUI7QUFFbkNDLEVBQUFBLGFBQWEsRUFBRSxnQkFGb0I7QUFHbkNDLEVBQUFBLGVBQWUsRUFBRSxrQkFIa0I7QUFJbkNDLEVBQUFBLFlBQVksRUFBRTtBQUpxQixDQUFkLEM7QUFzcEI3QkMsTUFBTSxDQUFDQyxPQUFQLEdBQWlCdEssY0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hcHAvbGliL3V0aWxzL0hlbHBlcnMnKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBPb2xvbmdVc2FnZUVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSByZXF1aXJlKCcuLi8uLi9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLl9wb29scyA9IHt9O1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgICB9XG5cbiAgICBzdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKSB7XG4gICAgICAgIHBvc3Q6ICFjb25uIHx8IGl0LCAnQ29ubmVjdGlvbiBvYmplY3Qgbm90IGZvdW5kIGluIGFjaXR2ZSBjb25uZWN0aW9ucyBtYXAuJzsgXG4gICAgICAgIHJldHVybiB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5nZXQoY29ubik7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmtleXMoKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyh0aGlzLl9wb29scywgYXN5bmMgKHBvb2wsIGNzKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBwb29sLmVuZCgpO1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlZCBwb29sOiAnICsgY3MpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMuZ2V0TmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgcG9vbCA9IHRoaXMuX3Bvb2xzW2NzS2V5XTtcblxuICAgICAgICBpZiAoIXBvb2wpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgICAgIHRoaXMuX3Bvb2xzW2NzS2V5XSA9IHBvb2w7XG5cbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDcmVhdGVkIHBvb2w6ICcgKyBjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgcG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLnNldChjb25uLCBjc0tleSk7XG5cbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NyZWF0ZSBjb25uZWN0aW9uOiAnICsgY3NLZXkpO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYSBkYXRhYmFzZSBjb25uZWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBkaXNjb25uZWN0Xyhjb25uKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNzID0gdGhpcy5zdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuZGVsZXRlKGNvbm4pO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDbG9zZSBjb25uZWN0aW9uOiAnICsgKGNzIHx8ICcqdW5rbm93bionKSk7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIGNvbm4ucmVsZWFzZSgpOyAgICAgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogU3RhcnQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyAtIE9wdGlvbnNcbiAgICAgKiBAcHJvcGVydHkge3N0cmluZ30gW29wdGlvbnMuaXNvbGF0aW9uTGV2ZWxdXG4gICAgICovXG4gICAgYXN5bmMgYmVnaW5UcmFuc2FjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHRoaXMuY29ubmVjdF8oKTtcblxuICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLmlzb2xhdGlvbkxldmVsKSB7XG4gICAgICAgICAgICAvL29ubHkgYWxsb3cgdmFsaWQgb3B0aW9uIHZhbHVlIHRvIGF2b2lkIGluamVjdGlvbiBhdHRhY2hcbiAgICAgICAgICAgIGxldCBpc29sYXRpb25MZXZlbCA9IF8uZmluZChNeVNRTENvbm5lY3Rvci5Jc29sYXRpb25MZXZlbHMsICh2YWx1ZSwga2V5KSA9PiBvcHRpb25zLmlzb2xhdGlvbkxldmVsID09PSBrZXkgfHwgb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0gdmFsdWUpO1xuICAgICAgICAgICAgaWYgKCFpc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGlzb2xhdGlvbiBsZXZlbDogXCIke2lzb2xhdGlvbkxldmVsfVwiIVwiYCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGF3YWl0IGNvbm4ucXVlcnkoJ1NFVCBTRVNTSU9OIFRSQU5TQUNUSU9OIElTT0xBVElPTiBMRVZFTCAnICsgaXNvbGF0aW9uTGV2ZWwpOyAgICAgICAgICAgIFxuICAgICAgICB9XG5cbiAgICAgICAgYXdhaXQgY29ubi5iZWdpblRyYW5zYWN0aW9uKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4uY29tbWl0KCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ29tbWl0cyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSb2xsYmFjayBhIHRyYW5zYWN0aW9uLlxuICAgICAqIEBwYXJhbSB7TXlTUUxDb25uZWN0aW9ufSBjb25uIC0gTXlTUUwgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyByb2xsYmFja18oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLnJvbGxiYWNrKCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnUm9sbGJhY2tzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4ZWN1dGUgdGhlIHNxbCBzdGF0ZW1lbnQuXG4gICAgICpcbiAgICAgKiBAcGFyYW0ge1N0cmluZ30gc3FsIC0gVGhlIFNRTCBzdGF0ZW1lbnQgdG8gZXhlY3V0ZS5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gcGFyYW1zIC0gUGFyYW1ldGVycyB0byBiZSBwbGFjZWQgaW50byB0aGUgU1FMIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0ge29iamVjdH0gW29wdGlvbnNdIC0gRXhlY3V0aW9uIG9wdGlvbnMuXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBXaGV0aGVyIHRvIHVzZSBwcmVwYXJlZCBzdGF0ZW1lbnQgd2hpY2ggaXMgY2FjaGVkIGFuZCByZS11c2VkIGJ5IGNvbm5lY3Rpb24uXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy5yb3dzQXNBcnJheV0gLSBUbyByZWNlaXZlIHJvd3MgYXMgYXJyYXkgb2YgY29sdW1ucyBpbnN0ZWFkIG9mIGhhc2ggd2l0aCBjb2x1bW4gbmFtZSBhcyBrZXkuXG4gICAgICogQHByb3BlcnR5IHtNeVNRTENvbm5lY3Rpb259IFtvcHRpb25zLmNvbm5lY3Rpb25dIC0gRXhpc3RpbmcgY29ubmVjdGlvbi5cbiAgICAgKi9cbiAgICBhc3luYyBleGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBjb25uO1xuXG4gICAgICAgIHRyeSB7XG4gICAgICAgICAgICBjb25uID0gYXdhaXQgdGhpcy5fZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucyk7XG5cbiAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQgfHwgKG9wdGlvbnMgJiYgb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCkpIHtcbiAgICAgICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1NRTFN0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIHNxbCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IGZvcm1hdGVkU1FMID0gcGFyYW1zID8gY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpIDogc3FsO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ1NRTFN0YXRlbWVudCkge1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgZm9ybWF0ZWRTUUwpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGF3YWl0IGNvbm4ucXVlcnkoeyBzcWw6IGZvcm1hdGVkU1FMLCByb3dzQXNBcnJheTogdHJ1ZSB9KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KGZvcm1hdGVkU1FMLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiByb3dzMjtcbiAgICAgICAgfSBjYXRjaCAoZXJyKSB7ICAgICAgXG4gICAgICAgICAgICB0aHJvdyBlcnI7XG4gICAgICAgIH0gZmluYWxseSB7XG4gICAgICAgICAgICBjb25uICYmIGF3YWl0IHRoaXMuX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGFzeW5jIHBpbmdfKCkge1xuICAgICAgICBsZXQgWyBwaW5nIF0gPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKCdTRUxFQ1QgMSBBUyByZXN1bHQnKTtcbiAgICAgICAgcmV0dXJuIHBpbmcgJiYgcGluZy5yZXN1bHQgPT09IDE7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgbmV3IGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGNyZWF0ZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbCA9ICdJTlNFUlQgSU5UTyA/PyBTRVQgPyc7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogVXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHVwZGF0ZV8obW9kZWwsIGRhdGEsIGNvbmRpdGlvbiwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMpOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgPz8gU0VUID8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZXBsYWNlIGFuIGV4aXN0aW5nIGVudGl0eSBvciBjcmVhdGUgYSBuZXcgb25lLlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gZGF0YSBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgcmVwbGFjZV8obW9kZWwsIGRhdGEsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgc3FsID0gJ1JFUExBQ0UgPz8gU0VUID8nO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBSZW1vdmUgYW4gZXhpc3RpbmcgZW50aXR5LlxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZGVsZXRlXyhtb2RlbCwgY29uZGl0aW9uLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihjb25kaXRpb24sIHBhcmFtcyk7ICAgICAgICBcblxuICAgICAgICBsZXQgc3FsID0gJ0RFTEVURSBGUk9NID8/IFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBQZXJmb3JtIHNlbGVjdCBvcGVyYXRpb24uXG4gICAgICogQHBhcmFtIHsqfSBtb2RlbCBcbiAgICAgKiBAcGFyYW0geyp9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0geyp9IG9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIHsgJGFzc29jaWF0aW9uLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCB9LCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbXSwgYWxpYXNNYXAgPSB7IFttb2RlbF06ICdBJyB9LCBqb2luaW5ncywgaGFzSm9pbmluZyA9IGZhbHNlO1xuXG4gICAgICAgIGlmICghXy5pc0VtcHR5KCRhc3NvY2lhdGlvbikpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucygkYXNzb2NpYXRpb24sIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBwYXJhbXMpO1xuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gJHF1ZXJ5ICYmIHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgXG4gICAgICAgIGxldCBzcWwgPSAnU0VMRUNUICcgKyAoJHByb2plY3Rpb24gPyB0aGlzLl9idWlsZENvbHVtbnMoJHByb2plY3Rpb24sIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJykgKyAnIEZST00gJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJGdyb3VwQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZEdyb3VwQnkoJGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRsaW1pdCkgJiYgJGxpbWl0ID4gMCkge1xuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkbGltaXQpO1xuICAgICAgICB9IFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgT0ZGU0VUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgb3B0aW9ucyA9IHsgLi4ub3B0aW9ucywgcm93c0FzQXJyYXk6IHRydWUgfTtcbiAgICAgICAgICAgIGxldCByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKGFsaWFzTWFwLCAocmVzdWx0LCBhbGlhcywgbm9kZVBhdGgpID0+IHtcbiAgICAgICAgICAgICAgICByZXN1bHRbYWxpYXNdID0gbm9kZVBhdGguc3BsaXQoJy4nKS5zbGljZSgxKS5tYXAobiA9PiAnOicgKyBuKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgICAgICAgICAgfSwge30pOyAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiByZXN1bHQuY29uY2F0KHJldmVyc2VBbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgZ2V0SW5zZXJ0ZWRJZChyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0Lmluc2VydElkID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuaW5zZXJ0SWQgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBnZXROdW1PZkFmZmVjdGVkUm93cyhyZXN1bHQpIHtcbiAgICAgICAgcmV0dXJuIHJlc3VsdCAmJiB0eXBlb2YgcmVzdWx0LmFmZmVjdGVkUm93cyA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0LmFmZmVjdGVkUm93cyA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKHsgZW50aXR5LCBqb2luVHlwZSwgYW5jaG9yLCBsb2NhbEZpZWxkLCByZW1vdGVGaWVsZCwgaXNMaXN0LCBzdWJBc3NvY2lhdGlvbnMsIGNvbm5lY3RlZFdpdGggfSkgPT4geyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IG50b2woc3RhcnRJZCsrKTsgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgaWYgKGNvbm5lY3RlZFdpdGgpIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OIGAgKyBcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5fam9pbkNvbmRpdGlvbihbIFxuICAgICAgICAgICAgICAgICAgICAgICAgYCR7YWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQocmVtb3RlRmllbGQpfSA9ICR7cGFyZW50QWxpYXN9LiR7bXlzcWwuZXNjYXBlSWQobG9jYWxGaWVsZCl9YCxcbiAgICAgICAgICAgICAgICAgICAgICAgIGNvbm5lY3RlZFdpdGhcbiAgICAgICAgICAgICAgICAgICAgXSwgcGFyYW1zLCAnQU5EJywgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKVxuICAgICAgICAgICAgICAgICk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICR7bXlzcWwuZXNjYXBlSWQoZW50aXR5KX0gJHthbGlhc30gT04gJHthbGlhc30uJHtteXNxbC5lc2NhcGVJZChyZW1vdGVGaWVsZCl9ID0gJHtwYXJlbnRBbGlhc30uJHtteXNxbC5lc2NhcGVJZChsb2NhbEZpZWxkKX1gKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jaWF0aW9ucykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jaWF0aW9ucywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gdmFsdWVzU2VxIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgdmFsdWVzU2VxLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gdGhpcy5fam9pbkNvbmRpdGlvbihjLCB2YWx1ZXNTZXEsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCB2YWx1ZXNTZXEsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJG9yXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGEgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHZhbHVlc1NlcSwgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHZhbHVlc1NlcSwgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHZhbHVlc1NlcSwgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGFzc2VydDogdHlwZW9mIGNvbmRpdGlvbiA9PT0gJ3N0cmluZycsICdVbnN1cHBvcnRlZCBjb25kaXRpb24hJztcblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGFsaWFzICsgJy4nICsgbXlzcWwuZXNjYXBlSWQoYWN0dWFsRmllbGROYW1lKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiAnQS4nICsgbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gKG1haW5FbnRpdHkgPyBcbiAgICAgICAgICAgIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgOiBcbiAgICAgICAgICAgIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSkpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIGxldCBoYXNPcGVyYXRvciA9IF8uZmluZChPYmplY3Qua2V5cyh2YWx1ZSksIGsgPT4gayAmJiBrWzBdID09PSAnJCcpO1xuXG4gICAgICAgICAgICBpZiAoaGFzT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gXy5tYXAodmFsdWUsICh2LCBrKSA9PiB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChrICYmIGtbMF0gPT09ICckJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gb3BlcmF0b3JcbiAgICAgICAgICAgICAgICAgICAgICAgIHN3aXRjaCAoaykge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxdWFsJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lcSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5vdEVxdWFsJzogICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5PVCBOVUxMJztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9ICAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1ByaW1pdGl2ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PiA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RcIiBvciBcIiQ+XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPj0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID49ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbHQnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbic6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0ZVwiIG9yIFwiJDxcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0ZVwiIG9yIFwiJDw9XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlc1NlcS5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIChpc1F1b3RlZChjb2wpIHx8IGNvbCA9PT0gJyonKSA/IGNvbCA6IG15c3FsLmVzY2FwZUlkKGNvbCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHtcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMgJiYgdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChjb2wuYWxpYXMpO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPyAnJyA6ICcgREVTQycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=