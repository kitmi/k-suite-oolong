"use strict";

require("source-map-support/register");

const {
  URL
} = require('url');

const {
  _
} = require('rk-utils');

const {
  SupportedDrivers
} = require('../utils/lang');

class Connector {
  static createConnector(driver, connectionString, options) {
    if (SupportedDrivers.indexOf(driver) === -1) {
      throw new Error(`Unsupported connector driver: "${driver}"!`);
    }

    if (!connectionString) {
      throw new Error(`Missing required connection string`);
    }

    let ConnectorClass = require(`./drivers/${driver}/Connector`);

    return new ConnectorClass(connectionString, options);
  }

  constructor(driver, connectionString, options) {
    this.driver = driver;
    this.connectionString = connectionString;
    this.options = options || {};
  }

  getNewConnectionString(components) {
    if (!_.isPlainObject(components)) {
      throw new Error("Function  precondition failed: _.isPlainObject(components)");
    }

    let url = new URL(this.connectionString);

    if (components.hasOwnProperty('username')) {
      url.username = components['username'];
    }

    if (components.hasOwnProperty('password')) {
      url.password = components['password'];
    }

    if (components.hasOwnProperty('database')) {
      url.pathname = '/' + components['database'];
    }

    if (components.hasOwnProperty('options')) {
      let options = components.options;

      _.forOwn(options, (value, key) => {
        url.searchParams.set(key, typeof value === 'boolean' ? value ? 1 : 0 : value);
      });
    }

    return url.href;
  }

  getConnectionStringWithoutCredential() {
    let url = new URL(this.connectionString);
    url.username = '';
    url.password = '';
    return url.href;
  }

  get database() {
    if (!this._database) {
      this._database = new URL(this.connectionString).pathname.substr(1);
    }

    return this._database;
  }

  log(...args) {
    if (this.options.logger) {
      this.options.logger.log(...args);
    }
  }

  mergeWhere(filters, where) {
    if (!filters.where) {
      filters.where = _.cloneDeep(where);
    } else {
      filters.where = {
        $and: [filters.where, _.cloneDeep(where)]
      };
    }
  }

}

