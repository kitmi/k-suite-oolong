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
    this.log('verbose', 'Begins a new transaction.');
    return conn;
  }

  async commit_(conn) {
    await conn.commit();
    this.log('verbose', 'Commits a transaction.');
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
          this.log('verbose', conn.format(sql, params));
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

      if (this.options.logSQLStatement) {
        this.log('verbose', conn.format(sql, params));
      }

      if (options && options.rowsAsArray) {
        return await conn.query({
          sql,
          rowsAsArray: true
        }, params);
      }

      let [rows2] = await conn.query(sql, params);
      return rows2;
    } catch (err) {
      err.extraInfo || (err.extraInfo = {});
      err.extraInfo.sql = _.truncate(sql, {
        length: 200
      });
      err.extraInfo.params = params;
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
    if (_.isEmpty(data)) {
      throw new BusinessError('Empty data to update.');
    }

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

    if (queryOptions.$requireSplitColumns) {
      sql += ' SET ' + this._splitColumnsAsInput(data, params, hasJoining, aliasMap).join(',');
    } else {
      params.push(data);
      sql += ' SET ?';
    }

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

  _splitColumnsAsInput(data, params, hasJoining, aliasMap) {
    return _.map(data, (v, fieldName) => {
      if (!(fieldName.indexOf('.') === -1)) {
        throw new Error('Column of direct input data cannot be a dot-separated name.');
      }

      return mysql.escapeId(fieldName) + '=' + this._packValue(v, params, hasJoining, aliasMap);
    });
  }

  _packArray(array, params, hasJoining, aliasMap) {
    return array.map(value => this._packValue(value, params, hasJoining, aliasMap)).join(',');
  }

  _packValue(value, params, hasJoining, aliasMap) {
    if (_.isPlainObject(value)) {
      if (value.oorType) {
        switch (value.oorType) {
          case 'ColumnReference':
            return this._escapeIdWithAlias(value.name, hasJoining, aliasMap);

          case 'Function':
            return value.name + '(' + (value.args ? this._packArray(value.args, params, hasJoining, aliasMap) : '') + ')';

          case 'BinaryExpression':
            let left = this._packValue(value.left, params, hasJoining, aliasMap);

            let right = this._packValue(value.right, params, hasJoining, aliasMap);

            return left + ` ${value.op} ` + right;

          default:
            throw new Error(`Unknown oor type: ${value.oorType}`);
        }
      }

      value = JSON.stringify(value);
    }

    params.push(value);
    return '?';
  }

  _wrapCondition(fieldName, value, params, hasJoining, aliasMap, inject) {
    if (_.isNil(value)) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IS NULL';
    }

    if (Array.isArray(value)) {
      return this._wrapCondition(fieldName, {
        $in: value
      }, params, hasJoining, aliasMap, inject);
    }

    if (_.isPlainObject(value)) {
      if (value.oorType) {
        return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + this._packValue(value, params, hasJoining, aliasMap);
      }

      let hasOperator = _.find(Object.keys(value), k => k && k[0] === '$');

      if (hasOperator) {
        return _.map(value, (v, k) => {
          if (k && k[0] === '$') {
            switch (k) {
              case '$eq':
              case '$equal':
                return this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, inject);

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

                  params.push(v);
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <> ?';
                }

                return 'NOT (' + this._wrapCondition(fieldName, v, params, hasJoining, aliasMap, true) + ')';

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

                params.push(v);
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

                params.push(v);
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

                params.push(v);
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

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' <= ?';

              case '$in':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` IN (${v})`;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' IN (?)';

              case '$nin':
              case '$notIn':
                if (!Array.isArray(v)) {
                  throw new Error('The value should be an array when using "$in" operator.');
                }

                if (inject) {
                  return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ` NOT IN (${v})`;
                }

                params.push(v);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' NOT IN (?)';

              case '$startWith':
              case '$startsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$startWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`${v}%`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$endWith':
              case '$endsWith':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$endWith" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`%${v}`);
                return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' LIKE ?';

              case '$like':
              case '$likes':
                if (typeof v !== 'string') {
                  throw new Error('The value should be a string when using "$like" operator.');
                }

                if (!!inject) {
                  throw new Error("Assertion failed: !inject");
                }

                params.push(`%${v}%`);
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

      params.push(JSON.stringify(value));
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ?';
    }

    if (inject) {
      return this._escapeIdWithAlias(fieldName, hasJoining, aliasMap) + ' = ' + value;
    }

    params.push(value);
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
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uLy4uLy4uL3NyYy9ydW50aW1lL2RyaXZlcnMvbXlzcWwvQ29ubmVjdG9yLmpzIl0sIm5hbWVzIjpbIl8iLCJlYWNoQXN5bmNfIiwic2V0VmFsdWVCeVBhdGgiLCJyZXF1aXJlIiwidHJ5UmVxdWlyZSIsIm15c3FsIiwiQ29ubmVjdG9yIiwiT29sb25nVXNhZ2VFcnJvciIsIkJ1c2luZXNzRXJyb3IiLCJpc1F1b3RlZCIsImlzUHJpbWl0aXZlIiwibnRvbCIsIk15U1FMQ29ubmVjdG9yIiwiY29uc3RydWN0b3IiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImVzY2FwZSIsImVzY2FwZUlkIiwiZm9ybWF0IiwicmF3IiwiaW5zZXJ0T25lXyIsImNyZWF0ZV8iLCJ1cGRhdGVPbmVfIiwidXBkYXRlXyIsIl9wb29scyIsIl9hY2l0dmVDb25uZWN0aW9ucyIsIk1hcCIsInN0cmluZ0Zyb21Db25uZWN0aW9uIiwiY29ubiIsIml0IiwiZ2V0IiwiZW5kXyIsImtleXMiLCJkaXNjb25uZWN0XyIsInBvb2wiLCJjcyIsImVuZCIsImNvbm5lY3RfIiwiY3NLZXkiLCJjb25uUHJvcHMiLCJjcmVhdGVEYXRhYmFzZSIsImRhdGFiYXNlIiwicGljayIsImdldE5ld0Nvbm5lY3Rpb25TdHJpbmciLCJjcmVhdGVQb29sIiwiZ2V0Q29ubmVjdGlvbiIsInNldCIsImRlbGV0ZSIsInJlbGVhc2UiLCJiZWdpblRyYW5zYWN0aW9uXyIsImlzb2xhdGlvbkxldmVsIiwiZmluZCIsIklzb2xhdGlvbkxldmVscyIsInZhbHVlIiwia2V5IiwicXVlcnkiLCJiZWdpblRyYW5zYWN0aW9uIiwibG9nIiwiY29tbWl0XyIsImNvbW1pdCIsInJvbGxiYWNrXyIsInJvbGxiYWNrIiwiZXhlY3V0ZV8iLCJzcWwiLCJwYXJhbXMiLCJfZ2V0Q29ubmVjdGlvbl8iLCJ1c2VQcmVwYXJlZFN0YXRlbWVudCIsImxvZ1NRTFN0YXRlbWVudCIsInJvd3NBc0FycmF5IiwiZXhlY3V0ZSIsInJvd3MxIiwicm93czIiLCJlcnIiLCJleHRyYUluZm8iLCJ0cnVuY2F0ZSIsImxlbmd0aCIsIl9yZWxlYXNlQ29ubmVjdGlvbl8iLCJwaW5nXyIsInBpbmciLCJyZXN1bHQiLCJtb2RlbCIsImRhdGEiLCJpc0VtcHR5IiwicHVzaCIsInF1ZXJ5T3B0aW9ucyIsImNvbm5PcHRpb25zIiwiYWxpYXNNYXAiLCJqb2luaW5ncyIsImhhc0pvaW5pbmciLCJqb2luaW5nUGFyYW1zIiwiJHJlbGF0aW9uc2hpcHMiLCJfam9pbkFzc29jaWF0aW9ucyIsImZvckVhY2giLCJwIiwiam9pbiIsIiRyZXF1aXJlU3BsaXRDb2x1bW5zIiwiX3NwbGl0Q29sdW1uc0FzSW5wdXQiLCJ3aGVyZUNsYXVzZSIsIl9qb2luQ29uZGl0aW9uIiwicmVwbGFjZV8iLCJkZWxldGVfIiwiY29uZGl0aW9uIiwiZmluZF8iLCJzcWxJbmZvIiwiYnVpbGRRdWVyeSIsInRvdGFsQ291bnQiLCJjb3VudFNxbCIsImNvdW50UmVzdWx0IiwicmV2ZXJzZUFsaWFzTWFwIiwicmVkdWNlIiwiYWxpYXMiLCJub2RlUGF0aCIsInNwbGl0Iiwic2xpY2UiLCJtYXAiLCJuIiwiY29uY2F0IiwiJHByb2plY3Rpb24iLCIkcXVlcnkiLCIkZ3JvdXBCeSIsIiRvcmRlckJ5IiwiJG9mZnNldCIsIiRsaW1pdCIsIiR0b3RhbENvdW50Iiwic2VsZWN0Q29sb21ucyIsIl9idWlsZENvbHVtbnMiLCJfYnVpbGRHcm91cEJ5IiwiX2J1aWxkT3JkZXJCeSIsImNvdW50U3ViamVjdCIsIl9lc2NhcGVJZFdpdGhBbGlhcyIsImlzSW50ZWdlciIsImdldEluc2VydGVkSWQiLCJpbnNlcnRJZCIsInVuZGVmaW5lZCIsImdldE51bU9mQWZmZWN0ZWRSb3dzIiwiYWZmZWN0ZWRSb3dzIiwiX2dlbmVyYXRlQWxpYXMiLCJpbmRleCIsImFuY2hvciIsInZlcmJvc2VBbGlhcyIsInNuYWtlQ2FzZSIsInRvVXBwZXJDYXNlIiwiYXNzb2NpYXRpb25zIiwicGFyZW50QWxpYXNLZXkiLCJwYXJlbnRBbGlhcyIsInN0YXJ0SWQiLCJlYWNoIiwiYXNzb2NJbmZvIiwiam9pblR5cGUiLCJvbiIsIm91dHB1dCIsImVudGl0eSIsInN1YkFzc29jcyIsImFsaWFzS2V5Iiwic3ViSm9pbmluZ3MiLCJqb2luT3BlcmF0b3IiLCJBcnJheSIsImlzQXJyYXkiLCJjIiwiaXNQbGFpbk9iamVjdCIsInN0YXJ0c1dpdGgiLCJudW1PZkVsZW1lbnQiLCJPYmplY3QiLCJfd3JhcENvbmRpdGlvbiIsIkVycm9yIiwiSlNPTiIsInN0cmluZ2lmeSIsIl9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzIiwiZmllbGROYW1lIiwibWFpbkVudGl0eSIsInBhcnRzIiwiYWN0dWFsRmllbGROYW1lIiwicG9wIiwibXNnIiwidiIsImluZGV4T2YiLCJfcGFja1ZhbHVlIiwiX3BhY2tBcnJheSIsImFycmF5Iiwib29yVHlwZSIsIm5hbWUiLCJhcmdzIiwibGVmdCIsInJpZ2h0Iiwib3AiLCJpbmplY3QiLCJpc05pbCIsIiRpbiIsImhhc09wZXJhdG9yIiwiayIsImlzRmluaXRlIiwidG9GaW5pdGUiLCJpc05hTiIsImNvbHVtbnMiLCJjYXN0QXJyYXkiLCJjb2wiLCJfYnVpbGRDb2x1bW4iLCJvbWl0IiwidHlwZSIsImV4cHIiLCJncm91cEJ5IiwiYnkiLCJoYXZpbmciLCJncm91cEJ5Q2xhdXNlIiwiaGF2aW5nQ2x1c2UiLCJvcmRlckJ5IiwiYXNjIiwiY29ubmVjdGlvbiIsImZyZWV6ZSIsIlJlcGVhdGFibGVSZWFkIiwiUmVhZENvbW1pdHRlZCIsIlJlYWRVbmNvbW1pdHRlZCIsIlJlcmlhbGl6YWJsZSIsIm1vZHVsZSIsImV4cG9ydHMiXSwibWFwcGluZ3MiOiI7Ozs7QUFBQSxNQUFNO0FBQUVBLEVBQUFBLENBQUY7QUFBS0MsRUFBQUEsVUFBTDtBQUFpQkMsRUFBQUE7QUFBakIsSUFBb0NDLE9BQU8sQ0FBQyxVQUFELENBQWpEOztBQUNBLE1BQU07QUFBRUMsRUFBQUE7QUFBRixJQUFpQkQsT0FBTyxDQUFD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SzFLLFFBQUwsQ0FBY3RCLE9BQWQsQ0FBOUQ7QUFDSDs7QUFFRCxRQUFNNkQsbUJBQU4sQ0FBMEJoRCxJQUExQixFQUFnQ2IsT0FBaEMsRUFBeUM7QUFDckMsUUFBSSxDQUFDQSxPQUFELElBQVksQ0FBQ0EsT0FBTyxDQUFDZ00sVUFBekIsRUFBcUM7QUFDakMsYUFBTyxLQUFLOUssV0FBTCxDQUFpQkwsSUFBakIsQ0FBUDtBQUNIO0FBQ0o7O0FBaDZCa0M7O0FBQWpDaEIsYyxDQU1Ld0MsZSxHQUFrQjhHLE1BQU0sQ0FBQzhDLE1BQVAsQ0FBYztBQUNuQ0MsRUFBQUEsY0FBYyxFQUFFLGlCQURtQjtBQUVuQ0MsRUFBQUEsYUFBYSxFQUFFLGdCQUZvQjtBQUduQ0MsRUFBQUEsZUFBZSxFQUFFLGtCQUhrQjtBQUluQ0MsRUFBQUEsWUFBWSxFQUFFO0FBSnFCLENBQWQsQztBQTY1QjdCQyxNQUFNLENBQUNDLE9BQVAsR0FBaUIxTSxjQUFqQiIsInNvdXJjZXNDb250ZW50IjpbImNvbnN0IHsgXywgZWFjaEFzeW5jXywgc2V0VmFsdWVCeVBhdGggfSA9IHJlcXVpcmUoJ3JrLXV0aWxzJyk7XG5jb25zdCB7IHRyeVJlcXVpcmUgfSA9IHJlcXVpcmUoJ0BrLXN1aXRlL2FwcC9saWIvdXRpbHMvSGVscGVycycpO1xuY29uc3QgbXlzcWwgPSB0cnlSZXF1aXJlKCdteXNxbDIvcHJvbWlzZScpO1xuY29uc3QgQ29ubmVjdG9yID0gcmVxdWlyZSgnLi4vLi4vQ29ubmVjdG9yJyk7XG5jb25zdCB7IE9vbG9uZ1VzYWdlRXJyb3IsIEJ1c2luZXNzRXJyb3IgfSA9IHJlcXVpcmUoJy4uLy4uL0Vycm9ycycpO1xuY29uc3QgeyBpc1F1b3RlZCwgaXNQcmltaXRpdmUgfSA9IHJlcXVpcmUoJy4uLy4uLy4uL3V0aWxzL2xhbmcnKTtcbmNvbnN0IG50b2wgPSByZXF1aXJlKCdudW1iZXItdG8tbGV0dGVyJyk7XG5cbi8qKlxuICogTXlTUUwgZGF0YSBzdG9yYWdlIGNvbm5lY3Rvci5cbiAqIEBjbGFzc1xuICogQGV4dGVuZHMgQ29ubmVjdG9yXG4gKi9cbmNsYXNzIE15U1FMQ29ubmVjdG9yIGV4dGVuZHMgQ29ubmVjdG9yIHtcbiAgICAvKipcbiAgICAgKiBUcmFuc2FjdGlvbiBpc29sYXRpb24gbGV2ZWxcbiAgICAgKiB7QGxpbmsgaHR0cHM6Ly9kZXYubXlzcWwuY29tL2RvYy9yZWZtYW4vOC4wL2VuL2lubm9kYi10cmFuc2FjdGlvbi1pc29sYXRpb24tbGV2ZWxzLmh0bWx9XG4gICAgICogQG1lbWJlciB7b2JqZWN0fVxuICAgICAqL1xuICAgIHN0YXRpYyBJc29sYXRpb25MZXZlbHMgPSBPYmplY3QuZnJlZXplKHtcbiAgICAgICAgUmVwZWF0YWJsZVJlYWQ6ICdSRVBFQVRBQkxFIFJFQUQnLFxuICAgICAgICBSZWFkQ29tbWl0dGVkOiAnUkVBRCBDT01NSVRURUQnLFxuICAgICAgICBSZWFkVW5jb21taXR0ZWQ6ICdSRUFEIFVOQ09NTUlUVEVEJyxcbiAgICAgICAgUmVyaWFsaXphYmxlOiAnU0VSSUFMSVpBQkxFJ1xuICAgIH0pOyAgICBcbiAgICBcbiAgICBlc2NhcGUgPSBteXNxbC5lc2NhcGU7XG4gICAgZXNjYXBlSWQgPSBteXNxbC5lc2NhcGVJZDtcbiAgICBmb3JtYXQgPSBteXNxbC5mb3JtYXQ7XG4gICAgcmF3ID0gbXlzcWwucmF3O1xuXG4gICAgLyoqICAgICAgICAgIFxuICAgICAqIEBwYXJhbSB7c3RyaW5nfSBuYW1lIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBvcHRpb25zIFxuICAgICAqIEBwcm9wZXJ0eSB7Ym9vbGVhbn0gW29wdGlvbnMudXNlUHJlcGFyZWRTdGF0ZW1lbnRdIC0gXG4gICAgICovXG4gICAgY29uc3RydWN0b3IoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIHN1cGVyKCdteXNxbCcsIGNvbm5lY3Rpb25TdHJpbmcsIG9wdGlvbnMpO1xuXG4gICAgICAgIHRoaXMuX3Bvb2xzID0ge307XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zID0gbmV3IE1hcCgpO1xuICAgIH1cblxuICAgIHN0cmluZ0Zyb21Db25uZWN0aW9uKGNvbm4pIHtcbiAgICAgICAgcG9zdDogIWNvbm4gfHwgaXQsICdDb25uZWN0aW9uIG9iamVjdCBub3QgZm91bmQgaW4gYWNpdHZlIGNvbm5lY3Rpb25zIG1hcC4nOyBcbiAgICAgICAgcmV0dXJuIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmdldChjb25uKTtcbiAgICB9ICAgIFxuXG4gICAgLyoqXG4gICAgICogQ2xvc2UgYWxsIGNvbm5lY3Rpb24gaW5pdGlhdGVkIGJ5IHRoaXMgY29ubmVjdG9yLlxuICAgICAqL1xuICAgIGFzeW5jIGVuZF8oKSB7XG4gICAgICAgIGZvciAobGV0IGNvbm4gb2YgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMua2V5cygpKSB7XG4gICAgICAgICAgICBhd2FpdCB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBlYWNoQXN5bmNfKHRoaXMuX3Bvb2xzLCBhc3luYyAocG9vbCwgY3MpID0+IHtcbiAgICAgICAgICAgIGF3YWl0IHBvb2wuZW5kKCk7XG4gICAgICAgIH0pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIGRhdGFiYXNlIGNvbm5lY3Rpb24gYmFzZWQgb24gdGhlIGRlZmF1bHQgY29ubmVjdGlvbiBzdHJpbmcgb2YgdGhlIGNvbm5lY3RvciBhbmQgZ2l2ZW4gb3B0aW9ucy4gICAgIFxuICAgICAqIEBwYXJhbSB7T2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBvcHRpb25zIGZvciB0aGUgY29ubmVjdGlvbiwgb3B0aW9uYWwuXG4gICAgICogQHByb3BlcnR5IHtib29sfSBbb3B0aW9ucy5tdWx0aXBsZVN0YXRlbWVudHM9ZmFsc2VdIC0gQWxsb3cgcnVubmluZyBtdWx0aXBsZSBzdGF0ZW1lbnRzIGF0IGEgdGltZS5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2x9IFtvcHRpb25zLmNyZWF0ZURhdGFiYXNlPWZhbHNlXSAtIEZsYWcgdG8gdXNlZCB3aGVuIGNyZWF0aW5nIGEgZGF0YWJhc2UuXG4gICAgICogQHJldHVybnMge1Byb21pc2UuPE15U1FMQ29ubmVjdGlvbj59XG4gICAgICovXG4gICAgYXN5bmMgY29ubmVjdF8ob3B0aW9ucykge1xuICAgICAgICBsZXQgY3NLZXkgPSB0aGlzLmNvbm5lY3Rpb25TdHJpbmc7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGxldCBjb25uUHJvcHMgPSB7fTtcblxuICAgICAgICAgICAgaWYgKG9wdGlvbnMuY3JlYXRlRGF0YWJhc2UpIHtcbiAgICAgICAgICAgICAgICAvL3JlbW92ZSB0aGUgZGF0YWJhc2UgZnJvbSBjb25uZWN0aW9uXG4gICAgICAgICAgICAgICAgY29ublByb3BzLmRhdGFiYXNlID0gJyc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGNvbm5Qcm9wcy5vcHRpb25zID0gXy5waWNrKG9wdGlvbnMsIFsnbXVsdGlwbGVTdGF0ZW1lbnRzJ10pOyAgICAgXG5cbiAgICAgICAgICAgIGNzS2V5ID0gdGhpcy5nZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbm5Qcm9wcyk7XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGxldCBwb29sID0gdGhpcy5fcG9vbHNbY3NLZXldO1xuXG4gICAgICAgIGlmICghcG9vbCkgeyAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcG9vbCA9IG15c3FsLmNyZWF0ZVBvb2woY3NLZXkpO1xuICAgICAgICAgICAgdGhpcy5fcG9vbHNbY3NLZXldID0gcG9vbDtcbiAgICAgICAgfSAgICAgICAgXG5cbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCBwb29sLmdldENvbm5lY3Rpb24oKTtcbiAgICAgICAgdGhpcy5fYWNpdHZlQ29ubmVjdGlvbnMuc2V0KGNvbm4sIGNzS2V5KTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENsb3NlIGEgZGF0YWJhc2UgY29ubmVjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgZGlzY29ubmVjdF8oY29ubikgeyAgICAgICAgXG4gICAgICAgIGxldCBjcyA9IHRoaXMuc3RyaW5nRnJvbUNvbm5lY3Rpb24oY29ubik7XG4gICAgICAgIHRoaXMuX2FjaXR2ZUNvbm5lY3Rpb25zLmRlbGV0ZShjb25uKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBjb25uLnJlbGVhc2UoKTsgICAgIFxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFN0YXJ0IGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtvYmplY3R9IG9wdGlvbnMgLSBPcHRpb25zXG4gICAgICogQHByb3BlcnR5IHtzdHJpbmd9IFtvcHRpb25zLmlzb2xhdGlvbkxldmVsXVxuICAgICAqL1xuICAgIGFzeW5jIGJlZ2luVHJhbnNhY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IGNvbm4gPSBhd2FpdCB0aGlzLmNvbm5lY3RfKCk7XG5cbiAgICAgICAgaWYgKG9wdGlvbnMgJiYgb3B0aW9ucy5pc29sYXRpb25MZXZlbCkge1xuICAgICAgICAgICAgLy9vbmx5IGFsbG93IHZhbGlkIG9wdGlvbiB2YWx1ZSB0byBhdm9pZCBpbmplY3Rpb24gYXR0YWNoXG4gICAgICAgICAgICBsZXQgaXNvbGF0aW9uTGV2ZWwgPSBfLmZpbmQoTXlTUUxDb25uZWN0b3IuSXNvbGF0aW9uTGV2ZWxzLCAodmFsdWUsIGtleSkgPT4gb3B0aW9ucy5pc29sYXRpb25MZXZlbCA9PT0ga2V5IHx8IG9wdGlvbnMuaXNvbGF0aW9uTGV2ZWwgPT09IHZhbHVlKTtcbiAgICAgICAgICAgIGlmICghaXNvbGF0aW9uTGV2ZWwpIHtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgSW52YWxpZCBpc29sYXRpb24gbGV2ZWw6IFwiJHtpc29sYXRpb25MZXZlbH1cIiFcImApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBhd2FpdCBjb25uLnF1ZXJ5KCdTRVQgU0VTU0lPTiBUUkFOU0FDVElPTiBJU09MQVRJT04gTEVWRUwgJyArIGlzb2xhdGlvbkxldmVsKTsgICAgICAgICAgICBcbiAgICAgICAgfVxuXG4gICAgICAgIGF3YWl0IGNvbm4uYmVnaW5UcmFuc2FjdGlvbigpO1xuICAgICAgICBcbiAgICAgICAgdGhpcy5sb2coJ3ZlcmJvc2UnLCAnQmVnaW5zIGEgbmV3IHRyYW5zYWN0aW9uLicpO1xuICAgICAgICByZXR1cm4gY29ubjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBDb21taXQgYSB0cmFuc2FjdGlvbi5cbiAgICAgKiBAcGFyYW0ge015U1FMQ29ubmVjdGlvbn0gY29ubiAtIE15U1FMIGNvbm5lY3Rpb24uXG4gICAgICovXG4gICAgYXN5bmMgY29tbWl0Xyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4uY29tbWl0KCk7XG4gICAgICAgIFxuICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsICdDb21taXRzIGEgdHJhbnNhY3Rpb24uJyk7XG4gICAgICAgIHJldHVybiB0aGlzLmRpc2Nvbm5lY3RfKGNvbm4pO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJvbGxiYWNrIGEgdHJhbnNhY3Rpb24uXG4gICAgICogQHBhcmFtIHtNeVNRTENvbm5lY3Rpb259IGNvbm4gLSBNeVNRTCBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIHJvbGxiYWNrXyhjb25uKSB7XG4gICAgICAgIGF3YWl0IGNvbm4ucm9sbGJhY2soKTtcbiAgICAgICAgXG4gICAgICAgIHRoaXMubG9nKCdkZWJ1ZycsICdSb2xsYmFja3MgYSB0cmFuc2FjdGlvbi4nKTtcbiAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogRXhlY3V0ZSB0aGUgc3FsIHN0YXRlbWVudC5cbiAgICAgKlxuICAgICAqIEBwYXJhbSB7U3RyaW5nfSBzcWwgLSBUaGUgU1FMIHN0YXRlbWVudCB0byBleGVjdXRlLlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBwYXJhbXMgLSBQYXJhbWV0ZXJzIHRvIGJlIHBsYWNlZCBpbnRvIHRoZSBTUUwgc3RhdGVtZW50LlxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeGVjdXRpb24gb3B0aW9ucy5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50XSAtIFdoZXRoZXIgdG8gdXNlIHByZXBhcmVkIHN0YXRlbWVudCB3aGljaCBpcyBjYWNoZWQgYW5kIHJlLXVzZWQgYnkgY29ubmVjdGlvbi5cbiAgICAgKiBAcHJvcGVydHkge2Jvb2xlYW59IFtvcHRpb25zLnJvd3NBc0FycmF5XSAtIFRvIHJlY2VpdmUgcm93cyBhcyBhcnJheSBvZiBjb2x1bW5zIGluc3RlYWQgb2YgaGFzaCB3aXRoIGNvbHVtbiBuYW1lIGFzIGtleS5cbiAgICAgKiBAcHJvcGVydHkge015U1FMQ29ubmVjdGlvbn0gW29wdGlvbnMuY29ubmVjdGlvbl0gLSBFeGlzdGluZyBjb25uZWN0aW9uLlxuICAgICAqL1xuICAgIGFzeW5jIGV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKSB7ICAgICAgICBcbiAgICAgICAgbGV0IGNvbm47XG5cbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIGNvbm4gPSBhd2FpdCB0aGlzLl9nZXRDb25uZWN0aW9uXyhvcHRpb25zKTtcblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy51c2VQcmVwYXJlZFN0YXRlbWVudCB8fCAob3B0aW9ucyAmJiBvcHRpb25zLnVzZVByZXBhcmVkU3RhdGVtZW50KSkge1xuICAgICAgICAgICAgICAgIGlmICh0aGlzLm9wdGlvbnMubG9nU1FMU3RhdGVtZW50KSB7XG4gICAgICAgICAgICAgICAgICAgIHRoaXMubG9nKCd2ZXJib3NlJywgY29ubi5mb3JtYXQoc3FsLCBwYXJhbXMpKTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBpZiAob3B0aW9ucyAmJiBvcHRpb25zLnJvd3NBc0FycmF5KSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBhd2FpdCBjb25uLmV4ZWN1dGUoeyBzcWwsIHJvd3NBc0FycmF5OiB0cnVlIH0sIHBhcmFtcyk7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgbGV0IFsgcm93czEgXSA9IGF3YWl0IGNvbm4uZXhlY3V0ZShzcWwsIHBhcmFtcyk7ICAgICAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiByb3dzMTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKHRoaXMub3B0aW9ucy5sb2dTUUxTdGF0ZW1lbnQpIHtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygndmVyYm9zZScsIGNvbm4uZm9ybWF0KHNxbCwgcGFyYW1zKSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlmIChvcHRpb25zICYmIG9wdGlvbnMucm93c0FzQXJyYXkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gYXdhaXQgY29ubi5xdWVyeSh7IHNxbCwgcm93c0FzQXJyYXk6IHRydWUgfSwgcGFyYW1zKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgXG5cbiAgICAgICAgICAgIGxldCBbIHJvd3MyIF0gPSBhd2FpdCBjb25uLnF1ZXJ5KHNxbCwgcGFyYW1zKTsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gcm93czI7XG4gICAgICAgIH0gY2F0Y2ggKGVycikgeyAgICAgIFxuICAgICAgICAgICAgZXJyLmV4dHJhSW5mbyB8fCAoZXJyLmV4dHJhSW5mbyA9IHt9KTtcbiAgICAgICAgICAgIGVyci5leHRyYUluZm8uc3FsID0gXy50cnVuY2F0ZShzcWwsIHsgbGVuZ3RoOiAyMDAgfSk7XG4gICAgICAgICAgICBlcnIuZXh0cmFJbmZvLnBhcmFtcyA9IHBhcmFtcztcblxuICAgICAgICAgICAgdGhyb3cgZXJyO1xuICAgICAgICB9IGZpbmFsbHkge1xuICAgICAgICAgICAgY29ubiAmJiBhd2FpdCB0aGlzLl9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBhc3luYyBwaW5nXygpIHtcbiAgICAgICAgbGV0IFsgcGluZyBdID0gYXdhaXQgdGhpcy5leGVjdXRlXygnU0VMRUNUIDEgQVMgcmVzdWx0Jyk7XG4gICAgICAgIHJldHVybiBwaW5nICYmIHBpbmcucmVzdWx0ID09PSAxO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIENyZWF0ZSBhIG5ldyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBjcmVhdGVfKG1vZGVsLCBkYXRhLCBvcHRpb25zKSB7XG4gICAgICAgIGlmICghZGF0YSB8fCBfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBPb2xvbmdVc2FnZUVycm9yKGBDcmVhdGluZyB3aXRoIGVtcHR5IFwiJHttb2RlbH1cIiBkYXRhLmApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdJTlNFUlQgSU5UTyA/PyBTRVQgPyc7XG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsIF07XG4gICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBvcHRpb25zKTsgXG4gICAgfVxuXG4gICAgaW5zZXJ0T25lXyA9IHRoaXMuY3JlYXRlXztcblxuICAgIC8qKlxuICAgICAqIFVwZGF0ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gcXVlcnkgXG4gICAgICogQHBhcmFtIHsqfSBxdWVyeU9wdGlvbnMgIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgdXBkYXRlXyhtb2RlbCwgZGF0YSwgcXVlcnksIHF1ZXJ5T3B0aW9ucywgY29ubk9wdGlvbnMpIHsgICAgXG4gICAgICAgIGlmIChfLmlzRW1wdHkoZGF0YSkpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBCdXNpbmVzc0Vycm9yKCdFbXB0eSBkYXRhIHRvIHVwZGF0ZS4nKTtcbiAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgXG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucyAmJiBxdWVyeU9wdGlvbnMuJHJlbGF0aW9uc2hpcHMpIHsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICBqb2luaW5ncyA9IHRoaXMuX2pvaW5Bc3NvY2lhdGlvbnMocXVlcnlPcHRpb25zLiRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNxbCA9ICdVUERBVEUgJyArIG15c3FsLmVzY2FwZUlkKG1vZGVsKTtcblxuICAgICAgICBpZiAoaGFzSm9pbmluZykge1xuICAgICAgICAgICAgam9pbmluZ1BhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpO1xuICAgICAgICAgICAgc3FsICs9ICcgQSAnICsgam9pbmluZ3Muam9pbignICcpO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHF1ZXJ5T3B0aW9ucy4kcmVxdWlyZVNwbGl0Q29sdW1ucykge1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUICcgKyB0aGlzLl9zcGxpdENvbHVtbnNBc0lucHV0KGRhdGEsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApLmpvaW4oJywnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKGRhdGEpO1xuICAgICAgICAgICAgc3FsICs9ICcgU0VUID8nO1xuICAgICAgICB9ICAgICAgICBcblxuICAgICAgICBpZiAocXVlcnkpIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24ocXVlcnksIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApOyAgIFxuICAgICAgICAgICAgaWYgKHdoZXJlQ2xhdXNlKSB7XG4gICAgICAgICAgICAgICAgc3FsICs9ICcgV0hFUkUgJyArIHdoZXJlQ2xhdXNlOyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIHJldHVybiB0aGlzLmV4ZWN1dGVfKHNxbCwgcGFyYW1zLCBjb25uT3B0aW9ucyk7XG4gICAgfVxuXG4gICAgdXBkYXRlT25lXyA9IHRoaXMudXBkYXRlXztcblxuICAgIC8qKlxuICAgICAqIFJlcGxhY2UgYW4gZXhpc3RpbmcgZW50aXR5IG9yIGNyZWF0ZSBhIG5ldyBvbmUuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBkYXRhIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyByZXBsYWNlXyhtb2RlbCwgZGF0YSwgb3B0aW9ucykgeyAgICAgICAgXG4gICAgICAgIGxldCBwYXJhbXMgPSBbIG1vZGVsLCBkYXRhIF07IFxuXG4gICAgICAgIGxldCBzcWwgPSAnUkVQTEFDRSA/PyBTRVQgPyc7XG5cbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFJlbW92ZSBhbiBleGlzdGluZyBlbnRpdHkuXG4gICAgICogQHBhcmFtIHtzdHJpbmd9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gb3B0aW9ucyBcbiAgICAgKi9cbiAgICBhc3luYyBkZWxldGVfKG1vZGVsLCBjb25kaXRpb24sIG9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFsgbW9kZWwgXTtcblxuICAgICAgICBsZXQgd2hlcmVDbGF1c2UgPSB0aGlzLl9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zKTsgICAgICAgIFxuXG4gICAgICAgIGxldCBzcWwgPSAnREVMRVRFIEZST00gPz8gV0hFUkUgJyArIHdoZXJlQ2xhdXNlO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHRoaXMuZXhlY3V0ZV8oc3FsLCBwYXJhbXMsIG9wdGlvbnMpO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFBlcmZvcm0gc2VsZWN0IG9wZXJhdGlvbi5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uIFxuICAgICAqIEBwYXJhbSB7Kn0gY29ubk9wdGlvbnMgXG4gICAgICovXG4gICAgYXN5bmMgZmluZF8obW9kZWwsIGNvbmRpdGlvbiwgY29ubk9wdGlvbnMpIHtcbiAgICAgICAgbGV0IHNxbEluZm8gPSB0aGlzLmJ1aWxkUXVlcnkobW9kZWwsIGNvbmRpdGlvbik7XG5cbiAgICAgICAgbGV0IHJlc3VsdCwgdG90YWxDb3VudDtcblxuICAgICAgICBpZiAoc3FsSW5mby5jb3VudFNxbCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgbGV0IFsgY291bnRSZXN1bHQgXSA9IGF3YWl0IHRoaXMuZXhlY3V0ZV8oc3FsSW5mby5jb3VudFNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgICAgICAgICAgICAgIFxuICAgICAgICAgICAgdG90YWxDb3VudCA9IGNvdW50UmVzdWx0Wydjb3VudCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKHNxbEluZm8uaGFzSm9pbmluZykge1xuICAgICAgICAgICAgY29ubk9wdGlvbnMgPSB7IC4uLmNvbm5PcHRpb25zLCByb3dzQXNBcnJheTogdHJ1ZSB9O1xuICAgICAgICAgICAgcmVzdWx0ID0gYXdhaXQgdGhpcy5leGVjdXRlXyhzcWxJbmZvLnNxbCwgc3FsSW5mby5wYXJhbXMsIGNvbm5PcHRpb25zKTsgIFxuICAgICAgICAgICAgbGV0IHJldmVyc2VBbGlhc01hcCA9IF8ucmVkdWNlKHNxbEluZm8uYWxpYXNNYXAsIChyZXN1bHQsIGFsaWFzLCBub2RlUGF0aCkgPT4ge1xuICAgICAgICAgICAgICAgIHJlc3VsdFthbGlhc10gPSBub2RlUGF0aC5zcGxpdCgnLicpLnNsaWNlKDEpLm1hcChuID0+ICc6JyArIG4pO1xuICAgICAgICAgICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgICAgICAgICB9LCB7fSk7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwLCB0b3RhbENvdW50KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIHJlc3VsdC5jb25jYXQocmV2ZXJzZUFsaWFzTWFwKTtcbiAgICAgICAgfSBcblxuICAgICAgICByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVfKHNxbEluZm8uc3FsLCBzcWxJbmZvLnBhcmFtcywgY29ubk9wdGlvbnMpO1xuXG4gICAgICAgIGlmIChzcWxJbmZvLmNvdW50U3FsKSB7XG4gICAgICAgICAgICByZXR1cm4gWyByZXN1bHQsIHRvdGFsQ291bnQgXTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiByZXN1bHQ7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogQnVpbGQgc3FsIHN0YXRlbWVudC5cbiAgICAgKiBAcGFyYW0geyp9IG1vZGVsIFxuICAgICAqIEBwYXJhbSB7Kn0gY29uZGl0aW9uICAgICAgXG4gICAgICovXG4gICAgYnVpbGRRdWVyeShtb2RlbCwgeyAkcmVsYXRpb25zaGlwcywgJHByb2plY3Rpb24sICRxdWVyeSwgJGdyb3VwQnksICRvcmRlckJ5LCAkb2Zmc2V0LCAkbGltaXQsICR0b3RhbENvdW50IH0pIHtcbiAgICAgICAgbGV0IHBhcmFtcyA9IFtdLCBhbGlhc01hcCA9IHsgW21vZGVsXTogJ0EnIH0sIGpvaW5pbmdzLCBoYXNKb2luaW5nID0gZmFsc2UsIGpvaW5pbmdQYXJhbXMgPSBbXTsgICAgICAgIFxuXG4gICAgICAgIC8vIGJ1aWxkIGFsaWFzIG1hcCBmaXJzdFxuICAgICAgICAvLyBjYWNoZSBwYXJhbXNcbiAgICAgICAgaWYgKCRyZWxhdGlvbnNoaXBzKSB7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgam9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKCRyZWxhdGlvbnNoaXBzLCBtb2RlbCwgJ0EnLCBhbGlhc01hcCwgMSwgam9pbmluZ1BhcmFtcyk7ICAgICAgICAgICAgIFxuICAgICAgICAgICAgaGFzSm9pbmluZyA9IG1vZGVsO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IHNlbGVjdENvbG9tbnMgPSAkcHJvamVjdGlvbiA/IHRoaXMuX2J1aWxkQ29sdW1ucygkcHJvamVjdGlvbiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgOiAnKic7XG5cbiAgICAgICAgbGV0IHNxbCA9ICcgRlJPTSAnICsgbXlzcWwuZXNjYXBlSWQobW9kZWwpO1xuXG4gICAgICAgIC8vIG1vdmUgY2FjaGVkIGpvaW5pbmcgcGFyYW1zIGludG8gcGFyYW1zXG4gICAgICAgIC8vIHNob3VsZCBhY2NvcmRpbmcgdG8gdGhlIHBsYWNlIG9mIGNsYXVzZSBpbiBhIHNxbCAgICAgICAgXG5cbiAgICAgICAgaWYgKGhhc0pvaW5pbmcpIHtcbiAgICAgICAgICAgIGpvaW5pbmdQYXJhbXMuZm9yRWFjaChwID0+IHBhcmFtcy5wdXNoKHApKTtcbiAgICAgICAgICAgIHNxbCArPSAnIEEgJyArIGpvaW5pbmdzLmpvaW4oJyAnKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICgkcXVlcnkpIHtcbiAgICAgICAgICAgIGxldCB3aGVyZUNsYXVzZSA9IHRoaXMuX2pvaW5Db25kaXRpb24oJHF1ZXJ5LCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTsgICBcbiAgICAgICAgICAgIGlmICh3aGVyZUNsYXVzZSkge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIFdIRVJFICcgKyB3aGVyZUNsYXVzZTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICB9ICAgIFxuXG4gICAgICAgIGlmICgkZ3JvdXBCeSkge1xuICAgICAgICAgICAgc3FsICs9ICcgJyArIHRoaXMuX2J1aWxkR3JvdXBCeSgkZ3JvdXBCeSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoJG9yZGVyQnkpIHtcbiAgICAgICAgICAgIHNxbCArPSAnICcgKyB0aGlzLl9idWlsZE9yZGVyQnkoJG9yZGVyQnksIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGxldCByZXN1bHQgPSB7IHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAgfTsgICAgICAgIFxuXG4gICAgICAgIGlmICgkdG90YWxDb3VudCkge1xuICAgICAgICAgICAgbGV0IGNvdW50U3ViamVjdDtcblxuICAgICAgICAgICAgaWYgKHR5cGVvZiAkdG90YWxDb3VudCA9PT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICBjb3VudFN1YmplY3QgPSAnRElTVElOQ1QoJyArIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKCR0b3RhbENvdW50LCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIGNvdW50U3ViamVjdCA9ICcqJztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgcmVzdWx0LmNvdW50U3FsID0gYFNFTEVDVCBDT1VOVCgke2NvdW50U3ViamVjdH0pIEFTIGNvdW50YCArIHNxbDtcbiAgICAgICAgfVxuXG4gICAgICAgIHNxbCA9ICdTRUxFQ1QgJyArIHNlbGVjdENvbG9tbnMgKyBzcWw7ICAgICAgICBcblxuICAgICAgICBpZiAoXy5pc0ludGVnZXIoJGxpbWl0KSAmJiAkbGltaXQgPiAwKSB7XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChfLmlzSW50ZWdlcigkb2Zmc2V0KSAmJiAkb2Zmc2V0ID4gMCkgeyAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRvZmZzZXQpO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8nO1xuICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKCRsaW1pdCk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgXG4gICAgICAgIH0gZWxzZSBpZiAoXy5pc0ludGVnZXIoJG9mZnNldCkgJiYgJG9mZnNldCA+IDApIHsgICAgICAgICAgICBcbiAgICAgICAgICAgIHNxbCArPSAnIExJTUlUID8sIDEwMDAnO1xuICAgICAgICAgICAgcGFyYW1zLnB1c2goJG9mZnNldCk7XG4gICAgICAgIH1cblxuICAgICAgICByZXN1bHQuc3FsID0gc3FsO1xuXG4gICAgICAgIC8vY29uc29sZS5kaXIocmVzdWx0LCB7IGRlcHRoOiAxMCwgY29sb3JzOiB0cnVlIH0pO1xuICAgICAgICBcbiAgICAgICAgcmV0dXJuIHJlc3VsdDtcbiAgICB9XG5cbiAgICBnZXRJbnNlcnRlZElkKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuaW5zZXJ0SWQgPT09ICdudW1iZXInID9cbiAgICAgICAgICAgIHJlc3VsdC5pbnNlcnRJZCA6IFxuICAgICAgICAgICAgdW5kZWZpbmVkO1xuICAgIH1cblxuICAgIGdldE51bU9mQWZmZWN0ZWRSb3dzKHJlc3VsdCkge1xuICAgICAgICByZXR1cm4gcmVzdWx0ICYmIHR5cGVvZiByZXN1bHQuYWZmZWN0ZWRSb3dzID09PSAnbnVtYmVyJyA/XG4gICAgICAgICAgICByZXN1bHQuYWZmZWN0ZWRSb3dzIDogXG4gICAgICAgICAgICB1bmRlZmluZWQ7XG4gICAgfVxuXG4gICAgX2dlbmVyYXRlQWxpYXMoaW5kZXgsIGFuY2hvcikge1xuICAgICAgICBsZXQgYWxpYXMgPSBudG9sKGluZGV4KTtcblxuICAgICAgICBpZiAodGhpcy5vcHRpb25zLnZlcmJvc2VBbGlhcykge1xuICAgICAgICAgICAgcmV0dXJuIF8uc25ha2VDYXNlKGFuY2hvcikudG9VcHBlckNhc2UoKSArICdfJyArIGFsaWFzO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIEV4dHJhY3QgYXNzb2NpYXRpb25zIGludG8gam9pbmluZyBjbGF1c2VzLlxuICAgICAqICB7XG4gICAgICogICAgICBlbnRpdHk6IDxyZW1vdGUgZW50aXR5PlxuICAgICAqICAgICAgam9pblR5cGU6ICdMRUZUIEpPSU58SU5ORVIgSk9JTnxGVUxMIE9VVEVSIEpPSU4nXG4gICAgICogICAgICBhbmNob3I6ICdsb2NhbCBwcm9wZXJ0eSB0byBwbGFjZSB0aGUgcmVtb3RlIGVudGl0eSdcbiAgICAgKiAgICAgIGxvY2FsRmllbGQ6IDxsb2NhbCBmaWVsZCB0byBqb2luPlxuICAgICAqICAgICAgcmVtb3RlRmllbGQ6IDxyZW1vdGUgZmllbGQgdG8gam9pbj5cbiAgICAgKiAgICAgIHN1YkFzc29jaWF0aW9uczogeyAuLi4gfVxuICAgICAqICB9XG4gICAgICogXG4gICAgICogQHBhcmFtIHsqfSBhc3NvY2lhdGlvbnMgXG4gICAgICogQHBhcmFtIHsqfSBwYXJlbnRBbGlhc0tleSBcbiAgICAgKiBAcGFyYW0geyp9IHBhcmVudEFsaWFzIFxuICAgICAqIEBwYXJhbSB7Kn0gYWxpYXNNYXAgXG4gICAgICogQHBhcmFtIHsqfSBwYXJhbXMgXG4gICAgICovXG4gICAgX2pvaW5Bc3NvY2lhdGlvbnMoYXNzb2NpYXRpb25zLCBwYXJlbnRBbGlhc0tleSwgcGFyZW50QWxpYXMsIGFsaWFzTWFwLCBzdGFydElkLCBwYXJhbXMpIHtcbiAgICAgICAgbGV0IGpvaW5pbmdzID0gW107XG5cbiAgICAgICAgLy9jb25zb2xlLmxvZygnYXNzb2NpYXRpb25zOicsIE9iamVjdC5rZXlzKGFzc29jaWF0aW9ucykpO1xuXG4gICAgICAgIF8uZWFjaChhc3NvY2lhdGlvbnMsIChhc3NvY0luZm8sIGFuY2hvcikgPT4geyBcbiAgICAgICAgICAgIGxldCBhbGlhcyA9IGFzc29jSW5mby5hbGlhcyB8fCB0aGlzLl9nZW5lcmF0ZUFsaWFzKHN0YXJ0SWQrKywgYW5jaG9yKTsgXG4gICAgICAgICAgICBsZXQgeyBqb2luVHlwZSwgb24gfSA9IGFzc29jSW5mbztcblxuICAgICAgICAgICAgam9pblR5cGUgfHwgKGpvaW5UeXBlID0gJ0xFRlQgSk9JTicpO1xuXG4gICAgICAgICAgICBpZiAoYXNzb2NJbmZvLnNxbCkge1xuICAgICAgICAgICAgICAgIGlmIChhc3NvY0luZm8ub3V0cHV0KSB7ICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgYWxpYXNNYXBbcGFyZW50QWxpYXNLZXkgKyAnLicgKyBhbGlhc10gPSBhbGlhczsgXG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgYXNzb2NJbmZvLnBhcmFtcy5mb3JFYWNoKHAgPT4gcGFyYW1zLnB1c2gocCkpOyBcbiAgICAgICAgICAgICAgICBqb2luaW5ncy5wdXNoKGAke2pvaW5UeXBlfSAoJHthc3NvY0luZm8uc3FsfSkgJHthbGlhc30gT04gJHt0aGlzLl9qb2luQ29uZGl0aW9uKG9uLCBwYXJhbXMsIG51bGwsIHBhcmVudEFsaWFzS2V5LCBhbGlhc01hcCl9YCk7ICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICByZXR1cm47XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGxldCB7IGVudGl0eSwgc3ViQXNzb2NzIH0gPSBhc3NvY0luZm87ICAgICAgICAgICAgXG4gICAgICAgICAgICBsZXQgYWxpYXNLZXkgPSBwYXJlbnRBbGlhc0tleSArICcuJyArIGFuY2hvcjtcbiAgICAgICAgICAgIGFsaWFzTWFwW2FsaWFzS2V5XSA9IGFsaWFzOyBcblxuICAgICAgICAgICAgam9pbmluZ3MucHVzaChgJHtqb2luVHlwZX0gJHtteXNxbC5lc2NhcGVJZChlbnRpdHkpfSAke2FsaWFzfSBPTiAke3RoaXMuX2pvaW5Db25kaXRpb24ob24sIHBhcmFtcywgbnVsbCwgcGFyZW50QWxpYXNLZXksIGFsaWFzTWFwKX1gKTtcbiAgICAgICAgICAgIFxuICAgICAgICAgICAgaWYgKHN1YkFzc29jcykgeyAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICBsZXQgc3ViSm9pbmluZ3MgPSB0aGlzLl9qb2luQXNzb2NpYXRpb25zKHN1YkFzc29jcywgYWxpYXNLZXksIGFsaWFzLCBhbGlhc01hcCwgc3RhcnRJZCwgcGFyYW1zKTtcbiAgICAgICAgICAgICAgICBzdGFydElkICs9IHN1YkpvaW5pbmdzLmxlbmd0aDtcbiAgICAgICAgICAgICAgICBqb2luaW5ncyA9IGpvaW5pbmdzLmNvbmNhdChzdWJKb2luaW5ncyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIHJldHVybiBqb2luaW5ncztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBTUUwgY29uZGl0aW9uIHJlcHJlc2VudGF0aW9uXG4gICAgICogICBSdWxlczpcbiAgICAgKiAgICAgZGVmYXVsdDogXG4gICAgICogICAgICAgIGFycmF5OiBPUlxuICAgICAqICAgICAgICBrdi1wYWlyOiBBTkRcbiAgICAgKiAgICAgJGFsbDogXG4gICAgICogICAgICAgIGFycmF5OiBBTkRcbiAgICAgKiAgICAgJGFueTpcbiAgICAgKiAgICAgICAga3YtcGFpcjogT1JcbiAgICAgKiAgICAgJG5vdDpcbiAgICAgKiAgICAgICAgYXJyYXk6IG5vdCAoIG9yIClcbiAgICAgKiAgICAgICAga3YtcGFpcjogbm90ICggYW5kICkgICAgIFxuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBjb25kaXRpb24gXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zIFxuICAgICAqL1xuICAgIF9qb2luQ29uZGl0aW9uKGNvbmRpdGlvbiwgcGFyYW1zLCBqb2luT3BlcmF0b3IsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGNvbmRpdGlvbikpIHtcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ09SJztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBjb25kaXRpb24ubWFwKGMgPT4gJygnICsgdGhpcy5fam9pbkNvbmRpdGlvbihjLCBwYXJhbXMsIG51bGwsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcpJykuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29uZGl0aW9uKSkgeyBcbiAgICAgICAgICAgIGlmICgham9pbk9wZXJhdG9yKSB7XG4gICAgICAgICAgICAgICAgam9pbk9wZXJhdG9yID0gJ0FORCc7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBcbiAgICAgICAgICAgIHJldHVybiBfLm1hcChjb25kaXRpb24sICh2YWx1ZSwga2V5KSA9PiB7XG4gICAgICAgICAgICAgICAgaWYgKGtleSA9PT0gJyRhbGwnIHx8IGtleSA9PT0gJyRhbmQnKSB7XG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogQXJyYXkuaXNBcnJheSh2YWx1ZSkgfHwgXy5pc1BsYWluT2JqZWN0KHZhbHVlKSwgJ1wiJGFuZFwiIG9wZXJhdG9yIHZhbHVlIHNob3VsZCBiZSBhbiBhcnJheSBvciBwbGFpbiBvYmplY3QuJzsgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnKCcgKyB0aGlzLl9qb2luQ29uZGl0aW9uKHZhbHVlLCBwYXJhbXMsICdBTkQnLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnKSc7XG4gICAgICAgICAgICAgICAgfVxuICAgIFxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckYW55JyB8fCBrZXkgPT09ICckb3InIHx8IGtleS5zdGFydHNXaXRoKCckb3JfJykpIHtcbiAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBBcnJheS5pc0FycmF5KHZhbHVlKSB8fCBfLmlzUGxhaW5PYmplY3QodmFsdWUpLCAnXCIkb3JcIiBvcGVyYXRvciB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgb3IgcGxhaW4gb2JqZWN0Lic7ICAgICAgIFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICcoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgJ09SJywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIGlmIChrZXkgPT09ICckbm90JykgeyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChBcnJheS5pc0FycmF5KHZhbHVlKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiB2YWx1ZS5sZW5ndGggPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKF8uaXNQbGFpbk9iamVjdCh2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxldCBudW1PZkVsZW1lbnQgPSBPYmplY3Qua2V5cyh2YWx1ZSkubGVuZ3RoOyAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiBudW1PZkVsZW1lbnQgPiAwLCAnXCIkbm90XCIgb3BlcmF0b3IgdmFsdWUgc2hvdWxkIGJlIG5vbi1lbXB0eS4nOyAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gJ05PVCAoJyArIHRoaXMuX2pvaW5Db25kaXRpb24odmFsdWUsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyknO1xuICAgICAgICAgICAgICAgICAgICB9IFxuXG4gICAgICAgICAgICAgICAgICAgIGFzc2VydDogdHlwZW9mIHZhbHVlID09PSAnc3RyaW5nJywgJ1Vuc3VwcG9ydGVkIGNvbmRpdGlvbiEnO1xuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiAnTk9UICgnICsgY29uZGl0aW9uICsgJyknOyAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgfSAgICAgICAgICAgICAgICBcblxuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl93cmFwQ29uZGl0aW9uKGtleSwgdmFsdWUsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgfSkuam9pbihgICR7am9pbk9wZXJhdG9yfSBgKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29uZGl0aW9uICE9PSAnc3RyaW5nJykge1xuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdVbnN1cHBvcnRlZCBjb25kaXRpb24hXFxuIFZhbHVlOiAnICsgSlNPTi5zdHJpbmdpZnkoY29uZGl0aW9uKSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gY29uZGl0aW9uO1xuICAgIH1cblxuICAgIF9yZXBsYWNlRmllbGROYW1lV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHtcbiAgICAgICAgbGV0IHBhcnRzID0gZmllbGROYW1lLnNwbGl0KCcuJyk7XG4gICAgICAgIGlmIChwYXJ0cy5sZW5ndGggPiAxKSB7XG4gICAgICAgICAgICBsZXQgYWN0dWFsRmllbGROYW1lID0gcGFydHMucG9wKCk7XG4gICAgICAgICAgICBsZXQgYWxpYXMgPSBhbGlhc01hcFttYWluRW50aXR5ICsgJy4nICsgcGFydHMuam9pbignLicpXTtcbiAgICAgICAgICAgIGlmICghYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBsZXQgbXNnID0gYFVua25vd24gY29sdW1uIHJlZmVyZW5jZTogJHtmaWVsZE5hbWV9YDtcbiAgICAgICAgICAgICAgICB0aGlzLmxvZygnZGVidWcnLCBtc2csIGFsaWFzTWFwKTtcbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgQnVzaW5lc3NFcnJvcihtc2cpO1xuICAgICAgICAgICAgfSAgICAgICAgICAgIFxuXG4gICAgICAgICAgICByZXR1cm4gYWxpYXMgKyAnLicgKyBteXNxbC5lc2NhcGVJZChhY3R1YWxGaWVsZE5hbWUpO1xuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGFsaWFzTWFwW21haW5FbnRpdHldICsgJy4nICsgKGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSk7XG4gICAgfVxuXG4gICAgX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgbWFpbkVudGl0eSwgYWxpYXNNYXApIHsgICBcblxuICAgICAgICBpZiAobWFpbkVudGl0eSkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuX3JlcGxhY2VGaWVsZE5hbWVXaXRoQWxpYXMoZmllbGROYW1lLCBtYWluRW50aXR5LCBhbGlhc01hcCk7IFxuICAgICAgICB9XG5cbiAgICAgICAgcmV0dXJuIGZpZWxkTmFtZSA9PT0gJyonID8gZmllbGROYW1lIDogbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKTtcbiAgICB9XG5cbiAgICBfc3BsaXRDb2x1bW5zQXNJbnB1dChkYXRhLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIHJldHVybiBfLm1hcChkYXRhLCAodiwgZmllbGROYW1lKSA9PiB7XG4gICAgICAgICAgICBhc3NlcnQ6IGZpZWxkTmFtZS5pbmRleE9mKCcuJykgPT09IC0xLCAnQ29sdW1uIG9mIGRpcmVjdCBpbnB1dCBkYXRhIGNhbm5vdCBiZSBhIGRvdC1zZXBhcmF0ZWQgbmFtZS4nO1xuICAgICAgICAgICAgXG4gICAgICAgICAgICByZXR1cm4gbXlzcWwuZXNjYXBlSWQoZmllbGROYW1lKSArICc9JyArIHRoaXMuX3BhY2tWYWx1ZSh2LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfSk7XG4gICAgfVxuXG4gICAgX3BhY2tBcnJheShhcnJheSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkge1xuICAgICAgICByZXR1cm4gYXJyYXkubWFwKHZhbHVlID0+IHRoaXMuX3BhY2tWYWx1ZSh2YWx1ZSwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCkpLmpvaW4oJywnKTtcbiAgICB9XG5cbiAgICBfcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSB7XG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHN3aXRjaCAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgICAgICBjYXNlICdDb2x1bW5SZWZlcmVuY2UnOlxuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKHZhbHVlLm5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcblxuICAgICAgICAgICAgICAgICAgICBjYXNlICdGdW5jdGlvbic6XG4gICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUubmFtZSArICcoJyArICh2YWx1ZS5hcmdzID8gdGhpcy5fcGFja0FycmF5KHZhbHVlLmFyZ3MsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIDogJycpICsgJyknO1xuXG4gICAgICAgICAgICAgICAgICAgIGNhc2UgJ0JpbmFyeUV4cHJlc3Npb24nOlxuICAgICAgICAgICAgICAgICAgICAgICAgbGV0IGxlZnQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUubGVmdCwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBsZXQgcmlnaHQgPSB0aGlzLl9wYWNrVmFsdWUodmFsdWUucmlnaHQsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGxlZnQgKyBgICR7dmFsdWUub3B9IGAgKyByaWdodDtcblxuICAgICAgICAgICAgICAgICAgICBkZWZhdWx0OlxuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKGBVbmtub3duIG9vciB0eXBlOiAke3ZhbHVlLm9vclR5cGV9YCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICB2YWx1ZSA9IEpTT04uc3RyaW5naWZ5KHZhbHVlKTtcbiAgICAgICAgfVxuXG4gICAgICAgIHBhcmFtcy5wdXNoKHZhbHVlKTtcbiAgICAgICAgcmV0dXJuICc/JztcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBXcmFwIGEgY29uZGl0aW9uIGNsYXVzZSAgICAgXG4gICAgICogXG4gICAgICogVmFsdWUgY2FuIGJlIGEgbGl0ZXJhbCBvciBhIHBsYWluIGNvbmRpdGlvbiBvYmplY3QuXG4gICAgICogICAxLiBmaWVsZE5hbWUsIDxsaXRlcmFsPlxuICAgICAqICAgMi4gZmllbGROYW1lLCB7IG5vcm1hbCBvYmplY3QgfSBcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZmllbGROYW1lIFxuICAgICAqIEBwYXJhbSB7Kn0gdmFsdWUgXG4gICAgICogQHBhcmFtIHthcnJheX0gcGFyYW1zICBcbiAgICAgKi9cbiAgICBfd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpIHtcbiAgICAgICAgaWYgKF8uaXNOaWwodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIElTIE5VTEwnO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkodmFsdWUpKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHsgJGluOiB2YWx1ZSB9LCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwLCBpbmplY3QpO1xuICAgICAgICB9ICAgICAgIFxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QodmFsdWUpKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUub29yVHlwZSkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSAnICsgdGhpcy5fcGFja1ZhbHVlKHZhbHVlLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgbGV0IGhhc09wZXJhdG9yID0gXy5maW5kKE9iamVjdC5rZXlzKHZhbHVlKSwgayA9PiBrICYmIGtbMF0gPT09ICckJyk7XG5cbiAgICAgICAgICAgIGlmIChoYXNPcGVyYXRvcikge1xuICAgICAgICAgICAgICAgIHJldHVybiBfLm1hcCh2YWx1ZSwgKHYsIGspID0+IHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGsgJiYga1swXSA9PT0gJyQnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBvcGVyYXRvclxuICAgICAgICAgICAgICAgICAgICAgICAgc3dpdGNoIChrKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZXF1YWwnOlxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fd3JhcENvbmRpdGlvbihmaWVsZE5hbWUsIHYsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXAsIGluamVjdCk7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJG5lJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbmVxJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbm90RXF1YWwnOiAgICAgICAgIFxuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc05pbCh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJUyBOT1QgTlVMTCc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0gICAgICAgICAgXG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNQcmltaXRpdmUodikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIDw+ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD4gPyc7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdOT1QgKCcgKyB0aGlzLl93cmFwQ29uZGl0aW9uKGZpZWxkTmFtZSwgdiwgcGFyYW1zLCBoYXNKb2luaW5nLCBhbGlhc01hcCwgdHJ1ZSkgKyAnKSc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJD4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRndCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGd0XCIgb3IgXCIkPlwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gJyArIHY7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID4gPyc7XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ+PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGd0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGdyZWF0ZXJUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRndGVcIiBvciBcIiQ+PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA+PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPj0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJDwnOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsdCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFfLmlzRmluaXRlKHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB2ID0gXy50b0Zpbml0ZSh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc05hTih2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT25seSBmaW5pdGUgbnVtYmVycyBjYW4gdXNlIFwiJGx0XCIgb3IgXCIkPFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ICcgKyB2O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8ID8nO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyQ8PSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGx0ZSc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGxlc3NUaGFuT3JFcXVhbCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0Zpbml0ZSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdiA9IF8udG9GaW5pdGUodik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNOYU4odikpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ09ubHkgZmluaXRlIG51bWJlcnMgY2FuIHVzZSBcIiRsdGVcIiBvciBcIiQ8PVwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyA8PSAnICsgdjtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2godik7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPD0gPyc7XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGluJzpcbiAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KHYpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYW4gYXJyYXkgd2hlbiB1c2luZyBcIiRpblwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGluamVjdCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgYCBJTiAoJHt2fSlgO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaCh2KTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2VzY2FwZUlkV2l0aEFsaWFzKGZpZWxkTmFtZSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBJTiAoPyknO1xuICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRuaW4nOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRub3RJbic6XG4gICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghQXJyYXkuaXNBcnJheSh2KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdUaGUgdmFsdWUgc2hvdWxkIGJlIGFuIGFycmF5IHdoZW4gdXNpbmcgXCIkaW5cIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpbmplY3QpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArIGAgTk9UIElOICgke3Z9KWA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKHYpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIE5PVCBJTiAoPyknO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0V2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJHN0YXJ0c1dpdGgnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJHN0YXJ0V2l0aFwiIG9wZXJhdG9yLicpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXNzZXJ0OiAhaW5qZWN0O1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHBhcmFtcy5wdXNoKGAke3Z9JWApO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnIExJS0UgPyc7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckZW5kV2l0aCc6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FzZSAnJGVuZHNXaXRoJzpcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAodHlwZW9mIHYgIT09ICdzdHJpbmcnKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1RoZSB2YWx1ZSBzaG91bGQgYmUgYSBzdHJpbmcgd2hlbiB1c2luZyBcIiRlbmRXaXRoXCIgb3BlcmF0b3IuJyk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcGFyYW1zLnB1c2goYCUke3Z9YCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhc2UgJyRsaWtlJzpcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckbGlrZXMnOlxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICh0eXBlb2YgdiAhPT0gJ3N0cmluZycpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignVGhlIHZhbHVlIHNob3VsZCBiZSBhIHN0cmluZyB3aGVuIHVzaW5nIFwiJGxpa2VcIiBvcGVyYXRvci4nKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFzc2VydDogIWluamVjdDtcblxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwYXJhbXMucHVzaChgJSR7dn0lYCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgTElLRSA/JztcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLypcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYXNlICckYXBwbHknOlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBsZXQgYXJncyA9IHZhbHVlLmFyZ3MgPyBbIGZpZWxkTmFtZSBdLmNvbmNhdCh2YWx1ZS5hcmdzKSA6IFsgZmllbGROYW1lIF07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlLm5hbWUgKyAnKCcgKyB0aGlzLl9idWlsZENvbHVtbnMoY29sLmFyZ3MsIHZhbHVlc1NlcSwgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJykgPSAnXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmF1bHQ6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgVW5zdXBwb3J0ZWQgY29uZGl0aW9uIG9wZXJhdG9yOiBcIiR7a31cIiFgKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignT3BlcmF0b3Igc2hvdWxkIG5vdCBiZSBtaXhlZCB3aXRoIGNvbmRpdGlvbiB2YWx1ZS4nKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pLmpvaW4oJyBBTkQgJyk7XG4gICAgICAgICAgICB9ICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICBhc3NlcnQ6ICFpbmplY3Q7XG5cbiAgICAgICAgICAgIHBhcmFtcy5wdXNoKEpTT04uc3RyaW5naWZ5KHZhbHVlKSk7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gPyc7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoaW5qZWN0KSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZmllbGROYW1lLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAnID0gJyArIHZhbHVlO1xuICAgICAgICB9XG4gICAgICAgIFxuICAgICAgICBwYXJhbXMucHVzaCh2YWx1ZSk7XG4gICAgICAgIHJldHVybiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhmaWVsZE5hbWUsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSArICcgPSA/JztcbiAgICB9XG5cbiAgICBfYnVpbGRDb2x1bW5zKGNvbHVtbnMsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHsgICAgICAgIFxuICAgICAgICByZXR1cm4gXy5tYXAoXy5jYXN0QXJyYXkoY29sdW1ucyksIGNvbCA9PiB0aGlzLl9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuICAgIH1cblxuICAgIF9idWlsZENvbHVtbihjb2wsIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBjb2wgPT09ICdzdHJpbmcnKSB7ICBcbiAgICAgICAgICAgIC8vaXQncyBhIHN0cmluZyBpZiBpdCdzIHF1b3RlZCB3aGVuIHBhc3NlZCBpbiAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgcmV0dXJuIGlzUXVvdGVkKGNvbCkgPyBjb2wgOiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhjb2wsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmICh0eXBlb2YgY29sID09PSAnbnVtYmVyJykge1xuICAgICAgICAgICAgcmV0dXJuIGNvbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoY29sKSkgeyAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgIGlmIChjb2wuYWxpYXMpIHtcbiAgICAgICAgICAgICAgICBhc3NlcnQ6IHR5cGVvZiBjb2wuYWxpYXMgPT09ICdzdHJpbmcnO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMuX2J1aWxkQ29sdW1uKF8ub21pdChjb2wsIFsnYWxpYXMnXSksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApICsgJyBBUyAnICsgbXlzcWwuZXNjYXBlSWQoY29sLmFsaWFzKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZnVuY3Rpb24nKSB7XG4gICAgICAgICAgICAgICAgaWYgKGNvbC5uYW1lLnRvVXBwZXJDYXNlKCkgPT09ICdDT1VOVCcgJiYgY29sLmFyZ3MubGVuZ3RoID09PSAxICYmIGNvbC5hcmdzWzBdID09PSAnKicpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuICdDT1VOVCgqKSc7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIGNvbC5uYW1lICsgJygnICsgKGNvbC5hcmdzID8gdGhpcy5fYnVpbGRDb2x1bW5zKGNvbC5hcmdzLCBwYXJhbXMsIGhhc0pvaW5pbmcsIGFsaWFzTWFwKSA6ICcnKSArICcpJztcbiAgICAgICAgICAgIH0gICAgICAgICAgICBcblxuICAgICAgICAgICAgaWYgKGNvbC50eXBlID09PSAnZXhwcmVzc2lvbicpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5fam9pbkNvbmRpdGlvbihjb2wuZXhwciwgcGFyYW1zLCBudWxsLCBoYXNKb2luaW5nLCBhbGlhc01hcCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93IGNvbHVtbiBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkoY29sKX1gKTtcbiAgICB9XG5cbiAgICBfYnVpbGRHcm91cEJ5KGdyb3VwQnksIHBhcmFtcywgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBncm91cEJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdHUk9VUCBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoZ3JvdXBCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KGdyb3VwQnkpKSByZXR1cm4gJ0dST1VQIEJZICcgKyBncm91cEJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3QoZ3JvdXBCeSkpIHtcbiAgICAgICAgICAgIGxldCB7IGNvbHVtbnMsIGhhdmluZyB9ID0gZ3JvdXBCeTtcblxuICAgICAgICAgICAgaWYgKCFjb2x1bW5zIHx8ICFBcnJheS5pc0FycmF5KGNvbHVtbnMpKSB7XG4gICAgICAgICAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYEludmFsaWQgZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgICAgICAgICAgfSBcblxuICAgICAgICAgICAgbGV0IGdyb3VwQnlDbGF1c2UgPSB0aGlzLl9idWlsZEdyb3VwQnkoY29sdW1ucyk7XG4gICAgICAgICAgICBsZXQgaGF2aW5nQ2x1c2UgPSBoYXZpbmcgJiYgdGhpcy5fam9pbkNvbmRpdGlvbihoYXZpbmcsIHBhcmFtcywgbnVsbCwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuICAgICAgICAgICAgaWYgKGhhdmluZ0NsdXNlKSB7XG4gICAgICAgICAgICAgICAgZ3JvdXBCeUNsYXVzZSArPSAnIEhBVklORyAnICsgaGF2aW5nQ2x1c2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHJldHVybiBncm91cEJ5Q2xhdXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgdGhyb3cgbmV3IE9vbG9uZ1VzYWdlRXJyb3IoYFVua25vd24gZ3JvdXAgYnkgc3ludGF4OiAke0pTT04uc3RyaW5naWZ5KGdyb3VwQnkpfWApO1xuICAgIH1cblxuICAgIF9idWlsZE9yZGVyQnkob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApIHtcbiAgICAgICAgaWYgKHR5cGVvZiBvcmRlckJ5ID09PSAnc3RyaW5nJykgcmV0dXJuICdPUkRFUiBCWSAnICsgdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMob3JkZXJCeSwgaGFzSm9pbmluZywgYWxpYXNNYXApO1xuXG4gICAgICAgIGlmIChBcnJheS5pc0FycmF5KG9yZGVyQnkpKSByZXR1cm4gJ09SREVSIEJZICcgKyBvcmRlckJ5Lm1hcChieSA9PiB0aGlzLl9lc2NhcGVJZFdpdGhBbGlhcyhieSwgaGFzSm9pbmluZywgYWxpYXNNYXApKS5qb2luKCcsICcpO1xuXG4gICAgICAgIGlmIChfLmlzUGxhaW5PYmplY3Qob3JkZXJCeSkpIHtcbiAgICAgICAgICAgIHJldHVybiAnT1JERVIgQlkgJyArIF8ubWFwKG9yZGVyQnksIChhc2MsIGNvbCkgPT4gdGhpcy5fZXNjYXBlSWRXaXRoQWxpYXMoY29sLCBoYXNKb2luaW5nLCBhbGlhc01hcCkgKyAoYXNjID8gJycgOiAnIERFU0MnKSkuam9pbignLCAnKTsgXG4gICAgICAgIH1cblxuICAgICAgICB0aHJvdyBuZXcgT29sb25nVXNhZ2VFcnJvcihgVW5rbm93biBvcmRlciBieSBzeW50YXg6ICR7SlNPTi5zdHJpbmdpZnkob3JkZXJCeSl9YCk7XG4gICAgfVxuXG4gICAgYXN5bmMgX2dldENvbm5lY3Rpb25fKG9wdGlvbnMpIHtcbiAgICAgICAgcmV0dXJuIChvcHRpb25zICYmIG9wdGlvbnMuY29ubmVjdGlvbikgPyBvcHRpb25zLmNvbm5lY3Rpb24gOiB0aGlzLmNvbm5lY3RfKG9wdGlvbnMpO1xuICAgIH1cblxuICAgIGFzeW5jIF9yZWxlYXNlQ29ubmVjdGlvbl8oY29ubiwgb3B0aW9ucykge1xuICAgICAgICBpZiAoIW9wdGlvbnMgfHwgIW9wdGlvbnMuY29ubmVjdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMuZGlzY29ubmVjdF8oY29ubik7XG4gICAgICAgIH1cbiAgICB9XG59XG5cbm1vZHVsZS5leHBvcnRzID0gTXlTUUxDb25uZWN0b3I7Il19