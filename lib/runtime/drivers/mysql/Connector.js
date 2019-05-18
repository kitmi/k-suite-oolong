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
    this.insertOne_ = this.create_;
    this.updateOne_ = this.update_;
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsIl9wb29scyIsIl9hY2l0dmVDb25uZWN0aW9ucyIsIk1hcCIsInN0cmluZ0Zyb21Db25uZWN0aW9uIiwiY29ubiIsIml0IiwiZ2V0IiwiZW5kXyIsImtleXMiLCJkaXNjb25uZWN0XyIsInBvb2wiLCJjcyIsImVuZCIsImxvZyIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsImdldE5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsInNldCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsInZhbHVlIiwia2V5IiwicXVlcnkiLCJiZWdpblRyYW5zYWN0aW9uIiwiY29tbWl0XyIsImNvbW1pdCIsInJvbGxiYWNrXyIsInJvbGxiYWNrIiwiZXhlY3V0ZV8iLCJzcWwiLCJwYXJhbXMiLCJfZ2V0Q29ubmVjdGlvbl8iLCJ1c2VQcmVwYXJlZFN0YXRlbWVudCIsImxvZ1NRTFN0YXRlbWVudCIsInJvd3NBc0FycmF5IiwiZXhlY3V0ZSIsInJvd3MxIiwiZm9ybWF0ZWRTUUwiLCJyb3dzMiIsImVyciIsIl9yZWxlYXNlQ29ubmVjdGlvbl8iLCJwaW5nXyIsInBpbmciLCJyZXN1bHQiLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInF1ZXJ5T3B0aW9ucyIsImNvbm5PcHRpb25zIiwiYWxpYXNNYXAiLCJqb2luaW5ncyIsImhhc0pvaW5pbmciLCJqb2luaW5nUGFyYW1zIiwiJHJlbGF0aW9uc2hpcHMiLCJfam9pbkFzc29jaWF0aW9ucyIsImZvckVhY2giLCJwIiwiam9pbiIsIndoZXJlQ2xhdXNlIiwiX2pvaW5Db25kaXRpb24iLCJyZXBsYWNlXyIsImRlbGV0ZV8iLCJjb25kaXRpb24iLCJmaW5kXyIsInNxbEluZm8iLCJidWlsZFF1ZXJ5IiwidG90YWxDb3VudCIsImNvdW50U3FsIiwiY291bnRSZXN1bHQiLCJyZXZlcnNlQWxpYXNNYXAiLCJyZWR1Y2UiLCJhbGlhcyIsIm5vZGVQYXRoIiwic3BsaXQiLCJzbGljZSIsIm1hcCIsIm4iLCJjb25jYXQiLCIkcHJvamVjdGlvbiIsIiRxdWVyeSIsIiRncm91cEJ5IiwiJG9yZGVyQnkiLCIkb2Zmc2V0IiwiJGxpbWl0IiwiJHRvdGFsQ291bnQiLCJzZWxlY3RDb2xvbW5zIiwiX2J1aWxkQ29sdW1ucyIsIl9idWlsZEdyb3VwQnkiLCJfYnVpbGRPcmRlckJ5IiwiY291bnRTdWJqZWN0IiwiX2VzY2FwZUlkV2l0aEFsaWFzIiwiaXNJbnRlZ2VyIiwiZ2V0SW5zZXJ0ZWRJZCIsImluc2VydElkIiwidW5kZWZpbmVkIiwiZ2V0TnVtT2ZBZmZlY3RlZFJvd3MiLCJhZmZlY3RlZFJvd3MiLCJfZ2VuZXJhdGVBbGlhcyIsImluZGV4IiwiYW5jaG9yIiwidmVyYm9zZUFsaWFzIiwic25ha2VDYXNlIiwidG9VcHBlckNhc2UiLCJhc3NvY2lhdGlvbnMiLCJwYXJlbnRBbGlhc0tleSIsInBhcmVudEFsaWFzIiwic3RhcnRJZCIsImVhY2giLCJhc3NvY0luZm8iLCJqb2luVHlwZSIsIm9uIiwib3V0cHV0IiwiZW50aXR5Iiwic3ViQXNzb2NzIiwiYWxpYXNLZXkiLCJzdWJKb2luaW5ncyIsImxlbmd0aCIsImpvaW5PcGVyYXRvciIsIkFycmF5IiwiaXNBcnJheSIsImMiLCJpc1BsYWluT2JqZWN0Iiwic3RhcnRzV2l0aCIsIm51bU9mRWxlbWVudCIsIk9iamVjdCIsIl93cmFwQ29uZGl0aW9uIiwiRXJyb3IiLCJKU09OIiwic3RyaW5naWZ5IiwiX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMiLCJmaWVsZE5hbWUiLCJtYWluRW50aXR5IiwicGFydHMiLCJhY3R1YWxGaWVsZE5hbWUiLCJwb3AiLCJtc2ciLCJ2YWx1ZXNTZXEiLCJpbmplY3QiLCJpc05pbCIsIm9vclR5cGUiLCJuYW1lIiwiaGFzT3BlcmF0b3IiLCJrIiwidiIsImlzRmluaXRlIiwidG9GaW5pdGUiLCJpc05hTiIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJvbWl0IiwidHlwZSIsImFyZ3MiLCJleHByIiwiZ3JvdXBCeSIsImJ5IiwiaGF2aW5nIiwiZ3JvdXBCeUNsYXVzZSIsImhhdmluZ0NsdXNlIiwib3JkZXJCeSIsImFzYyIsImNvbm5lY3Rpb24iLCJmcmVlemUiLCJSZXBlYXRhYmxlUmVhZCIsIlJlYWRDb21taXR0ZWQiLCJSZWFkVW5jb21taXR0ZWQiLCJSZXJpYWxpemFibGUiLCJtb2R1bGUiLCJleHBvcnRzIl0sIm1hcHBpbmdzIjoiOzs7O0FBQUEsTUFBTTtBQUFFQSxFQUFBQSxDQUFGO0FBQUtDLEVBQUFBLFVBQUw7QUFBaUJDLEVBQUFBO0FBQWpCLElBQW9DQyxPQUFPLENBQUMsVUFBRCxDQUFqRDs7QUFDQSxNQUFNO0FBQUVDLEVBQUFBO0FBQUYsSUFBaUJELE9BQU8sQ0FBQyxnQ0FBRCxDQUE5Qjs7QUFDQSxNQUFNRSxLQUFLLEdBQUdELFVBQVUsQ0FBQyxnQkFBRCxDQUF4Qjs7QUFDQSxNQUFNRSxTQUFTLEdBQUdILE9BQU8sQ0FBQyxpQkFBRCxDQUF6Qjs7QUFDQSxNQUFN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LCJzb3VyY2VzQ29udGVudCI6WyJjb25zdCB7IF8sIGVhY2hBc3luY18sIHNldFZhbHVlQnlQYXRoIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyB0cnlSZXF1aXJlIH0gPSByZXF1aXJlKCdAay1zdWl0ZS9hcHAvbGliL3V0aWxzL0hlbHBlcnMnKTtcbmNvbnN0IG15c3FsID0gdHJ5UmVxdWlyZSgnbXlzcWwyL3Byb21pc2UnKTtcbmNvbnN0IENvbm5lY3RvciA9IHJlcXVpcmUoJy4uLy4uL0Nvbm5lY3RvcicpO1xuY29uc3QgeyBPb2xvbmdVc2FnZUVycm9yLCBCdXNpbmVzc0Vycm9yIH0gPSByZXF1aXJlKCcuLi8uLi9FcnJvcnMnKTtcbmNvbnN0IHsgaXNRdW90ZWQsIGlzUHJpbWl0aXZlIH0gPSByZXF1aXJlKCcuLi8uLi8uLi91dGlscy9sYW5nJyk7XG5jb25zdCBudG9sID0gcmVxdWlyZSgnbnVtYmVyLXRvLWxldHRlcicpO1xuXG4vKipcbiAqIE15U1FMIGRhdGEgc3RvcmFnZSBjb25uZWN0b3IuXG4gKiBAY2xhc3NcbiAqIEBleHRlbmRzIENvbm5lY3RvclxuICovXG5jbGFzcyBNeVNRTENvbm5lY3RvciBleHRlbmRzIENvbm5lY3RvciB7XG4gICAgLyoqXG4gICAgICogVHJhbnNhY3Rpb24gaXNvbGF0aW9uIGxldmVsXG4gICAgICoge0BsaW5rIGh0dHBzOi8vZGV2Lm15c3FsLmNvbS9kb2MvcmVmbWFuLzguMC9lbi9pbm5vZGItdHJhbnNhY3Rpb24taXNvbGF0aW9uLWxldmVscy5odG1sfVxuICAgICAqIEBtZW1iZXIge29iamVjdH1cbiAgICAgKi9cbiAgICBzdGF0aWMgSXNvbGF0aW9uTGV2ZWxzID0gT2JqZWN0LmZyZWV6ZSh7XG4gICAgICAgIFJlcGVhdGFibGVSZWFkOiAnUkVQRUFUQUJMRSBSRUFEJyxcbiAgICAgICAgUmVhZENvbW1pdHRlZDogJ1JFQUQgQ09NTUlUVEVEJyxcbiAgICAgICAgUmVhZFVuY29tbWl0dGVkOiAnUkVBRCBVTkNPTU1JVFRFRCcsXG4gICAgICAgIFJlcmlhbGl6YWJsZTogJ1NFUklBTElaQUJMRSdcbiAgICB9KTsgICAgXG4gICAgXG4gICAgZXNjYXBlID0gbXlzcWwuZXNjYXBlO1xuICAgIGVzY2FwZUlkID0gbXlzcWwuZXNjYXBlSWQ7XG4gICAgZm9ybWF0ID0gbXlzcWwuZm9ybWF0O1xuICAgIHJhdyA9IG15c3FsLnJhdztcblxuICAgIC8qKiAgICAgICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbmFtZSBcbiAgICAgKiBAcGFyYW0ge29iamVjdH0gb3B0aW9ucyBcbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFxuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBzdXBlcignbXlzcWwnLCBjb25uZWN0aW9uU3RyaW5nLCBvcHRpb25zKTtcblxuICAgICAgICB0aGlzLl9wb29scyA9IHt9O1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucyA9IG5ldyBNYXAoKTtcbiAgICB9XG5cbiAgICBzdHJpbmdGcm9tQ29ubmVjdGlvbihjb25uKSB7XG4gICAgICAgIHBvc3Q6ICFjb25uIHx8IGl0LCAnQ29ubmVjdGlvbiBvYmplY3Qgbm90IGZvdW5kIGluIGFjaXR2ZSBjb25uZWN0aW9ucyBtYXAuJzsgXG4gICAgICAgIHJldHVybiB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5nZXQoY29ubik7XG4gICAgfSAgICBcblxuICAgIC8qKlxuICAgICAqIENsb3NlIGFsbCBjb25uZWN0aW9uIGluaXRpYXRlZCBieSB0aGlzIGNvbm5lY3Rvci5cbiAgICAgKi9cbiAgICBhc3luYyBlbmRfKCkge1xuICAgICAgICBmb3IgKGxldCBjb25uIG9mIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmtleXMoKSkge1xuICAgICAgICAgICAgYXdhaXQgdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gZWFjaEFzeW5jXyh0aGlzLl9wb29scywgYXN5bmMgKHBvb2wsIGNzKSA9PiB7XG4gICAgICAgICAgICBhd2FpdCBwb29sLmVuZCgpO1xuICAgICAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0Nsb3NlZCBwb29sOiAnICsgY3MpO1xuICAgICAgICB9KTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDcmVhdGUgYSBkYXRhYmFzZSBjb25uZWN0aW9uIGJhc2VkIG9uIHRoZSBkZWZhdWx0IGNvbm5lY3Rpb24gc3RyaW5nIG9mIHRoZSBjb25uZWN0b3IgYW5kIGdpdmVuIG9wdGlvbnMuICAgICBcbiAgICAgKiBAcGFyYW0ge09iamVjdH0gW29wdGlvbnNdIC0gRXh0cmEgb3B0aW9ucyBmb3IgdGhlIGNvbm5lY3Rpb24sIG9wdGlvbmFsLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbH0gW29wdGlvbnMubXVsdGlwbGVTdGF0ZW1lbnRzPWZhbHNlXSAtIEFsbG93IHJ1bm5pbmcgbXVsdGlwbGUgc3RhdGVtZW50cyBhdCBhIHRpbWUuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5jcmVhdGVEYXRhYmFzZT1mYWxzZV0gLSBGbGFnIHRvIHVzZWQgd2hlbiBjcmVhdGluZyBhIGRhdGFiYXNlLlxuICAgICAqIEByZXR1cm5zIHtQcm9taXNlLjxNeVNRTENvbm5lY3Rpb24+fVxuICAgICAqL1xuICAgIGFzeW5jIGNvbm5lY3RfKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNzS2V5ID0gdGhpcy5jb25uZWN0aW9uU3RyaW5nO1xuXG4gICAgICAgIGlmIChvcHRpb25zKSB7XG4gICAgICAgICAgICBsZXQgY29ublByb3BzID0ge307XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zLmNyZWF0ZURhdGFiYXNlKSB7XG4gICAgICAgICAgICAgICAgLy9yZW1vdmUgdGhlIGRhdGFiYXNlIGZyb20gY29ubmVjdGlvblxuICAgICAgICAgICAgICAgIGNvbm5Qcm9wcy5kYXRhYmFzZSA9ICcnO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICBjb25uUHJvcHMub3B0aW9ucyA9IF8ucGljayhvcHRpb25zLCBbJ211bHRpcGxlU3RhdGVtZW50cyddKTsgICAgIFxuXG4gICAgICAgICAgICBjc0tleSA9IHRoaXMuZ2V0TmV3Q29ubmVjdGlvblN0cmluZyhjb25uUHJvcHMpO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBsZXQgcG9vbCA9IHRoaXMuX3Bvb2xzW2NzS2V5XTtcblxuICAgICAgICBpZiAoIXBvb2wpIHsgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHBvb2wgPSBteXNxbC5jcmVhdGVQb29sKGNzS2V5KTtcbiAgICAgICAgICAgIHRoaXMuX3Bvb2xzW2NzS2V5XSA9IHBvb2w7XG5cbiAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdDcmVhdGVkIHBvb2w6ICcgKyBjc0tleSk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBjb25uID0gYXdhaXQgcG9vbC5nZXRDb25uZWN0aW9uKCk7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLnNldChjb25uLCBjc0tleSk7XG5cbiAgICAgICAgLy90aGlzLmxvZygnZGVidWcnLCAnQ3JlYXRlIGNvbm5lY3Rpb246ICcgKyBjc0tleSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDbG9zZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKGNvbm4pIHsgICAgICAgIFxuICAgICAgICBsZXQgY3MgPSB0aGlzLnN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pO1xuICAgICAgICB0aGlzLl9hY2l0dmVDb25uZWN0aW9ucy5kZWxldGUoY29ubik7XG5cbiAgICAgICAgLy90aGlzLmxvZygnZGVidWcnLCAnQ2xvc2UgY29ubmVjdGlvbjogJyArIChjcyB8fCAnKnVua25vd24qJykpOyAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBsZXQgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGNvbm4uYmVnaW5UcmFuc2FjdGlvbigpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0JlZ2lucyBhIG5ldyB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIGNvbm47XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQ29tbWl0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGNvbW1pdF8oY29ubikge1xuICAgICAgICBhd2FpdCBjb25uLmNvbW1pdCgpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ0NvbW1pdHMgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUm9sbGJhY2sgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgcm9sbGJhY2tfKGNvbm4pIHtcbiAgICAgICAgYXdhaXQgY29ubi5yb2xsYmFjaygpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ2RlYnVnJywgJ1JvbGxiYWNrcyBhIHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gdGhpcy5kaXNjb25uZWN0Xyhjb25uKTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBFeGVjdXRlIHRoZSBzcWwgc3RhdGVtZW50LlxuICAgICAqXG4gICAgICogQHBhcmFtIHtTdHJpbmd9IHNxbCAtIFRoZSBTUUwgc3RhdGVtZW50IHRvIGV4ZWN1dGUuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IHBhcmFtcyAtIFBhcmFtZXRlcnMgdG8gYmUgcGxhY2VkIGludG8gdGhlIFNRTCBzdGF0ZW1lbnQuXG4gICAgICogQHBhcmFtIHtvYmplY3R9IFtvcHRpb25zXSAtIEV4ZWN1dGlvbiBvcHRpb25zLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gV2hldGhlciB0byB1c2UgcHJlcGFyZWQgc3RhdGVtZW50IHdoaWNoIGlzIGNhY2hlZCBhbmQgcmUtdXNlZCBieSBjb25uZWN0aW9uLlxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMucm93c0FzQXJyYXldIC0gVG8gcmVjZWl2ZSByb3dzIGFzIGFycmF5IG9mIGNvbHVtbnMgaW5zdGVhZCBvZiBoYXNoIHdpdGggY29sdW1uIG5hbWUgYXMga2V5LlxuICAgICAqIEBwcm9wZXJ0eSB7TXlTUUxDb25uZWN0aW9ufSBbb3B0aW9ucy5jb25uZWN0aW9uXSAtIEV4aXN0aW5nIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgY29ubjtcblxuICAgICAgICB0cnkge1xuICAgICAgICAgICAgY29ubiA9IGF3YWl0IHRoaXMuX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpO1xuXG4gICAgICAgICAgICBpZiAodGhpcy5vcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50IHx8IChvcHRpb25zICYmIG9wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnQpKSB7XG4gICAgICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCBzcWwsIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5leGVjdXRlKHsgc3FsLCByb3dzQXNBcnJheTogdHJ1ZSB9LCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGxldCBbIHJvd3MxIF0gPSBhd2FpdCBjb25uLmV4ZWN1dGUoc3FsLCBwYXJhbXMpOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICByZXR1cm4gcm93czE7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCBmb3JtYXRlZFNRTCA9IHBhcmFtcyA/IGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSA6IHNxbDtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGZvcm1hdGVkU1FMKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5yb3dzQXNBcnJheSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLnF1ZXJ5KHsgc3FsOiBmb3JtYXRlZFNRTCwgcm93c0FzQXJyYXk6IHRydWUgfSk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBsZXQgWyByb3dzMiBdID0gYXdhaXQgY29ubi5xdWVyeShmb3JtYXRlZFNRTCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdJTlNFUlQgSU5UTyA/PyBTRVQgPyc7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgICAgIFxuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyBcblxuICAgICAgICBpZiAocXVlcnlPcHRpb25zICYmIHF1ZXJ5T3B0aW9ucy4kcmVsYXRpb25zaGlwcykgeyAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGpvaW5pbmdzID0gdGhpcy5fam9pbkFzc29jaWF0aW9ucyhxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc3FsID0gJ1VQREFURSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIGlmIChoYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBqb2luaW5nUGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7XG4gICAgICAgICAgICBzcWwgKz0gJyBBICcgKyBqb2luaW5ncy5qb2luKCcgJyk7XG4gICAgICAgIH1cblxuICAgICAgICBwYXJhbXMucHVzaChkYXRhKTtcbiAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuXG4gICAgICAgIGlmIChxdWVyeSkge1xuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbihxdWVyeSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7ICAgXG4gICAgICAgICAgICBpZiAod2hlcmVDbGF1c2UpIHtcbiAgICAgICAgICAgICAgICBzcWwgKz0gJyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIGNvbm5PcHRpb25zKTtcbiAgICB9XG5cbiAgICB1cGRhdGVPbmVfID0gdGhpcy51cGRhdGVfO1xuXG4gICAgLyoqXG4gICAgICogUmVwbGFjZSBhbiBleGlzdGluZyBlbnRpdHkgb3IgY3JlYXRlIGEgbmV3IG9uZS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGRhdGEgXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIHJlcGxhY2VfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwsIGRhdGEgXTsgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdSRVBMQUNFID8/IFNFVCA/JztcblxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUmVtb3ZlIGFuIGV4aXN0aW5nIGVudGl0eS5cbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBvcHRpb25zIFxuICAgICAqL1xuICAgIGFzeW5jIGRlbGV0ZV8obW9kZWwsIGNvbmRpdGlvbiwgb3B0aW9ucykge1xuICAgICAgICBsZXQgcGFyYW1zID0gWyBtb2RlbCBdO1xuXG4gICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMpOyAgICAgICAgXG5cbiAgICAgICAgbGV0IHNxbCA9ICdERUxFVEUgRlJPTSA/PyBXSEVSRSAnICsgd2hlcmVDbGF1c2U7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gdGhpcy5leGVjdXRlXyhzcWwsIHBhcmFtcywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogUGVyZm9ybSBzZWxlY3Qgb3BlcmF0aW9uLlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHsqfSBjb25uT3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBmaW5kXyhtb2RlbCwgY29uZGl0aW9uLCBjb25uT3B0aW9ucykge1xuICAgICAgICBsZXQgc3FsSW5mbyA9IHRoaXMuYnVpbGRRdWVyeShtb2RlbCwgY29uZGl0aW9uKTtcblxuICAgICAgICBsZXQgcmVzdWx0LCB0b3RhbENvdW50O1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgWyBjb3VudFJlc3VsdCBdID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLmNvdW50U3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgICAgICAgICAgICAgXG4gICAgICAgICAgICB0b3RhbENvdW50ID0gY291bnRSZXN1bHRbJ2NvdW50J107XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoc3FsSW5mby5oYXNKb2luaW5nKSB7XG4gICAgICAgICAgICBjb25uT3B0aW9ucyA9IHsgLi4uY29ubk9wdGlvbnMsIHJvd3NBc0FycmF5OiB0cnVlIH07XG4gICAgICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpOyAgXG4gICAgICAgICAgICBsZXQgcmV2ZXJzZUFsaWFzTWFwID0gXy5yZWR1Y2Uoc3FsSW5mby5hbGlhc01hcCwgKHJlc3VsdCwgYWxpYXMsIG5vZGVQYXRoKSA9PiB7XG4gICAgICAgICAgICAgICAgcmVzdWx0W2FsaWFzXSA9IG5vZGVQYXRoLnNwbGl0KCcuJykuc2xpY2UoMSkubWFwKG4gPT4gJzonICsgbik7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICAgICAgICAgIH0sIHt9KTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXAsIHRvdGFsQ291bnQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gcmVzdWx0LmNvbmNhdChyZXZlcnNlQWxpYXNNYXApO1xuICAgICAgICB9IFxuXG4gICAgICAgIHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5zcWwsIHNxbEluZm8ucGFyYW1zLCBjb25uT3B0aW9ucyk7XG5cbiAgICAgICAgaWYgKHNxbEluZm8uY291bnRTcWwpIHtcbiAgICAgICAgICAgIHJldHVybiBbIHJlc3VsdCwgdG90YWxDb3VudCBdO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBCdWlsZCBzcWwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7Kn0gbW9kZWwgXG4gICAgICogQHBhcmFtIHsqfSBjb25kaXRpb24gICAgICBcbiAgICAgKi9cbiAgICBidWlsZFF1ZXJ5KG1vZGVsLCB7ICRyZWxhdGlvbnNoaXBzLCAkcHJvamVjdGlvbiwgJHF1ZXJ5LCAkZ3JvdXBCeSwgJG9yZGVyQnksICRvZmZzZXQsICRsaW1pdCwgJHRvdGFsQ291bnQgfSkge1xuICAgICAgICBsZXQgcGFyYW1zID0gW10sIGFsaWFzTWFwID0geyBbbW9kZWxdOiAnQScgfSwgam9pbmluZ3MsIGhhc0pvaW5pbmcgPSBmYWxzZSwgam9pbmluZ1BhcmFtcyA9IFtdOyAgICAgICAgXG5cbiAgICAgICAgLy8gYnVpbGQgYWxpYXMgbWFwIGZpcnN0XG4gICAgICAgIC8vIGNhY2hlIHBhcmFtc1xuICAgICAgICBpZiAoJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoJHJlbGF0aW9uc2hpcHMsIG1vZGVsLCAnQScsIGFsaWFzTWFwLCAxLCBqb2luaW5nUGFyYW1zKTsgICAgICAgICAgICAgXG4gICAgICAgICAgICBoYXNKb2luaW5nID0gbW9kZWw7XG4gICAgICAgIH1cblxuICAgICAgICBsZXQgc2VsZWN0Q29sb21ucyA9ICRwcm9qZWN0aW9uID8gdGhpcy5fYnVpbGRDb2x1bW5zKCRwcm9qZWN0aW9uLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcqJztcblxuICAgICAgICBsZXQgc3FsID0gJyBGUk9NICcgKyBteXNxbC5lc2NhcGVJZChtb2RlbCk7XG5cbiAgICAgICAgLy8gbW92ZSBjYWNoZWQgam9pbmluZyBwYXJhbXMgaW50byBwYXJhbXNcbiAgICAgICAgLy8gc2hvdWxkIGFjY29yZGluZyB0byB0aGUgcGxhY2Ugb2YgY2xhdXNlIGluIGEgc3FsICAgICAgICBcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKCRxdWVyeSkge1xuICAgICAgICAgICAgbGV0IHdoZXJlQ2xhdXNlID0gdGhpcy5fam9pbkNvbmRpdGlvbigkcXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgIH0gICAgXG5cbiAgICAgICAgaWYgKCRncm91cEJ5KSB7XG4gICAgICAgICAgICBzcWwgKz0gJyAnICsgdGhpcy5fYnVpbGRHcm91cEJ5KCRncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkb3JkZXJCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkT3JkZXJCeSgkb3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHJlc3VsdCA9IHsgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCB9OyAgICAgICAgXG5cbiAgICAgICAgaWYgKCR0b3RhbENvdW50KSB7XG4gICAgICAgICAgICBsZXQgY291bnRTdWJqZWN0O1xuXG4gICAgICAgICAgICBpZiAodHlwZW9mICR0b3RhbENvdW50ID09PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICdESVNUSU5DVCgnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoJHRvdGFsQ291bnQsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgY291bnRTdWJqZWN0ID0gJyonO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXN1bHQuY291bnRTcWwgPSBgU0VMRUNUIENPVU5UKCR7Y291bnRTdWJqZWN0fSkgQVMgY291bnRgICsgc3FsO1xuICAgICAgICB9XG5cbiAgICAgICAgc3FsID0gJ1NFTEVDVCAnICsgc2VsZWN0Q29sb21ucyArIHNxbDsgICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzSW50ZWdlcigkbGltaXQpICYmICRsaW1pdCA+IDApIHtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKF8uaXNJbnRlZ2VyKCRvZmZzZXQpICYmICRvZmZzZXQgPiAwKSB7ICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPyc7XG4gICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goJGxpbWl0KTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcbiAgICAgICAgfSBlbHNlIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgc3FsICs9ICcgTElNSVQgPywgMTAwMCc7XG4gICAgICAgICAgICBwYXJhbXMucHVzaCgkb2Zmc2V0KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJlc3VsdC5zcWwgPSBzcWw7XG5cbiAgICAgICAgLy9jb25zb2xlLmRpcihyZXN1bHQsIHsgZGVwdGg6IDEwLCBjb2xvcnM6IHRydWUgfSk7XG4gICAgICAgIFxuICAgICAgICByZXR1cm4gcmVzdWx0O1xuICAgIH1cblxuICAgIGdldEluc2VydGVkSWQocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5pbnNlcnRJZCA9PT0gJ251bWJlcicgP1xuICAgICAgICAgICAgcmVzdWx0Lmluc2VydElkIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgZ2V0TnVtT2ZBZmZlY3RlZFJvd3MocmVzdWx0KSB7XG4gICAgICAgIHJldHVybiByZXN1bHQgJiYgdHlwZW9mIHJlc3VsdC5hZmZlY3RlZFJvd3MgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5hZmZlY3RlZFJvd3MgOiBcbiAgICAgICAgICAgIHVuZGVmaW5lZDtcbiAgICB9XG5cbiAgICBfZ2VuZXJhdGVBbGlhcyhpbmRleCwgYW5jaG9yKSB7XG4gICAgICAgIGxldCBhbGlhcyA9IG50b2woaW5kZXgpO1xuXG4gICAgICAgIGlmICh0aGlzLm9wdGlvbnMudmVyYm9zZUFsaWFzKSB7XG4gICAgICAgICAgICByZXR1cm4gXy5zbmFrZUNhc2UoYW5jaG9yKS50b1VwcGVyQ2FzZSgpICsgJ18nICsgYWxpYXM7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXM7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXh0cmFjdCBhc3NvY2lhdGlvbnMgaW50byBqb2luaW5nIGNsYXVzZXMuXG4gICAgICogIHtcbiAgICAgKiAgICAgIGVudGl0eTogPHJlbW90ZSBlbnRpdHk+XG4gICAgICogICAgICBqb2luVHlwZTogJ0xFRlQgSk9JTnxJTk5FUiBKT0lOfEZVTEwgT1VURVIgSk9JTidcbiAgICAgKiAgICAgIGFuY2hvcjogJ2xvY2FsIHByb3BlcnR5IHRvIHBsYWNlIHRoZSByZW1vdGUgZW50aXR5J1xuICAgICAqICAgICAgbG9jYWxGaWVsZDogPGxvY2FsIGZpZWxkIHRvIGpvaW4+XG4gICAgICogICAgICByZW1vdGVGaWVsZDogPHJlbW90ZSBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgc3ViQXNzb2NpYXRpb25zOiB7IC4uLiB9XG4gICAgICogIH1cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0geyp9IGFzc29jaWF0aW9ucyBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzS2V5IFxuICAgICAqIEBwYXJhbSB7Kn0gcGFyZW50QWxpYXMgXG4gICAgICogQHBhcmFtIHsqfSBhbGlhc01hcCBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmFtcyBcbiAgICAgKi9cbiAgICBfam9pbkFzc29jaWF0aW9ucyhhc3NvY2lhdGlvbnMsIHBhcmVudEFsaWFzS2V5LCBwYXJlbnRBbGlhcywgYWxpYXNNYXAsIHN0YXJ0SWQsIHBhcmFtcykge1xuICAgICAgICBsZXQgam9pbmluZ3MgPSBbXTtcblxuICAgICAgICAvL2NvbnNvbGUubG9nKCdhc3NvY2lhdGlvbnM6JywgT2JqZWN0LmtleXMoYXNzb2NpYXRpb25zKSk7XG5cbiAgICAgICAgXy5lYWNoKGFzc29jaWF0aW9ucywgKGFzc29jSW5mbywgYW5jaG9yKSA9PiB7IFxuICAgICAgICAgICAgbGV0IGFsaWFzID0gYXNzb2NJbmZvLmFsaWFzIHx8IHRoaXMuX2dlbmVyYXRlQWxpYXMoc3RhcnRJZCsrLCBhbmNob3IpOyBcbiAgICAgICAgICAgIGxldCB7IGpvaW5UeXBlLCBvbiB9ID0gYXNzb2NJbmZvO1xuXG4gICAgICAgICAgICBqb2luVHlwZSB8fCAoam9pblR5cGUgPSAnTEVGVCBKT0lOJyk7XG5cbiAgICAgICAgICAgIGlmIChhc3NvY0luZm8uc3FsKSB7XG4gICAgICAgICAgICAgICAgaWYgKGFzc29jSW5mby5vdXRwdXQpIHsgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBhbGlhc01hcFtwYXJlbnRBbGlhc0tleSArICcuJyArIGFsaWFzXSA9IGFsaWFzOyBcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBhc3NvY0luZm8ucGFyYW1zLmZvckVhY2gocCA9PiBwYXJhbXMucHVzaChwKSk7IFxuICAgICAgICAgICAgICAgIGpvaW5pbmdzLnB1c2goYCR7am9pblR5cGV9ICgke2Fzc29jSW5mby5zcWx9KSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgbGV0IHsgZW50aXR5LCBzdWJBc3NvY3MgfSA9IGFzc29jSW5mbzsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCBhbGlhc0tleSA9IHBhcmVudEFsaWFzS2V5ICsgJy4nICsgYW5jaG9yO1xuICAgICAgICAgICAgYWxpYXNNYXBbYWxpYXNLZXldID0gYWxpYXM7IFxuXG4gICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAke215c3FsLmVzY2FwZUlkKGVudGl0eSl9ICR7YWxpYXN9IE9OICR7dGhpcy5fam9pbkNvbmRpdGlvbihvbiwgcGFyYW1zLCBudWxsLCBwYXJlbnRBbGlhc0tleSwgYWxpYXNNYXApfWApO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoc3ViQXNzb2NzKSB7ICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIGxldCBzdWJKb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMoc3ViQXNzb2NzLCBhbGlhc0tleSwgYWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpO1xuICAgICAgICAgICAgICAgIHN0YXJ0SWQgKz0gc3ViSm9pbmluZ3MubGVuZ3RoO1xuICAgICAgICAgICAgICAgIGpvaW5pbmdzID0gam9pbmluZ3MuY29uY2F0KHN1YkpvaW5pbmdzKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgcmV0dXJuIGpvaW5pbmdzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFNRTCBjb25kaXRpb24gcmVwcmVzZW50YXRpb25cbiAgICAgKiAgIFJ1bGVzOlxuICAgICAqICAgICBkZWZhdWx0OiBcbiAgICAgKiAgICAgICAgYXJyYXk6IE9SXG4gICAgICogICAgICAgIGt2LXBhaXI6IEFORFxuICAgICAqICAgICAkYWxsOiBcbiAgICAgKiAgICAgICAgYXJyYXk6IEFORFxuICAgICAqICAgICAkYW55OlxuICAgICAqICAgICAgICBrdi1wYWlyOiBPUlxuICAgICAqICAgICAkbm90OlxuICAgICAqICAgICAgICBhcnJheTogbm90ICggb3IgKVxuICAgICAqICAgICAgICBrdi1wYWlyOiBub3QgKCBhbmQgKSAgICAgXG4gICAgICogQHBhcmFtIHtvYmplY3R9IGNvbmRpdGlvbiBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Db25kaXRpb24oY29uZGl0aW9uLCBwYXJhbXMsIGpvaW5PcGVyYXRvciwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoY29uZGl0aW9uKSkge1xuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnT1InO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIGNvbmRpdGlvbi5tYXAoYyA9PiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKGMsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknKS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdChjb25kaXRpb24pKSB7IFxuICAgICAgICAgICAgaWYgKCFqb2luT3BlcmF0b3IpIHtcbiAgICAgICAgICAgICAgICBqb2luT3BlcmF0b3IgPSAnQU5EJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIF8ubWFwKGNvbmRpdGlvbiwgKHZhbHVlLCBrZXkpID0+IHtcbiAgICAgICAgICAgICAgICBpZiAoa2V5ID09PSAnJGFsbCcgfHwga2V5ID09PSAnJGFuZCcpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkYW5kXCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IG9yIHBsYWluIG9iamVjdC4nOyAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ0FORCcsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJztcbiAgICAgICAgICAgICAgICB9XG4gICAgXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbnknIHx8IGtleSA9PT0gJyRvcicgfHwga2V5LnN0YXJ0c1dpdGgoJyRvcl8nKSkge1xuICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IEFycmF5LmlzQXJyYXkodmFsdWUpIHx8IF8uaXNQbGFpbk9iamVjdCh2YWx1ZSksICdcIiRvclwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCAnT1InLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRub3QnKSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IHZhbHVlLmxlbmd0aCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG4gICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IG51bU9mRWxlbWVudCA9IE9iamVjdC5rZXlzKHZhbHVlKS5sZW5ndGg7ICAgXG4gICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6IG51bU9mRWxlbWVudCA+IDAsICdcIiRub3RcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgbm9uLWVtcHR5Lic7ICAgICAgICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgdGhpcy5fam9pbkNvbmRpdGlvbih2YWx1ZSwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgdmFsdWUgPT09ICdzdHJpbmcnLCAnVW5zdXBwb3J0ZWQgY29uZGl0aW9uISc7XG5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyBjb25kaXRpb24gKyAnKSc7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICB9ICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oa2V5LCB2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9KS5qb2luKGAgJHtqb2luT3BlcmF0b3J9IGApO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHR5cGVvZiBjb25kaXRpb24gIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiFcXG4gVmFsdWU6ICcgKyBKU09OLnN0cmluZ2lmeShjb25kaXRpb24pKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiBjb25kaXRpb247XG4gICAgfVxuXG4gICAgX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkge1xuICAgICAgICBsZXQgcGFydHMgPSBmaWVsZE5hbWUuc3BsaXQoJy4nKTtcbiAgICAgICAgaWYgKHBhcnRzLmxlbmd0aCA+IDEpIHtcbiAgICAgICAgICAgIGxldCBhY3R1YWxGaWVsZE5hbWUgPSBwYXJ0cy5wb3AoKTtcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFsaWFzTWFwW21haW5FbnRpdHkgKyAnLicgKyBwYXJ0cy5qb2luKCcuJyldO1xuICAgICAgICAgICAgaWYgKCFhbGlhcykge1xuICAgICAgICAgICAgICAgIGxldCBtc2cgPSBgVW5rbm93biBjb2x1bW4gcmVmZXJlbmNlOiAke2ZpZWxkTmFtZX1gO1xuICAgICAgICAgICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsIG1zZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKG1zZyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIHJldHVybiBhbGlhcyArICcuJyArIG15c3FsLmVzY2FwZUlkKGFjdHVhbEZpZWxkTmFtZSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gYWxpYXNNYXBbbWFpbkVudGl0eV0gKyAnLicgKyAoZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpKTtcbiAgICB9XG5cbiAgICBfZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCkgeyAgIFxuXG4gICAgICAgIGlmIChtYWluRW50aXR5KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fcmVwbGFjZUZpZWxkTmFtZVdpdGhBbGlhcyhmaWVsZE5hbWUsIG1haW5FbnRpdHksIGFsaWFzTWFwKTsgXG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gZmllbGROYW1lID09PSAnKicgPyBmaWVsZE5hbWUgOiBteXNxbC5lc2NhcGVJZChmaWVsZE5hbWUpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFdyYXAgYSBjb25kaXRpb24gY2xhdXNlICAgICBcbiAgICAgKiBcbiAgICAgKiBWYWx1ZSBjYW4gYmUgYSBsaXRlcmFsIG9yIGEgcGxhaW4gY29uZGl0aW9uIG9iamVjdC5cbiAgICAgKiAgIDEuIGZpZWxkTmFtZSwgPGxpdGVyYWw+XG4gICAgICogICAyLiBmaWVsZE5hbWUsIHsgbm9ybWFsIG9iamVjdCB9IFxuICAgICAqIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBmaWVsZE5hbWUgXG4gICAgICogQHBhcmFtIHsqfSB2YWx1ZSBcbiAgICAgKiBAcGFyYW0ge2FycmF5fSB2YWx1ZXNTZXEgIFxuICAgICAqL1xuICAgIF93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdmFsdWUsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCkge1xuICAgICAgICBpZiAoXy5pc05pbCh2YWx1ZSkpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgSVMgTlVMTCc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KHZhbHVlKSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlLm9vclR5cGUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSA9PT0gJ0NvbHVtblJlZmVyZW5jZScpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3dyYXBDb25kaXRpb24oZmllbGROYW1lLCB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyh2YWx1ZS5uYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCksIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXAsIHRydWUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ3RvZG86IGFkZCBvb3JUeXBlIHN1cHBvcnQ6ICcgKyB2YWx1ZS5vb3JUeXBlKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGhhc09wZXJhdG9yID0gXy5maW5kKE9iamVjdC5rZXlzKHZhbHVlKSwgayA9PiBrICYmIGtbMF0gPT09ICckJyk7XG5cbiAgICAgICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiBfLm1hcCh2YWx1ZSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGsgJiYga1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvcGVyYXRvclxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNQcmltaXRpdmUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgdmFsdWVzU2VxLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0XCIgb3IgXCIkPFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdGVcIiBvciBcIiQ8PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhbHVlc1NlcS5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdmFsdWVzU2VxLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbmRpdGlvbiBvcGVyYXRvcjogXCIke2t9XCIhYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09wZXJhdG9yIHNob3VsZCBub3QgYmUgbWl4ZWQgd2l0aCBjb25kaXRpb24gdmFsdWUuJyk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KS5qb2luKCcgQU5EICcpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgICBcblxuICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICB2YWx1ZXNTZXEucHVzaChKU09OLnN0cmluZ2lmeSh2YWx1ZSkpO1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ID8nO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA9ICcgKyB2YWx1ZTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgdmFsdWVzU2VxLnB1c2godmFsdWUpO1xuICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgfVxuXG4gICAgX2J1aWxkQ29sdW1ucyhjb2x1bW5zLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7ICAgICAgICBcbiAgICAgICAgcmV0dXJuIF8ubWFwKF8uY2FzdEFycmF5KGNvbHVtbnMpLCBjb2wgPT4gdGhpcy5fYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW4oY29sLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnc3RyaW5nJykgeyAgXG4gICAgICAgICAgICAvL2l0J3MgYSBzdHJpbmcgaWYgaXQncyBxdW90ZWQgd2hlbiBwYXNzZWQgaW4gICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBpc1F1b3RlZChjb2wpID8gY29sIDogdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAodHlwZW9mIGNvbCA9PT0gJ251bWJlcicpIHtcbiAgICAgICAgICAgIHJldHVybiBjb2w7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGNvbCkpIHsgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBpZiAoY29sLmFsaWFzKSB7XG4gICAgICAgICAgICAgICAgYXNzZXJ0OiB0eXBlb2YgY29sLmFsaWFzID09PSAnc3RyaW5nJztcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9idWlsZENvbHVtbihfLm9taXQoY29sLCBbJ2FsaWFzJ10pLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgQVMgJyArIG15c3FsLmVzY2FwZUlkKGNvbC5hbGlhcyk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2Z1bmN0aW9uJykge1xuICAgICAgICAgICAgICAgIGlmIChjb2wubmFtZS50b1VwcGVyQ2FzZSgpID09PSAnQ09VTlQnICYmIGNvbC5hcmdzLmxlbmd0aCA9PT0gMSAmJiBjb2wuYXJnc1swXSA9PT0gJyonKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnQ09VTlQoKiknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBjb2wubmFtZSArICcoJyArIChjb2wuYXJncyA/IHRoaXMuX2J1aWxkQ29sdW1ucyhjb2wuYXJncywgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnJykgKyAnKSc7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGlmIChjb2wudHlwZSA9PT0gJ2V4cHJlc3Npb24nKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2pvaW5Db25kaXRpb24oY29sLmV4cHIsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vdyBjb2x1bW4gc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGNvbCl9YCk7XG4gICAgfVxuXG4gICAgX2J1aWxkR3JvdXBCeShncm91cEJ5LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2YgZ3JvdXBCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnR1JPVVAgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGdyb3VwQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShncm91cEJ5KSkgcmV0dXJuICdHUk9VUCBCWSAnICsgZ3JvdXBCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KGdyb3VwQnkpKSB7XG4gICAgICAgICAgICBsZXQgeyBjb2x1bW5zLCBoYXZpbmcgfSA9IGdyb3VwQnk7XG5cbiAgICAgICAgICAgIGlmICghY29sdW1ucyB8fCAhQXJyYXkuaXNBcnJheShjb2x1bW5zKSkge1xuICAgICAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBJbnZhbGlkIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICAgICAgICAgIH0gXG5cbiAgICAgICAgICAgIGxldCBncm91cEJ5Q2xhdXNlID0gdGhpcy5fYnVpbGRHcm91cEJ5KGNvbHVtbnMpO1xuICAgICAgICAgICAgbGV0IGhhdmluZ0NsdXNlID0gaGF2aW5nICYmIHRoaXMuX2pvaW5Db25kaXRpb24oaGF2aW5nLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIGlmIChoYXZpbmdDbHVzZSkge1xuICAgICAgICAgICAgICAgIGdyb3VwQnlDbGF1c2UgKz0gJyBIQVZJTkcgJyArIGhhdmluZ0NsdXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICByZXR1cm4gZ3JvdXBCeUNsYXVzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBVbmtub3duIGdyb3VwIGJ5IHN5bnRheDogJHtKU09OLnN0cmluZ2lmeShncm91cEJ5KX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRPcmRlckJ5KG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmICh0eXBlb2Ygb3JkZXJCeSA9PT0gJ3N0cmluZycpIHJldHVybiAnT1JERVIgQlkgJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShvcmRlckJ5KSkgcmV0dXJuICdPUkRFUiBCWSAnICsgb3JkZXJCeS5tYXAoYnkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoYnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSkuam9pbignLCAnKTtcblxuICAgICAgICBpZiAoXy5pc1BsYWluT2JqZWN0KG9yZGVyQnkpKSB7XG4gICAgICAgICAgICByZXR1cm4gJ09SREVSIEJZICcgKyBfLm1hcChvcmRlckJ5LCAoYXNjLCBjb2wpID0+IHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGNvbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgKGFzYyA/ICcnIDogJyBERVNDJykpLmpvaW4oJywgJyk7IFxuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gb3JkZXIgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KG9yZGVyQnkpfWApO1xuICAgIH1cblxuICAgIGFzeW5jIF9nZXRDb25uZWN0aW9uXyhvcHRpb25zKSB7XG4gICAgICAgIHJldHVybiAob3B0aW9ucyAmJiBvcHRpb25zLmNvbm5lY3Rpb24pID8gb3B0aW9ucy5jb25uZWN0aW9uIDogdGhpcy5jb25uZWN0XyhvcHRpb25zKTtcbiAgICB9XG5cbiAgICBhc3luYyBfcmVsZWFzZUNvbm5lY3Rpb25fKGNvbm4sIG9wdGlvbnMpIHtcbiAgICAgICAgaWYgKCFvcHRpb25zIHx8ICFvcHRpb25zLmNvbm5lY3Rpb24pIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5tb2R1bGUuZXhwb3J0cyA9IE15U1FMQ29ubmVjdG9yOyJdfQ==