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

    if ($association) {
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

      return condition.map(c => '(' + this._joinCondition(c, valuesSeq, null, hasJoining, aliasMap) + ')').join(` ${joinOperator} `);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiX3Bvb2xzIiwiX2FjaXR2ZUNvbm5lY3Rpb25zIiwiTWFwIiwic3RyaW5nRnJvbUNvbm5lY3Rpb24iLCJjb25uIiwiaXQiLCJnZXQiLCJlbmRfIiwia2V5cyIsImRpc2Nvbm5lY3RfIiwicG9vbCIsImNzIiwiZW5kIiwibG9nIiwiY29ubmVjdF8iLCJjc0tleSIsImNvbm5Qcm9wcyIsImNyZWF0ZURhdGFiYXNlIiwiZGF0YWJhc2UiLCJwaWNrIiwiZ2V0TmV3Q29ubmVjdGlvblN0cmluZyIsImNyZWF0ZVBvb2wiLCJnZXRDb25uZWN0aW9uIiwic2V0IiwiZGVsZXRlIiwicmVsZWFzZSIsImJlZ2luVHJhbnNhY3Rpb25fIiwiaXNvbGF0aW9uTGV2ZWwiLCJmaW5kIiwiSXNvbGF0aW9uTGV2ZWxzIiwidmFsdWUiLCJrZXkiLCJxdWVyeSIsImJlZ2luVHJhbnNhY3Rpb24iLCJjb21taXRfIiwiY29tbWl0Iiwicm9sbGJhY2tfIiwicm9sbGJhY2siLCJleGVjdXRlXyIsInNxbCIsInBhcmFtcyIsIl9nZXRDb25uZWN0aW9uXyIsInVzZVByZXBhcmVkU3RhdGVtZW50IiwibG9nU1FMU3RhdGVtZW50Iiwicm93c0FzQXJyYXkiLCJleGVjdXRlIiwicm93czEiLCJmb3JtYXRlZFNRTCIsInJvd3MyIiwiZXJyIiwiX3JlbGVhc2VDb25uZWN0aW9uXyIsInBpbmdfIiwicGluZyIsInJlc3VsdCIsImNyZWF0ZV8iLCJtb2RlbCIsImRhdGEiLCJwdXNoIiwidXBkYXRlXyIsImNvbmRpdGlvbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJmaW5kXyIsIiRhc3NvY2lhdGlvbiIsIiRwcm9qZWN0aW9uIiwiJHF1ZXJ5IiwiJGdyb3VwQnkiLCIkb3JkZXJCeSIsIiRvZmZzZXQiLCIkbGltaXQiLCJhbGlhc01hcCIsImpvaW5pbmdzIiwiaGFzSm9pbmluZyIsIl9qb2luQXNzb2NpYXRpb25zIiwiX2J1aWxkQ29sdW1ucyIsImpvaW4iLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImlzSW50ZWdlciIsInJldmVyc2VBbGlhc01hcCIsInJlZHVjZSIsImFsaWFzIiwibm9kZVBhdGgiLCJzcGxpdCIsInNsaWNlIiwibWFwIiwibiIsImNvbmNhdCIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiZW50aXR5Iiwiam9pblR5cGUiLCJhbmNob3IiLCJsb2NhbEZpZWxkIiwicmVtb3RlRmllbGQiLCJyZW1vdGVGaWVsZHMiLCJzdWJBc3NvY2lhdGlvbnMiLCJjb25uZWN0ZWRXaXRoIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImxlbmd0aCIsInZhbHVlc1NlcSIsImpvaW5PcGVyYXRvciIsIkFycmF5IiwiaXNBcnJheSIsImMiLCJpc1BsYWluT2JqZWN0IiwibnVtT2ZFbGVtZW50IiwiT2JqZWN0IiwiX3dyYXBDb25kaXRpb24iLCJfcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyIsImZpZWxkTmFtZSIsIm1haW5FbnRpdHkiLCJwYXJ0cyIsImFjdHVhbEZpZWxkTmFtZSIsInBvcCIsIm1zZyIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzTmlsIiwiaGFzT3BlcmF0b3IiLCJrIiwidiIsImlzRmluaXRlIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiY29sdW1ucyIsImNhc3RBcnJheSIsImNvbCIsIl9idWlsZENvbHVtbiIsIm9taXQiLCJ0eXBlIiwibmFtZSIsImFyZ3MiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFDLGdDQUFELENBQTlCOztBQUNBLE1BQU1FLEtBQUssR0FBR0QsVUFBVSxDQUFDLGdCQUFELENBQXhCOztBQUNBLE1BQU1FLFNBQVMsR0FBR0gsT0FBTyxDQUFDLGlCQUFELENBQXpCOztBQUNBLE1BQU07QUFBRUksRUFBQUEsZ0JBQUY7QUFBb0JDLEVBQUFBO0FBQXBCLElBQXNDTCxPQUFPLENBQUMsY0FBRCxDQUFuRDs7QUFDQSxNQUFNO0FBQUVNLEVBQUFBLFFBQUY7QUFBWUMsRUFBQUE7QUFBWixJQUE0QlAsT0FBTyxDQUFDLHFCQUFELENBQXpDOztBQUNBLE1BQU1RLElBQUksR0FBR1IsT0FBTyxDQUFDLGtCQUFELENBQXBCOztBQU9BLE1BQU1TLGNBQU4sU0FBNkJOLFNBQTdCLENBQXVDO0FBdUJuQ08sRUFBQUEsV0FBVyxDQUFDQyxnQkFBRCxFQUFtQkMsT0FBbkIsRUFBNEI7QUFDbkMsVUFBTSxPQUFOLEVB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LEVBQU1aLEdBQU4sS0FBYyxLQUFLWCxrQkFBTCxDQUF3QlcsR0FBeEIsRUFBNkJoRSxVQUE3QixFQUF5Q0YsUUFBekMsS0FBc0Q4RSxHQUFHLEdBQUcsRUFBSCxHQUFRLE9BQWpFLENBQTdCLEVBQXdHekUsSUFBeEcsQ0FBNkcsSUFBN0csQ0FBckI7QUFDSDs7QUFFRCxVQUFNLElBQUkxRixnQkFBSixDQUFzQiw0QkFBMkJtSixJQUFJLENBQUNDLFNBQUwsQ0FBZWMsT0FBZixDQUF3QixFQUF6RSxDQUFOO0FBQ0g7O0FBRUQsUUFBTTVHLGVBQU4sQ0FBc0I5QyxPQUF0QixFQUErQjtBQUMzQixXQUFRQSxPQUFPLElBQUlBLE9BQU8sQ0FBQzRKLFVBQXBCLEdBQWtDNUosT0FBTyxDQUFDNEosVUFBMUMsR0FBdUQsS0FBS3pJLFFBQUwsQ0FBY25CLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNdUQsbUJBQU4sQ0FBMEI5QyxJQUExQixFQUFnQ1QsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDNEosVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLOUksV0FBTCxDQUFpQkwsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBanJCa0M7O0FBQWpDWixjLENBTUtxQyxlLEdBQWtCeUYsTUFBTSxDQUFDa0MsTUFBUCxDQUFjO0FBQ25DQyxFQUFBQSxjQUFjLEVBQUUsaUJBRG1CO0FBRW5DQyxFQUFBQSxhQUFhLEVBQUUsZ0JBRm9CO0FBR25DQyxFQUFBQSxlQUFlLEVBQUUsa0JBSGtCO0FBSW5DQyxFQUFBQSxZQUFZLEVBQUU7QUFKcUIsQ0FBZCxDO0FBOHFCN0JDLE1BQU0sQ0FBQ0MsT0FBUCxHQUFpQnRLLGNBQWpCIiwic291cmNlc0NvbnRlbnQiOlsiY29uc3QgeyBfLCBlYWNoQXN5bmNfLCBzZXRWYWx1ZUJ5UGF0aCB9ID0gcmVxdWlyZSgncmstdXRpbHMnKTtcbmNvbnN0IHsgdHJ5UmVxdWlyZSB9ID0gcmVxdWlyZSgnQGstc3VpdGUvYXBwL2xpYi91dGlscy9IZWxwZXJzJyk7XG5jb25zdCBteXNxbCA9IHRyeVJlcXVpcmUoJ215c3FsMi9wcm9taXNlJyk7XG5jb25zdCBDb25uZWN0b3IgPSByZXF1aXJlKCcuLi8uLi9Db25uZWN0b3InKTtcbmNvbnN0IHsgT29sb25nVXNhZ2VFcnJvciwgQnVzaW5lc3NFcnJvciB9ID0gcmVxdWlyZSgnLi4vLi4vRXJyb3JzJyk7XG5jb25zdCB7IGlzUXVvdGVkLCBpc1ByaW1pdGl2ZSB9ID0gcmVxdWlyZSgnLi4vLi4vLi4vdXRpbHMvbGFuZycpO1xuY29uc3QgbnRvbCA9IHJlcXVpcmUoJ251bWJlci10by1sZXR0ZXInKTtcblxuLyoqXG4gKiBNeVNRTCBkYXRhIHN0b3JhZ2UgY29ubmVjdG9yLlxuICogQGNsYXNzXG4gKiBAZXh0ZW5kcyBDb25uZWN0b3JcbiAqL1xuY2xhc3MgTXlTUUxDb25uZWN0b3IgZXh0ZW5kcyBDb25uZWN0b3Ige1xuICAgIC8qKlxuICAgICAqIFRyYW5zYWN0aW9uIGlzb2xhdGlvbiBsZXZlbFxuICAgICAqIHtAbGluayBodHRwczovL2Rldi5teXNxbC5jb20vZG9jL3JlZm1hbi84LjAvZW4vaW5ub2RiLXRyYW5zYWN0aW9uLWlzb2xhdGlvbi1sZXZlbHMuaHRtbH1cbiAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICovXG4gICAgc3RhdGljIElzb2xhdGlvbkxldmVscyA9IE9iamVjdC5mcmVlemUoe1xuICAgICAgICBSZXBlYXRhYmxlUmVhZDogJ1JFUEVBVEFCTEUgUkVBRCcsXG4gICAgICAgIFJlYWRDb21taXR0ZWQ6ICdSRUFEIENPTU1JVFRFRCcsXG4gICAgICAgIFJlYWRVbmNvbW1pdHRlZDogJ1JFQUQgVU5DT01NSVRURUQnLFxuICAgICAgICBSZXJpYWxpemFibGU6ICdTRVJJQUxJWkFCTEUnXG4gICAgfSk7ICAgIFxuICAgIFxuICAgIGVzY2FwZSA9IG15c3FsLmVzY2FwZTtcbiAgICBlc2NhcGVJZCA9IG15c3FsLmVzY2FwZUlkO1xuICAgIGZvcm1hdCA9IG15c3FsLmZvcm1hdDtcbiAgICByYXcgPSBteXNxbC5yYXc7XG5cbiAgICAvKiogICAgICAgICAgXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG5hbWUgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgXG4gICAgICogQHByb3BlcnR5IHtib29sZWFufSBbb3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudF0gLSBcbiAgICAgKi9cbiAgICBjb25zdHJ1Y3Rvcihjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgc3VwZXIoJ215c3FsJywgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG5cbiAgICAgICAgdGhpcy5fcG9vbHMgPSB7fTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMgPSBuZXcgTWFwKCk7XG4gICAgfVxuXG4gICAgc3RyaW5nRnJvbUNvbm5lY3Rpb24oY29ubikge1xuICAgICAgICBwb3N0OiAhY29ubiB8fCBpdCwgJ0Nvbm5lY3Rpb24gb2JqZWN0IG5vdCBmb3VuZCBpbiBhY2l0dmUgY29ubmVjdGlvbnMgbWFwLic7IFxuICAgICAgICByZXR1cm4gdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuZ2V0KGNvbm4pO1xuICAgIH0gICAgXG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhbGwgY29ubmVjdGlvbiBpbml0aWF0ZWQgYnkgdGhpcyBjb25uZWN0b3IuXG4gICAgICovXG4gICAgYXN5bmMgZW5kXygpIHtcbiAgICAgICAgZm9yIChsZXQgY29ubiBvZiB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5rZXlzKCkpIHtcbiAgICAgICAgICAgIGF3YWl0IHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIGVhY2hBc3luY18odGhpcy5fcG9vbHMsIGFzeW5jIChwb29sLCBjcykgPT4ge1xuICAgICAgICAgICAgYXdhaXQgcG9vbC5lbmQoKTtcbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDbG9zZWQgcG9vbDogJyArIGNzKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ3JlYXRlIGEgZGF0YWJhc2UgY29ubmVjdGlvbiBiYXNlZCBvbiB0aGUgZGVmYXVsdCBjb25uZWN0aW9uIHN0cmluZyBvZiB0aGUgY29ubmVjdG9yIGFuZCBnaXZlbiBvcHRpb25zLiAgICAgXG4gICAgICogQHBhcmFtIHtPYmplY3R9IFtvcHRpb25zXSAtIEV4dHJhIG9wdGlvbnMgZm9yIHRoZSBjb25uZWN0aW9uLCBvcHRpb25hbC5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLm11bHRpcGxlU3RhdGVtZW50cz1mYWxzZV0gLSBBbGxvdyBydW5uaW5nIG11bHRpcGxlIHN0YXRlbWVudHMgYXQgYSB0aW1lLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMuY3JlYXRlRGF0YWJhc2U9ZmFsc2VdIC0gRmxhZyB0byB1c2VkIHdoZW4gY3JlYXRpbmcgYSBkYXRhYmFzZS5cbiAgICAgKiBAcmV0dXJucyB7UHJvbWlzZS48TXlTUUxDb25uZWN0aW9uPn1cbiAgICAgKi9cbiAgICBhc3luYyBjb25uZWN0XyhvcHRpb25zKSB7XG4gICAgICAgIGxldCBjc0tleSA9IHRoaXMuY29ubmVjdGlvblN0cmluZztcblxuICAgICAgICBpZiAob3B0aW9ucykge1xuICAgICAgICAgICAgbGV0IGNvbm5Qcm9wcyA9IHt9O1xuXG4gICAgICAgICAgICBpZiAob3B0aW9ucy5jcmVhdGVEYXRhYmFzZSkge1xuICAgICAgICAgICAgICAgIC8vcmVtb3ZlIHRoZSBkYXRhYmFzZSBmcm9tIGNvbm5lY3Rpb25cbiAgICAgICAgICAgICAgICBjb25uUHJvcHMuZGF0YWJhc2UgPSAnJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgY29ublByb3BzLm9wdGlvbnMgPSBfLnBpY2sob3B0aW9ucywgWydtdWx0aXBsZVN0YXRlbWVudHMnXSk7ICAgICBcblxuICAgICAgICAgICAgY3NLZXkgPSB0aGlzLmdldE5ld0Nvbm5lY3Rpb25TdHJpbmcoY29ublByb3BzKTtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IHBvb2wgPSB0aGlzLl9wb29sc1tjc0tleV07XG5cbiAgICAgICAgaWYgKCFwb29sKSB7ICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBwb29sID0gbXlzcWwuY3JlYXRlUG9vbChjc0tleSk7XG4gICAgICAgICAgICB0aGlzLl9wb29sc1tjc0tleV0gPSBwb29sO1xuXG4gICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlZCBwb29sOiAnICsgY3NLZXkpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgY29ubiA9IGF3YWl0IHBvb2wuZ2V0Q29ubmVjdGlvbigpO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5zZXQoY29ubiwgY3NLZXkpO1xuXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDcmVhdGUgY29ubmVjdGlvbjogJyArIGNzS2V5KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICAgICAgXG4gICAgICAgIGxldCBjcyA9IHRoaXMuc3RyaW5nRnJvbUNvbm5lY3Rpb24oY29ubik7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTtcblxuICAgICAgICB0aGlzLmxvZygnZGVidWcnLCAnQ2xvc2UgY29ubmVjdGlvbjogJyArIChjcyB8fCAnKnVua25vd24qJykpOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBsZXQgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGNvbm4uYmVnaW5UcmFuc2FjdGlvbigpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLmNvbW1pdCgpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NvbW1pdHMgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5yb2xsYmFjaygpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ1JvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LlxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBzcWwsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmb3JtYXRlZFNRTCA9IHBhcmFtcyA/IGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSA6IHNxbDtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGZvcm1hdGVkU1FMKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsOiBmb3JtYXRlZFNRTCwgcm93c0FzQXJyYXk6IHRydWUgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShmb3JtYXRlZFNRTCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGxldCBzcWwgPSAnSU5TRVJUIElOVE8gPz8gU0VUID8nO1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7IFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyB1cGRhdGVfKG1vZGVsLCBkYXRhLCBjb25kaXRpb24sIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCwgZGF0YSBdOyBcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnVVBEQVRFID8/IFNFVCA/IFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIGNvbmRpdGlvbiwgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMpOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdERUxFVEUgRlJPTSA/PyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGZpbmRfKG1vZGVsLCB7ICRhc3NvY2lhdGlvbiwgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQgfSwgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZTtcblxuICAgICAgICBpZiAoJGFzc29jaWF0aW9uKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJGFzc29jaWF0aW9uLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgcGFyYW1zKTtcbiAgICAgICAgICAgIGhhc0pvaW5pbmcgPSBtb2RlbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9ICRxdWVyeSAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKCRxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIFxuICAgICAgICBsZXQgc3FsID0gJ1NFTEVDVCAnICsgKCRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKicpICsgJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgfSBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIE9GRlNFVCA/JztcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIG9wdGlvbnMgPSB7IC4uLm9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICBsZXQgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7ICBcbiAgICAgICAgICAgIGxldCByZXZlcnNlQWxpYXNNYXAgPSBfLnJlZHVjZShhbGlhc01hcCwgKHJlc3VsdCwgYWxpYXMsIG5vZGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2FsaWFzXSA9IG5vZGVQYXRoLnNwbGl0KCcuJykuc2xpY2UoMSkubWFwKG4gPT4gJzonICsgbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTsgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeHRyYWN0IGFzc29jaWF0aW9ucyBpbnRvIGpvaW5pbmcgY2xhdXNlcy5cbiAgICAgKiAge1xuICAgICAqICAgICAgZW50aXR5OiA8cmVtb3RlIGVudGl0eT5cbiAgICAgKiAgICAgIGpvaW5UeXBlOiAnTEVGVCBKT0lOfElOTkVSIEpPSU58RlVMTCBPVVRFUiBKT0lOJ1xuICAgICAqICAgICAgYW5jaG9yOiAnbG9jYWwgcHJvcGVydHkgdG8gcGxhY2UgdGhlIHJlbW90ZSBlbnRpdHknXG4gICAgICogICAgICBsb2NhbEZpZWxkOiA8bG9jYWwgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHJlbW90ZUZpZWxkOiA8cmVtb3RlIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICBzdWJBc3NvY2lhdGlvbnM6IHsgLi4uIH1cbiAgICAgKiAgfVxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7Kn0gYXNzb2NpYXRpb25zIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXNLZXkgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhcyBcbiAgICAgKiBAcGFyYW0geyp9IGFsaWFzTWFwIFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQXNzb2NpYXRpb25zKGFzc29jaWF0aW9ucywgcGFyZW50QWxpYXNLZXksIHBhcmVudEFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKSB7XG4gICAgICAgIGxldCBqb2luaW5ncyA9IFtdO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsICh7IGVudGl0eSwgam9pblR5cGUsIGFuY2hvciwgbG9jYWxGaWVsZCwgcmVtb3RlRmllbGQsIHJlbW90ZUZpZWxkcywgc3ViQXNzb2NpYXRpb25zLCBjb25uZWN0ZWRXaXRoIH0pID0+IHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBudG9sKHN0YXJ0SWQrKyk7IFxuICAgICAgICAgICAgbGV0IGFsaWFzS2V5ID0gcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbmNob3I7XG4gICAgICAgICAgICBhbGlhc01hcFthbGlhc0tleV0gPSBhbGlhczsgXG5cbiAgICAgICAgICAgIGlmIChjb25uZWN0ZWRXaXRoKSB7XG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiBgICsgXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuX2pvaW5Db25kaXRpb24oWyBcbiAgICAgICAgICAgICAgICAgICAgICAgIGAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWAsXG4gICAgICAgICAgICAgICAgICAgICAgICBjb25uZWN0ZWRXaXRoXG4gICAgICAgICAgICAgICAgICAgIF0sIHBhcmFtcywgJ0FORCcsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcClcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChyZW1vdGVGaWVsZHMpIHtcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OIGAgKyBcbiAgICAgICAgICAgICAgICAgICAgcmVtb3RlRmllbGRzLm1hcChyZW1vdGVGaWVsZCA9PiBgJHthbGlhc30uJHtteXNxbC5lc2NhcGVJZChyZW1vdGVGaWVsZCl9ID0gJHtwYXJlbnRBbGlhc30uJHtteXNxbC5lc2NhcGVJZChsb2NhbEZpZWxkKX1gKS5qb2luKCcgT1IgJylcbiAgICAgICAgICAgICAgICApO1xuICAgICAgICAgICAgfSBlbHNlIHsgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke2FsaWFzfS4ke215c3FsLmVzY2FwZUlkKHJlbW90ZUZpZWxkKX0gPSAke3BhcmVudEFsaWFzfS4ke215c3FsLmVzY2FwZUlkKGxvY2FsRmllbGQpfWApO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NpYXRpb25zKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NpYXRpb25zLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCB2YWx1ZXNTZXEsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHZhbHVlc1NlcSwgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHZhbHVlc1NlcSwgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYSBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgdmFsdWVzU2VxLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgdmFsdWVzU2VxLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgdmFsdWVzU2VxLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29uZGl0aW9uID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW21haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gO1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIG1zZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKG1zZyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gJ0EuJyArIG15c3FsLmVzY2FwZUlkKGZpZWxkTmFtZSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgcmV0dXJuIChtYWluRW50aXR5ID8gXG4gICAgICAgICAgICB0aGlzLl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIDogXG4gICAgICAgICAgICBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gdmFsdWVzU2VxICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChfLmlzTmlsKHZhbHVlKSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOVUxMJztcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBsZXQgaGFzT3BlcmF0b3IgPSBfLmZpbmQoT2JqZWN0LmtleXModmFsdWUpLCBrID0+IGsgJiYga1swXSA9PT0gJyQnKTtcblxuICAgICAgICAgICAgaWYgKGhhc09wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIF8ubWFwKHZhbHVlLCAodiwgaykgPT4ge1xuICAgICAgICAgICAgICAgICAgICBpZiAoayAmJiBrWzBdID09PSAnJCcpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9wZXJhdG9yXG4gICAgICAgICAgICAgICAgICAgICAgICBzd2l0Y2ggKGspIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlcXVhbCc6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB2LCB2YWx1ZXNTZXEsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuZXEnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RFcXVhbCc6ICAgICAgICAgXG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNOaWwodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfSAgICAgICAgICBcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNQcmltaXRpdmUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3QnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRncmVhdGVyVGhhbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD49JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3RlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZ3JlYXRlclRoYW5PckVxdWFsJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIV8uaXNGaW5pdGUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdPbmx5IGZpbml0ZSBudW1iZXJzIGNhbiB1c2UgXCIkZ3RlXCIgb3IgXCIkPj1cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0JzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGVzc1RoYW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ8XCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPCA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckPD0nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdGUnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsZXNzVGhhbk9yRXF1YWwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdGVcIiBvciBcIiQ8PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw9ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRpbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSB3aGVuIHVzaW5nIFwiJGluXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSU4gKD8pJztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmluJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90SW4nOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRlbmRXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGEgc3RyaW5nIHdoZW4gdXNpbmcgXCIkZW5kV2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAlJHt2fWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICBcblxuICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goSlNPTi5zdHJpbmdpZnkodmFsdWUpKTtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICAgICAgfVxuXG4gICAgICAgIHZhbHVlc1NlcS5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbnMoY29sdW1ucywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ3N0cmluZycpIHsgIFxuICAgICAgICAgICAgLy9pdCdzIGEgc3RyaW5nIGlmIGl0J3MgcXVvdGVkIHdoZW4gcGFzc2VkIGluICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIChpc1F1b3RlZChjb2wpIHx8IGNvbCA9PT0gJyonKSA/IGNvbCA6IG15c3FsLmVzY2FwZUlkKGNvbCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHtcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMgJiYgdHlwZW9mIGNvbC5hbGlhcyA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fYnVpbGRDb2x1bW4oXy5vbWl0KGNvbCwgWydhbGlhcyddKSkgKyAnIEFTICcgKyBteXNxbC5lc2NhcGVJZChjb2wuYWxpYXMpO1xuICAgICAgICAgICAgfSBcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3cgY29sdW1uIHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShjb2wpfWApO1xuICAgIH1cblxuICAgIF9idWlsZEdyb3VwQnkoZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIGdyb3VwQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ0dST1VQIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhncm91cEJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoZ3JvdXBCeSkpIHJldHVybiAnR1JPVVAgQlkgJyArIGdyb3VwQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChncm91cEJ5KSkge1xuICAgICAgICAgICAgbGV0IHsgY29sdW1ucywgaGF2aW5nIH0gPSBncm91cEJ5O1xuXG4gICAgICAgICAgICBpZiAoIWNvbHVtbnMgfHwgIUFycmF5LmlzQXJyYXkoY29sdW1ucykpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICBsZXQgZ3JvdXBCeUNsYXVzZSA9IHRoaXMuX2J1aWxkR3JvdXBCeShjb2x1bW5zKTtcbiAgICAgICAgICAgIGxldCBoYXZpbmdDbHVzZSA9IGhhdmluZyAmJiB0aGlzLl9qb2luQ29uZGl0aW9uKGhhdmluZywgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICBpZiAoaGF2aW5nQ2x1c2UpIHtcbiAgICAgICAgICAgICAgICBncm91cEJ5Q2xhdXNlICs9ICcgSEFWSU5HICcgKyBoYXZpbmdDbHVzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmV0dXJuIGdyb3VwQnlDbGF1c2U7XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBncm91cCBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoZ3JvdXBCeSl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkT3JkZXJCeShvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICBpZiAodHlwZW9mIG9yZGVyQnkgPT09ICdzdHJpbmcnKSByZXR1cm4gJ09SREVSIEJZICcgKyB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhvcmRlckJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkob3JkZXJCeSkpIHJldHVybiAnT1JERVIgQlkgJyArIG9yZGVyQnkubWFwKGJ5ID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGJ5LCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywgJyk7XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChvcmRlckJ5KSkge1xuICAgICAgICAgICAgcmV0dXJuICdPUkRFUiBCWSAnICsgXy5tYXAob3JkZXJCeSwgKGFzYywgY29sKSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIChhc2MgPyAnJyA6ICcgREVTQycpKS5qb2luKCcsICcpOyBcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIG9yZGVyIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShvcmRlckJ5KX1gKTtcbiAgICB9XG5cbiAgICBhc3luYyBfZ2V0Q29ubmVjdGlvbl8ob3B0aW9ucykge1xuICAgICAgICByZXR1cm4gKG9wdGlvbnMgJiYgb3B0aW9ucy5jb25uZWN0aW9uKSA/IG9wdGlvbnMuY29ubmVjdGlvbiA6IHRoaXMuY29ubmVjdF8ob3B0aW9ucyk7XG4gICAgfVxuXG4gICAgYXN5bmMgX3JlbGVhc2VDb25uZWN0aW9uXyhjb25uLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghb3B0aW9ucyB8fCAhb3B0aW9ucy5jb25uZWN0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxubW9kdWxlLmV4cG9ydHMgPSBNeVNRTENvbm5lY3RvcjsiXX0=