module.exports = Connector;
//# sourceMappingURL=data:application/json;charset=utf-8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbIi4uLy4uL3NyYy9ydW50aW1lL0Nvbm5lY3Rvci5qcyJdLCJuYW1lcyI6WyJVUkwiLCJyZXF1aXJlIiwiXyIsIlN1cHBvcnRlZERyaXZlcnMiLCJDb25uZWN0b3IiLCJjcmVhdGVDb25uZWN0b3IiLCJkcml2ZXIiLCJjb25uZWN0aW9uU3RyaW5nIiwib3B0aW9ucyIsImluZGV4T2YiLCJFcnJvciIsIkNvbm5lY3RvckNsYXNzIiwiY29uc3RydWN0b3IiLCJnZXROZXdDb25uZWN0aW9uU3RyaW5nIiwiY29tcG9uZW50cyIsImlzUGxhaW5PYmplY3QiLCJ1cmwiLCJoYXNPd25Qcm9wZXJ0eSIsInVzZXJuYW1lIiwicGFzc3dvcmQiLCJwYXRobmFtZSIsImZvck93biIsInZhbHVlIiwia2V5Iiwic2VhcmNoUGFyYW1zIiwic2V0IiwiaHJlZiIsImdldENvbm5lY3Rpb25TdHJpbmdXaXRob3V0Q3JlZGVudGlhbCIsImRhdGFiYXNlIiwiX2RhdGFiYXNlIiwic3Vic3RyIiwibG9nIiwiYXJncyIsImxvZ2dlciIsIm1lcmdlV2hlcmUiLCJmaWx0ZXJzIiwid2hlcmUiLCJjbG9uZURlZXAiLCIkYW5kIiwibW9kdWxlIiwiZXhwb3J0cyJdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7QUFFQSxNQUFNO0FBQUVBLEVBQUFBO0FBQUYsSUFBVUMsT0FBTyxDQUFDLEtBQUQsQ0FBdkI7O0FBQ0EsTUFBTTtBQUFFQyxFQUFBQTtBQUFGLElBQVFELE9BQU8sQ0FBQyxVQUFELENBQXJCOztBQUNBLE1BQU07QUFBRUUsRUFBQUE7QUFBRixJQUF1QkYsT0FBTyxDQUFDLGVBQUQsQ0FBcEM7O0FBTUEsTUFBTUcsU0FBTixDQUFnQjtBQUNaLFNBQU9DLGVBQVAsQ0FBdUJDLE1BQXZCLEVBQStCQyxnQkFBL0IsRUFBaURDLE9BQWpELEVBQTBEO0FBQ3RELFFBQUlMLGdCQUFnQixDQUFDTSxPQUFqQixDQUF5QkgsTUFBekIsTUFBcUMsQ0FBQyxDQUExQyxFQUE2QztBQUN6QyxZQUFNLElBQUlJLEtBQUosQ0FBVyxrQ0FBaUNKLE1BQU8sSUFBbkQsQ0FBTjtBQUNIOztBQUVELFFBQUksQ0FBQ0MsZ0JBQUwsRUFBdUI7QUFDbkIsWUFBTSxJQUFJRyxLQUFKLENBQVcsb0NBQVgsQ0FBTjtBQUNIOztBQUVELFFBQUlDLGNBQWMsR0FBR1YsT0FBTyxDQUFFLGFBQVlLLE1BQU8sWUFBckIsQ0FBNUI7O0FBRUEsV0FBTyxJQUFJSyxjQUFKLENBQW1CSixnQkFBbkIsRUFBcUNDLE9BQXJDLENBQVA7QUFDSDs7QUFPREksRUFBQUEsV0FBVyxDQUFDTixNQUFELEVBQVNDLGdCQUFULEVBQTJCQyxPQUEzQixFQUFvQztBQUszQyxTQUFLRixNQUFMLEdBQWNBLE1BQWQ7QUFNQSxTQUFLQyxnQkFBTCxHQUF3QkEsZ0JBQXhCO0FBTUEsU0FBS0MsT0FBTCxHQUFlQSxPQUFPLElBQUksRUFBMUI7QUFDSDs7QUFNREssRUFBQUEsc0JBQXNCLENBQUNDLFVBQUQsRUFBYTtBQUFBLFNBQzFCWixDQUFDLENBQUNhLGFBQUYsQ0FBZ0JELFVBQWhCLENBRDBCO0FBQUE7QUFBQTs7QUFHL0IsUUFBSUUsR0FBRyxHQUFHLElBQUloQixHQUFKLENBQVEsS0FBS08sZ0JBQWIsQ0FBVjs7QUFFQSxRQUFJTyxVQUFVLENBQUNHLGNBQVgsQ0FBMEIsVUFBMUIsQ0FBSixFQUEyQztBQUN2Q0QsTUFBQUEsR0FBRyxDQUFDRSxRQUFKLEdBQWVKLFVBQVUsQ0FBQyxVQUFELENBQXpCO0FBQ0g7O0FBRUQsUUFBSUEsVUFBVSxDQUFDRyxjQUFYLENBQTBCLFVBQTFCLENBQUosRUFBMkM7QUFDdkNELE1BQUFBLEdBQUcsQ0FBQ0csUUFBSixHQUFlTCxVQUFVLENBQUMsVUFBRCxDQUF6QjtBQUNIOztBQUVELFFBQUlBLFVBQVUsQ0FBQ0csY0FBWCxDQUEwQixVQUExQixDQUFKLEVBQTJDO0FBQ3ZDRCxNQUFBQSxHQUFHLENBQUNJLFFBQUosR0FBZSxNQUFNTixVQUFVLENBQUMsVUFBRCxDQUEvQjtBQUNIOztBQUVELFFBQUlBLFVBQVUsQ0FBQ0csY0FBWCxDQUEwQixTQUExQixDQUFKLEVBQTBDO0FBQ3RDLFVBQUlULE9BQU8sR0FBR00sVUFBVSxDQUFDTixPQUF6Qjs7QUFFQU4sTUFBQUEsQ0FBQyxDQUFDbUIsTUFBRixDQUFTYixPQUFULEVBQWtCLENBQUNjLEtBQUQsRUFBUUMsR0FBUixLQUFnQjtBQUM5QlAsUUFBQUEsR0FBRyxDQUFDUSxZQUFKLENBQWlCQyxHQUFqQixDQUFxQkYsR0FBckIsRUFBMEIsT0FBT0QsS0FBUCxLQUFpQixTQUFqQixHQUE4QkEsS0FBSyxHQUFHLENBQUgsR0FBTyxDQUExQyxHQUErQ0EsS0FBekU7QUFDSCxPQUZEO0FBR0g7O0FBRUQsV0FBT04sR0FBRyxDQUFDVSxJQUFYO0FBQ0g7O0FBTURDLEVBQUFBLG9DQUFvQyxHQUFHO0FBQ25DLFFBQUlYLEdBQUcsR0FBRyxJQUFJaEIsR0FBSixDQUFRLEtBQUtPLGdCQUFiLENBQVY7QUFFQVMsSUFBQUEsR0FBRyxDQUFDRSxRQUFKLEdBQWUsRUFBZjtBQUNBRixJQUFBQSxHQUFHLENBQUNHLFFBQUosR0FBZSxFQUFmO0FBRUEsV0FBT0gsR0FBRyxDQUFDVSxJQUFYO0FBQ0g7O0FBTUQsTUFBSUUsUUFBSixHQUFlO0FBQ1gsUUFBSSxDQUFDLEtBQUtDLFNBQVYsRUFBcUI7QUFDakIsV0FBS0EsU0FBTCxHQUFrQixJQUFJN0IsR0FBSixDQUFRLEtBQUtPLGdCQUFiLENBQUQsQ0FBaUNhLFFBQWpDLENBQTBDVSxNQUExQyxDQUFpRCxDQUFqRCxDQUFqQjtBQUNIOztBQUVELFdBQU8sS0FBS0QsU0FBWjtBQUNIOztBQU1ERSxFQUFBQSxHQUFHLENBQUMsR0FBR0MsSUFBSixFQUFVO0FBQ1QsUUFBSSxLQUFLeEIsT0FBTCxDQUFheUIsTUFBakIsRUFBeUI7QUFDckIsV0FBS3pCLE9BQUwsQ0FBYXlCLE1BQWIsQ0FBb0JGLEdBQXBCLENBQXdCLEdBQUdDLElBQTNCO0FBQ0g7QUFDSjs7QUFFREUsRUFBQUEsVUFBVSxDQUFDQyxPQUFELEVBQVVDLEtBQVYsRUFBaUI7QUFDdkIsUUFBSSxDQUFDRCxPQUFPLENBQUNDLEtBQWIsRUFBb0I7QUFDaEJELE1BQUFBLE9BQU8sQ0FBQ0MsS0FBUixHQUFnQmxDLENBQUMsQ0FBQ21DLFNBQUYsQ0FBWUQsS0FBWixDQUFoQjtBQUNILEtBRkQsTUFFTztBQUNIRCxNQUFBQSxPQUFPLENBQUNDLEtBQVIsR0FBZ0I7QUFBRUUsUUFBQUEsSUFBSSxFQUFFLENBQUVILE9BQU8sQ0FBQ0MsS0FBVixFQUFpQmxDLENBQUMsQ0FBQ21DLFNBQUYsQ0FBWUQsS0FBWixDQUFqQjtBQUFSLE9BQWhCO0FBQ0g7QUFDSjs7QUFqSFc7O0FBb0loQkcsTUFBTSxDQUFDQyxPQUFQLEdBQWlCcEMsU0FBakIiLCJzb3VyY2VzQ29udGVudCI6WyJcInVzZSBzdHJpY3RcIjtcblxuY29uc3QgeyBVUkwgfSA9IHJlcXVpcmUoJ3VybCcpO1xuY29uc3QgeyBfIH0gPSByZXF1aXJlKCdyay11dGlscycpO1xuY29uc3QgeyBTdXBwb3J0ZWREcml2ZXJzIH0gPSByZXF1aXJlKCcuLi91dGlscy9sYW5nJyk7XG5cbi8qKlxuICogQSBkYXRhYmFzZSBzdG9yYWdlIGNvbm5lY3RvciBvYmplY3QuXG4gKiBAY2xhc3NcbiAqL1xuY2xhc3MgQ29ubmVjdG9yIHtcbiAgICBzdGF0aWMgY3JlYXRlQ29ubmVjdG9yKGRyaXZlciwgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykge1xuICAgICAgICBpZiAoU3VwcG9ydGVkRHJpdmVycy5pbmRleE9mKGRyaXZlcikgPT09IC0xKSB7XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoYFVuc3VwcG9ydGVkIGNvbm5lY3RvciBkcml2ZXI6IFwiJHtkcml2ZXJ9XCIhYCk7XG4gICAgICAgIH1cblxuICAgICAgICBpZiAoIWNvbm5lY3Rpb25TdHJpbmcpIHtcbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcihgTWlzc2luZyByZXF1aXJlZCBjb25uZWN0aW9uIHN0cmluZ2ApO1xuICAgICAgICB9XG5cbiAgICAgICAgbGV0IENvbm5lY3RvckNsYXNzID0gcmVxdWlyZShgLi9kcml2ZXJzLyR7ZHJpdmVyfS9Db25uZWN0b3JgKTtcbiAgICAgICAgXG4gICAgICAgIHJldHVybiBuZXcgQ29ubmVjdG9yQ2xhc3MoY29ubmVjdGlvblN0cmluZywgb3B0aW9ucyk7XG4gICAgfVxuXG4gICAgLyoqICAgICBcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gZHJpdmVyIC0gRGF0YSBzdG9yYWdlIHR5cGVcbiAgICAgKiBAcGFyYW0ge3N0cmluZ30gY29ubmVjdGlvblN0cmluZyAtIFRoZSBjb25uZWN0aW9uIHN0cmluZ1xuICAgICAqIEBwYXJhbSB7b2JqZWN0fSBbb3B0aW9uc10gLSBFeHRyYSBjb25uZWN0b3Igb3B0aW9uc1xuICAgICAqL1xuICAgIGNvbnN0cnVjdG9yKGRyaXZlciwgY29ubmVjdGlvblN0cmluZywgb3B0aW9ucykge1xuICAgICAgICAvKipcbiAgICAgICAgICogVGhlIGRhdGFiYXNlIHN0b3JhZ2UgdHlwZSwgZS5nLiBteXNxbCwgbW9uZ29kYlxuICAgICAgICAgKiBAbWVtYmVyIHtzdHJpbmd9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmRyaXZlciA9IGRyaXZlcjtcblxuICAgICAgICAvKipcbiAgICAgICAgICogVGhlIGRlZmF1bHQgVVJMIHN0eWxlIGNvbm5lY3Rpb24gc3RyaW5nLCBlLmcuIG15c3FsOi8vdXNlcm5hbWU6cGFzc3dvcmRAaG9zdDpwb3J0L2RibmFtZVxuICAgICAgICAgKiBAbWVtYmVyIHtzdHJpbmd9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLmNvbm5lY3Rpb25TdHJpbmcgPSBjb25uZWN0aW9uU3RyaW5nO1xuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBDb25uZWN0b3Igb3B0aW9uc1xuICAgICAgICAgKiBAbWVtYmVyIHtvYmplY3R9XG4gICAgICAgICAqL1xuICAgICAgICB0aGlzLm9wdGlvbnMgPSBvcHRpb25zIHx8IHt9OyAgICAgICAgICBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBVcGRhdGUgY29ubmVjdGlvbiBjb21wb25lbnRzLlxuICAgICAqIEBwYXJhbSB7Kn0gY29tcG9uZW50cyBcbiAgICAgKi9cbiAgICBnZXROZXdDb25uZWN0aW9uU3RyaW5nKGNvbXBvbmVudHMpIHtcbiAgICAgICAgcHJlOiBfLmlzUGxhaW5PYmplY3QoY29tcG9uZW50cyk7XG5cbiAgICAgICAgbGV0IHVybCA9IG5ldyBVUkwodGhpcy5jb25uZWN0aW9uU3RyaW5nKTtcblxuICAgICAgICBpZiAoY29tcG9uZW50cy5oYXNPd25Qcm9wZXJ0eSgndXNlcm5hbWUnKSkge1xuICAgICAgICAgICAgdXJsLnVzZXJuYW1lID0gY29tcG9uZW50c1sndXNlcm5hbWUnXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGlmIChjb21wb25lbnRzLmhhc093blByb3BlcnR5KCdwYXNzd29yZCcpKSB7XG4gICAgICAgICAgICB1cmwucGFzc3dvcmQgPSBjb21wb25lbnRzWydwYXNzd29yZCddO1xuICAgICAgICB9XG5cbiAgICAgICAgaWYgKGNvbXBvbmVudHMuaGFzT3duUHJvcGVydHkoJ2RhdGFiYXNlJykpIHtcbiAgICAgICAgICAgIHVybC5wYXRobmFtZSA9ICcvJyArIGNvbXBvbmVudHNbJ2RhdGFiYXNlJ107XG4gICAgICAgIH0gICAgICAgIFxuXG4gICAgICAgIGlmIChjb21wb25lbnRzLmhhc093blByb3BlcnR5KCdvcHRpb25zJykpIHtcbiAgICAgICAgICAgIGxldCBvcHRpb25zID0gY29tcG9uZW50cy5vcHRpb25zO1xuXG4gICAgICAgICAgICBfLmZvck93bihvcHRpb25zLCAodmFsdWUsIGtleSkgPT4ge1xuICAgICAgICAgICAgICAgIHVybC5zZWFyY2hQYXJhbXMuc2V0KGtleSwgdHlwZW9mIHZhbHVlID09PSAnYm9vbGVhbicgPyAodmFsdWUgPyAxIDogMCkgOiB2YWx1ZSk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIHJldHVybiB1cmwuaHJlZjtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBHZXQgdGhlIGNvbm5lY3Rpb24gd2l0aG91dCBjcmVkZW50aWFsIGluZm9ybWF0aW9uLCB1c3VhbGx5IHVzZWQgZm9yIGRpc3BsYXlpbmcuXG4gICAgICogQHJldHVybnMge3N0cmluZ31cbiAgICAgKi9cbiAgICBnZXRDb25uZWN0aW9uU3RyaW5nV2l0aG91dENyZWRlbnRpYWwoKSB7XG4gICAgICAgIGxldCB1cmwgPSBuZXcgVVJMKHRoaXMuY29ubmVjdGlvblN0cmluZyk7XG4gICAgICAgIFxuICAgICAgICB1cmwudXNlcm5hbWUgPSAnJztcbiAgICAgICAgdXJsLnBhc3N3b3JkID0gJyc7XG5cbiAgICAgICAgcmV0dXJuIHVybC5ocmVmO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIERhdGFiYXNlIG5hbWUuXG4gICAgICogQG1lbWJlciB7c3RyaW5nfVxuICAgICAqL1xuICAgIGdldCBkYXRhYmFzZSgpIHtcbiAgICAgICAgaWYgKCF0aGlzLl9kYXRhYmFzZSkge1xuICAgICAgICAgICAgdGhpcy5fZGF0YWJhc2UgPSAobmV3IFVSTCh0aGlzLmNvbm5lY3Rpb25TdHJpbmcpKS5wYXRobmFtZS5zdWJzdHIoMSk7XG4gICAgICAgIH1cblxuICAgICAgICByZXR1cm4gdGhpcy5fZGF0YWJhc2U7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogV3JpdGUgbG9nLlxuICAgICAqIEBwYXJhbSAgey4uLmFueX0gYXJncyBcbiAgICAgKi9cbiAgICBsb2coLi4uYXJncykge1xuICAgICAgICBpZiAodGhpcy5vcHRpb25zLmxvZ2dlcikge1xuICAgICAgICAgICAgdGhpcy5vcHRpb25zLmxvZ2dlci5sb2coLi4uYXJncyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBtZXJnZVdoZXJlKGZpbHRlcnMsIHdoZXJlKSB7XG4gICAgICAgIGlmICghZmlsdGVycy53aGVyZSkge1xuICAgICAgICAgICAgZmlsdGVycy53aGVyZSA9IF8uY2xvbmVEZWVwKHdoZXJlKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgIGZpbHRlcnMud2hlcmUgPSB7ICRhbmQ6IFsgZmlsdGVycy53aGVyZSwgXy5jbG9uZURlZXAod2hlcmUpIF0gfTtcbiAgICAgICAgfSBcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBMb2cgcXVlcnkuXG4gICAgICovXG5cbiAgICAvKlxuICAgIGFzeW5jIGNvbm5lY3RfKCkge31cblxuICAgIGFzeW5jIGRpc2Nvbm5lY3RfKCkge31cblxuICAgIGFzeW5jIHBpbmdfKCkge31cblxuICAgIGFzeW5jIGV4ZWN1dGVfKCkge31cblxuICAgIGFzeW5jIGVuZF8oKSB7fVxuICAgICovXG59XG5cbm1vZHVsZS5leHBvcnRzID0gQ29ubmVjdG9yOyJdfQ==